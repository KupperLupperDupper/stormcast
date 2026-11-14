package com.stormitron.stormcast.server;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Build;
import android.view.Surface;

import java.io.Closeable;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Encodes the mirrored screen with the device's H.264 encoder and writes it to the app. When
 * the display rotates or changes size, the session ends and a new one starts at the new size.
 */
final class ScreenStreamer {
    private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;
    private static final int I_FRAME_INTERVAL_S = 10;
    /** Repeat the last frame while the screen is still, so the app keeps getting frames. */
    private static final long REPEAT_FRAME_AFTER_US = 100_000;
    private static final int MONITOR_INTERVAL_MS = 300;
    /** Smaller sizes to try when the encoder refuses the full size. */
    private static final int[] FALLBACK_MAX_SIZES = {1920, 1600, 1280, 1024, 800};

    private final Options options;
    private final MessageWriter writer;
    private final AtomicBoolean restartRequested = new AtomicBoolean();
    private volatile MediaCodec activeCodec;
    private volatile DisplayCapture.Info sessionInfo;

    ScreenStreamer(Options options, MessageWriter writer) {
        this.options = options;
        this.writer = writer;
    }

    /** Streams until the app closes the connection (IOException) or capture fails. */
    void run() throws IOException, StreamerException {
        Thread monitor = startMonitor();
        try {
            int maxSize = options.maxSize;
            while (true) {
                DisplayCapture.Info info = DisplayCapture.readInfo();
                int[] size = VideoSize.fit(info.width, info.height, maxSize);
                Session session;
                try {
                    session = start(info, size[0], size[1]);
                } catch (RuntimeException e) {
                    // Some encoders refuse large sizes; try a smaller one.
                    int smaller = VideoSize.nextFallback(FALLBACK_MAX_SIZES, Math.max(size[0], size[1]));
                    if (smaller == 0) {
                        throw new StreamerException("encoder_failed",
                                "The H.264 encoder refused " + size[0] + "x" + size[1] + ": " + e, e);
                    }
                    Ln.w("The encoder refused " + size[0] + "x" + size[1] + "; trying " + smaller + " px");
                    maxSize = smaller;
                    continue;
                }
                Ln.i("Session: display " + info + ", video " + size[0] + "x" + size[1]);
                restartRequested.set(false);
                sessionInfo = info;
                activeCodec = session.codec;
                try {
                    writer.writeSession(size[0], size[1], info.rotation);
                    writer.flush();
                    drain(session.codec);
                } catch (IllegalStateException e) {
                    throw new StreamerException("encoder_failed", "The encoder stopped: " + e, e);
                } finally {
                    activeCodec = null;
                    session.release();
                }
                if (!restartRequested.get()) {
                    return;
                }
            }
        } finally {
            monitor.interrupt();
        }
    }

    private Session start(DisplayCapture.Info info, int width, int height) throws StreamerException {
        MediaCodec codec;
        try {
            codec = MediaCodec.createEncoderByType(MIME);
        } catch (IOException | IllegalArgumentException e) {
            throw new StreamerException("encoder_failed", "No H.264 encoder: " + e, e);
        }
        Surface surface = null;
        Closeable mirror = null;
        try {
            codec.configure(format(width, height), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            surface = codec.createInputSurface();
            mirror = DisplayCapture.mirror(info, width, height, surface);
            codec.start();
            return new Session(codec, surface, mirror);
        } catch (RuntimeException | StreamerException e) {
            release(codec, surface, mirror);
            throw e;
        }
    }

    private MediaFormat format(int width, int height) {
        MediaFormat format = MediaFormat.createVideoFormat(MIME, width, height);
        format.setInteger(MediaFormat.KEY_BIT_RATE, options.bitRate);
        // Required by MediaCodec. With a surface as input, the real rate follows the screen.
        format.setInteger(MediaFormat.KEY_FRAME_RATE, 60);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, I_FRAME_INTERVAL_S);
        // No B-frames: frames come out in display order, so the app can show each one at once.
        // The app tells its decoder so by rewriting the SPS (src-tauri/src/h264.rs).
        format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, REPEAT_FRAME_AFTER_US);
        format.setInteger(MediaFormat.KEY_PRIORITY, 0); // real time
        format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);
        if (Build.VERSION.SDK_INT >= 30) {
            format.setInteger(MediaFormat.KEY_LATENCY, 1);
        }
        if (options.maxFps > 0) {
            format.setFloat("max-fps-to-encoder", options.maxFps);
        }
        return format;
    }

    /** Writes encoder output until the end of the stream, which a restart request causes. */
    private void drain(MediaCodec codec) throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        byte[] buffer = new byte[64 * 1024];
        while (true) {
            int index = codec.dequeueOutputBuffer(info, -1);
            if (index < 0) {
                continue; // format changed, or nothing yet
            }
            try {
                ByteBuffer data = codec.getOutputBuffer(index);
                if (data != null && info.size > 0) {
                    if (buffer.length < info.size) {
                        buffer = new byte[info.size];
                    }
                    data.position(info.offset);
                    data.limit(info.offset + info.size);
                    data.get(buffer, 0, info.size);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        writer.writeConfig(buffer, 0, info.size);
                    } else {
                        boolean keyFrame = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                        writer.writeFrame(keyFrame, info.presentationTimeUs, buffer, 0, info.size);
                    }
                    writer.flush();
                }
            } finally {
                codec.releaseOutputBuffer(index, false);
            }
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                return;
            }
        }
    }

    /** Watches the display and ends the session when its size or rotation changes. */
    private Thread startMonitor() {
        Thread thread = new Thread(() -> {
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    Thread.sleep(MONITOR_INTERVAL_MS);
                    MediaCodec codec = activeCodec;
                    DisplayCapture.Info current = sessionInfo;
                    if (codec == null || current == null) {
                        continue;
                    }
                    DisplayCapture.Info now = DisplayCapture.readInfo();
                    if (!now.sameGeometry(current) && restartRequested.compareAndSet(false, true)) {
                        Ln.i("Display changed to " + now + "; starting a new session");
                        try {
                            codec.signalEndOfInputStream();
                        } catch (IllegalStateException e) {
                            // The session already ended.
                        }
                    }
                }
            } catch (InterruptedException e) {
                // Streaming stopped.
            } catch (StreamerException e) {
                Ln.w("Display monitor stopped: " + e.getMessage());
            }
        }, "stormcast-display-monitor");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private static void release(MediaCodec codec, Surface surface, Closeable mirror) {
        if (mirror != null) {
            try {
                mirror.close();
            } catch (IOException | RuntimeException e) {
                Ln.w("Could not stop mirroring: " + e);
            }
        }
        try {
            codec.stop();
        } catch (IllegalStateException e) {
            // Never started.
        }
        codec.release();
        if (surface != null) {
            surface.release();
        }
    }

    private static final class Session {
        final MediaCodec codec;
        final Surface surface;
        final Closeable mirror;

        Session(MediaCodec codec, Surface surface, Closeable mirror) {
            this.codec = codec;
            this.surface = surface;
            this.mirror = mirror;
        }

        void release() {
            ScreenStreamer.release(codec, surface, mirror);
        }
    }
}
