package com.stormitron.stormcast.server;

/** Video size calculations. Plain Java: tested on the JVM. */
final class VideoSize {
    private VideoSize() {
    }

    /**
     * Scales width x height so the long side is at most maxSize (0 means no limit), keeping the
     * aspect ratio. Both sides are rounded down to a multiple of 8, which encoders expect.
     */
    static int[] fit(int width, int height, int maxSize) {
        int w = width;
        int h = height;
        if (maxSize > 0 && Math.max(w, h) > maxSize) {
            if (w >= h) {
                h = Math.round((float) h * maxSize / w);
                w = maxSize;
            } else {
                w = Math.round((float) w * maxSize / h);
                h = maxSize;
            }
        }
        return new int[] {w & ~7, h & ~7};
    }

    /** The largest of the descending fallbacks below current, or 0 when there is none. */
    static int nextFallback(int[] fallbacks, int current) {
        for (int size : fallbacks) {
            if (size < current) {
                return size;
            }
        }
        return 0;
    }
}
