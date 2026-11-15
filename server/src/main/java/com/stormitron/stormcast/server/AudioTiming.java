package com.stormitron.stormcast.server;

/**
 * The presentation time of each block of captured audio, in microseconds on the device's monotonic
 * clock, which the video frames' PTS use too, so the app can keep sound and picture in step.
 *
 * <p>AudioRecord's timestamp says when a frame was captured, the way Android's own AudioSource
 * uses it, but on the remote submix it jumps by a block or more when playback starts or stops,
 * while the blocks themselves come evenly. So the PTS count frames from the previous block and are
 * pulled slowly towards the timestamps, which also follows a drift between the audio clock and the
 * monotonic clock. A timestamp far from the count means capture paused, and the PTS jump to it.
 * Without a timestamp, the block counts as just captured. The PTS always increase. Plain Java:
 * tested on the JVM.
 */
final class AudioTiming {
    /** The block has no timestamp. */
    static final long NO_TIMESTAMP = -1;
    /** Further from the count than this, a timestamp means a pause. */
    static final long RESYNC_US = 100_000;
    /** Each block moves the PTS this fraction of the way to the timestamp. */
    private static final int SMOOTHING = 16;

    private final int sampleRate;
    /** Frames before the current block. */
    private long framesRead;
    private long nextUs = NO_TIMESTAMP;
    private long lastUs = NO_TIMESTAMP;

    AudioTiming(int sampleRate) {
        this.sampleRate = sampleRate;
    }

    /**
     * The PTS of the block of frames just read. AudioRecord's timestamp after the read says that
     * frame stampFrame of the stream was captured at stampNanos; stampNanos is NO_TIMESTAMP when
     * there is none. nowUs is the monotonic clock when the read returned.
     */
    long next(int frames, long stampFrame, long stampNanos, long nowUs) {
        long measured = stampNanos != NO_TIMESTAMP
                ? stampNanos / 1000 - (stampFrame - framesRead) * 1_000_000 / sampleRate
                : nowUs - duration(frames);
        long pts;
        if (nextUs == NO_TIMESTAMP || Math.abs(measured - nextUs) > RESYNC_US) {
            pts = measured;
        } else {
            pts = nextUs + (measured - nextUs) / SMOOTHING;
        }
        if (lastUs != NO_TIMESTAMP && pts <= lastUs) {
            pts = lastUs + 1;
        }
        lastUs = pts;
        framesRead += frames;
        nextUs = pts + duration(frames);
        return pts;
    }

    private long duration(long frames) {
        return frames * 1_000_000 / sampleRate;
    }
}
