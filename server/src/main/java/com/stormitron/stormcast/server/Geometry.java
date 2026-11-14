package com.stormitron.stormcast.server;

/**
 * A capture session's video size and the size of the display it shows, to map a pixel on the
 * video to the display. Both are rotated the same way, so only the scale differs. Plain Java:
 * tested on the JVM.
 */
final class Geometry {
    final int videoWidth;
    final int videoHeight;
    final int displayWidth;
    final int displayHeight;

    Geometry(int videoWidth, int videoHeight, int displayWidth, int displayHeight) {
        this.videoWidth = videoWidth;
        this.videoHeight = videoHeight;
        this.displayWidth = displayWidth;
        this.displayHeight = displayHeight;
    }

    /** Whether a position on a video of this size belongs to this session. */
    boolean matches(int width, int height) {
        return width == videoWidth && height == videoHeight;
    }

    /** The display x of the middle of video pixel x. */
    float displayX(int x) {
        return (x + 0.5f) * displayWidth / videoWidth;
    }

    float displayY(int y) {
        return (y + 0.5f) * displayHeight / videoHeight;
    }
}
