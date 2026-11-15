package com.stormitron.stormcast.server;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTimestamp;
import android.media.AudioTrack;

import java.io.IOException;

/**
 * Streams what the device plays to the app while the app wants it (docs/PROTOCOL.md, audio). Runs
 * on its own thread; the control thread turns it on and off. While it captures, the device plays
 * no sound itself, so turning it off gives the sound back to the device.
 */
final class AudioStreamer implements Runnable {
    /** Blocks averaged for the log line that tells how long capture takes on the device. */
    private static final int DELAY_BLOCKS = 200;
    private static final long TONE_DELAY_MS = 1000;
    private static final int TONE_MS = 600;
    private static final int TONE_FADE_MS = 10;
    private static final double TONE_HZ = 440;
    private static final double TONE_LEVEL = 0.5;

    private final MessageWriter writer;
    private final boolean testTone;
    /** Guarded by this. */
    private boolean wanted;
    /** The running capture, guarded by this. */
    private AudioRecord recorder;
    private boolean tonePlayed;

    private AudioStreamer(MessageWriter writer, boolean wanted, boolean testTone) {
        this.writer = writer;
        this.wanted = wanted;
        this.testTone = testTone;
    }

    static AudioStreamer start(MessageWriter writer, boolean on, boolean testTone) {
        AudioStreamer streamer = new AudioStreamer(writer, on, testTone);
        Thread thread = new Thread(streamer, "stormcast-audio");
        thread.setDaemon(true);
        thread.start();
        return streamer;
    }

    /** Starts or stops capture. Stopping wakes a read that waits for the device. */
    synchronized void setEnabled(boolean on) {
        if (wanted == on) {
            return;
        }
        wanted = on;
        Ln.i("Audio: turned " + (on ? "on" : "off") + " by the app");
        if (!on && recorder != null) {
            try {
                recorder.stop();
            } catch (IllegalStateException e) {
                // It already stopped.
            }
        }
        notifyAll();
    }

    @Override
    public void run() {
        try {
            while (true) {
                waitUntilWanted(true);
                int reason = capture();
                writer.writeAudioOff(reason);
                writer.flush();
                if (reason != Protocol.AUDIO_OFF_STOPPED) {
                    // Off until the app turns it off; turning it on again tries again.
                    waitUntilWanted(false);
                }
            }
        } catch (IOException e) {
            // The connection closed; the screen streamer stops the server.
        } catch (InterruptedException e) {
            // The server is stopping.
        }
    }

    private synchronized void waitUntilWanted(boolean on) throws InterruptedException {
        while (wanted != on) {
            wait();
        }
    }

    private synchronized boolean isWanted() {
        return wanted;
    }

    /** Captures until the app turns audio off or capture fails, and returns why it ended. */
    private int capture() throws IOException {
        if (!AudioCapture.isSupported()) {
            Ln.w("Audio: not supported before Android 12");
            return Protocol.AUDIO_OFF_UNSUPPORTED;
        }
        AudioRecord record;
        try {
            record = AudioCapture.open();
        } catch (RuntimeException e) {
            Ln.w("Audio: the device did not allow capture: " + e);
            return Protocol.AUDIO_OFF_REFUSED;
        }
        synchronized (this) {
            if (!wanted) {
                record.release();
                return Protocol.AUDIO_OFF_STOPPED;
            }
            recorder = record;
        }
        try {
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                Ln.w("Audio: capture did not start");
                return Protocol.AUDIO_OFF_REFUSED;
            }
            writer.writeAudioConfig(Protocol.AUDIO_CODEC_PCM_S16LE, AudioCapture.SAMPLE_RATE, AudioCapture.CHANNELS);
            writer.flush();
            Ln.i("Audio: capturing " + AudioCapture.SAMPLE_RATE + " Hz, " + AudioCapture.CHANNELS + " channels");
            if (testTone && !tonePlayed) {
                tonePlayed = true;
                playTestToneSoon();
            }
            return stream(record);
        } catch (IllegalStateException e) {
            Ln.w("Audio: capture failed: " + e);
            return Protocol.AUDIO_OFF_FAILED;
        } finally {
            synchronized (this) {
                recorder = null;
            }
            record.release();
        }
    }

    private int stream(AudioRecord record) throws IOException {
        byte[] buffer = new byte[AudioCapture.READ_BYTES];
        AudioTiming timing = new AudioTiming(AudioCapture.SAMPLE_RATE);
        AudioTimestamp stamp = new AudioTimestamp();
        long delaySumUs = 0;
        int blocks = 0;
        while (isWanted()) {
            int read = record.read(buffer, 0, buffer.length);
            if (read < 0) {
                if (!isWanted()) {
                    break;
                }
                Ln.w("Audio: reading failed with " + read);
                return Protocol.AUDIO_OFF_FAILED;
            }
            int frames = read / AudioCapture.FRAME_BYTES;
            if (frames == 0) {
                continue; // Woken by stop, or nothing yet.
            }
            boolean stamped = record.getTimestamp(stamp, AudioTimestamp.TIMEBASE_MONOTONIC) == AudioRecord.SUCCESS;
            long nowUs = System.nanoTime() / 1000;
            long pts = timing.next(frames, stamped ? stamp.framePosition : 0,
                    stamped ? stamp.nanoTime : AudioTiming.NO_TIMESTAMP, nowUs);
            writer.writeAudio(pts, buffer, 0, frames * AudioCapture.FRAME_BYTES);
            writer.flush();
            if (blocks < DELAY_BLOCKS) {
                delaySumUs += nowUs - pts;
                if (++blocks == DELAY_BLOCKS) {
                    Ln.i("Audio: a block reaches the app " + delaySumUs / DELAY_BLOCKS / 1000
                            + " ms after its first frame was captured (average)");
                }
            }
        }
        return Protocol.AUDIO_OFF_STOPPED;
    }

    /** For the smoke test: a short tone the app can hear, played as media on the device. */
    private static void playTestToneSoon() {
        Thread thread = new Thread(() -> {
            try {
                Thread.sleep(TONE_DELAY_MS);
                playTone();
            } catch (InterruptedException e) {
                // The server is stopping.
            } catch (RuntimeException e) {
                Ln.w("Audio: could not play the test tone: " + e);
            }
        }, "stormcast-test-tone");
        thread.setDaemon(true);
        thread.start();
    }

    private static void playTone() throws InterruptedException {
        int rate = AudioCapture.SAMPLE_RATE;
        int frames = rate * TONE_MS / 1000;
        int fade = rate * TONE_FADE_MS / 1000;
        short[] samples = new short[frames];
        for (int i = 0; i < frames; i++) {
            double envelope = Math.min(1, Math.min(i, frames - 1 - i) / (double) fade);
            samples[i] = (short) (Math.sin(2 * Math.PI * TONE_HZ * i / rate) * TONE_LEVEL * envelope * Short.MAX_VALUE);
        }
        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build())
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(frames * 2)
                .build();
        try {
            track.write(samples, 0, frames);
            track.play();
            // On the clock of the PTS, so the log shows when the tone reached the capture.
            Ln.i("Audio: test tone of " + (int) TONE_HZ + " Hz started at PTS " + System.nanoTime() / 1000);
            Thread.sleep(TONE_MS + 200);
        } finally {
            track.release();
        }
    }
}
