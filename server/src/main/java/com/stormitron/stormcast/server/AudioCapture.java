package com.stormitron.stormcast.server;

import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Process;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Captures what the device plays (REMOTE_SUBMIX) as 48 kHz stereo 16-bit PCM. The shell user may
 * capture the device's output, but AudioRecord checks that right for a package, and a program
 * started with app_process has none. So this class, like DisplayCapture and InputInjector, uses
 * hidden APIs by reflection, with a fallback:
 * <ul>
 * <li>a Context that says it is the shell's package, com.android.shell, on a system context from a
 * private ActivityThread, given to AudioRecord.Builder.setContext;</li>
 * <li>the fallback: AudioRecord's own identity for programs without a package.</li>
 * </ul>
 * While capture runs, the device plays no sound itself. Android 11 and older are not supported:
 * there the shell may only capture while one of its activities is in the foreground.
 */
final class AudioCapture {
    static final int SAMPLE_RATE = 48000;
    static final int CHANNELS = 2;
    static final int FRAME_BYTES = CHANNELS * 2;
    /** The device captures in blocks of 1024 frames; reading less does not lower the latency. */
    static final int READ_BYTES = 1024 * FRAME_BYTES;
    private static final int MIN_SDK = 31;
    private static final int CHANNEL_MASK = AudioFormat.CHANNEL_IN_STEREO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;
    private static final String SHELL_PACKAGE = "com.android.shell";

    private static Context shellContext;

    private AudioCapture() {
    }

    static boolean isSupported() {
        return Build.VERSION.SDK_INT >= MIN_SDK;
    }

    /** An AudioRecord for what the device plays, not started yet. */
    static AudioRecord open() {
        RuntimeException shellError;
        try {
            AudioRecord record = build(shellContext());
            Ln.i("Audio: capture as " + SHELL_PACKAGE);
            return record;
        } catch (RuntimeException e) {
            shellError = e;
        }
        try {
            AudioRecord record = build(null);
            Ln.i("Audio: capture without a package (" + SHELL_PACKAGE + " failed: " + shellError + ")");
            return record;
        } catch (RuntimeException e) {
            throw new IllegalStateException("As " + SHELL_PACKAGE + ": " + shellError + ". Without a package: " + e, e);
        }
    }

    private static AudioRecord build(Context context) {
        AudioRecord.Builder builder = new AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.REMOTE_SUBMIX)
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(ENCODING)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(CHANNEL_MASK)
                        .build());
        int minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_MASK, ENCODING);
        if (minBufferSize > 0) {
            // Room for hiccups. It adds no latency: a read returns as soon as a block is there.
            builder.setBufferSizeInBytes(8 * minBufferSize);
        }
        if (context != null) {
            builder.setContext(context);
        }
        AudioRecord record = builder.build();
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            record.release();
            throw new IllegalStateException("AudioRecord did not initialize");
        }
        return record;
    }

    private static synchronized Context shellContext() {
        if (shellContext == null) {
            shellContext = new ShellContext(systemContext());
        }
        return shellContext;
    }

    /**
     * A system context from a private ActivityThread, which is not made the process's current one,
     * so nothing else in the server changes. Null when it cannot be made; ShellContext then answers
     * what AudioRecord asks by itself.
     */
    private static Context systemContext() {
        try {
            Class<?> type = Class.forName("android.app.ActivityThread");
            Constructor<?> constructor = type.getDeclaredConstructor();
            constructor.setAccessible(true);
            Method getSystemContext = type.getDeclaredMethod("getSystemContext");
            getSystemContext.setAccessible(true);
            return (Context) getSystemContext.invoke(constructor.newInstance());
        } catch (ReflectiveOperationException | RuntimeException e) {
            Throwable cause = e instanceof InvocationTargetException ? e.getCause() : e;
            Ln.i("Audio: the shell context stands alone, without a system context: " + cause);
            return null;
        }
    }

    /** Says it is the shell's package, which belongs to the shell user the server runs as. */
    private static final class ShellContext extends ContextWrapper {
        ShellContext(Context base) {
            super(base);
        }

        @Override
        public String getPackageName() {
            return SHELL_PACKAGE;
        }

        @Override
        public String getOpPackageName() {
            return SHELL_PACKAGE;
        }

        @Override
        public AttributionSource getAttributionSource() {
            return new AttributionSource.Builder(Process.myUid()).setPackageName(SHELL_PACKAGE).build();
        }

        /** Context.getDeviceId (Android 14): the device itself, not a virtual device. */
        public int getDeviceId() {
            return 0;
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }
    }
}
