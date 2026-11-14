package com.stormitron.stormcast.server;

import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.os.Build;
import android.os.IBinder;
import android.view.Surface;

import java.io.Closeable;
import java.lang.reflect.Method;

/**
 * Mirrors the main display into a surface. Android has no public API for this from the shell
 * user, so this is the one class that uses hidden APIs, by reflection:
 * <ul>
 * <li>newer Android: the static DisplayManager.createVirtualDisplay(name, width, height,
 * displayIdToMirror, surface), made for callers without an app context;</li>
 * <li>older Android: a SurfaceControl display that shows the main display's layer stack.</li>
 * </ul>
 */
final class DisplayCapture {
    private static final int MAIN_DISPLAY = 0;
    private static final String NAME = "stormcast";

    /** The main display's size (already rotated), rotation and layer stack. */
    static final class Info {
        final int width;
        final int height;
        final int rotation;
        final int layerStack;

        Info(int width, int height, int rotation, int layerStack) {
            this.width = width;
            this.height = height;
            this.rotation = rotation;
            this.layerStack = layerStack;
        }

        boolean sameGeometry(Info other) {
            return width == other.width && height == other.height && rotation == other.rotation;
        }

        @Override
        public String toString() {
            return width + "x" + height + ", rotation " + rotation;
        }
    }

    private static Object displayManagerGlobal;
    private static Method getDisplayInfo;

    private DisplayCapture() {
    }

    static synchronized Info readInfo() throws StreamerException {
        try {
            if (getDisplayInfo == null) {
                Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
                displayManagerGlobal = global.getMethod("getInstance").invoke(null);
                getDisplayInfo = global.getMethod("getDisplayInfo", int.class);
            }
            Object info = getDisplayInfo.invoke(displayManagerGlobal, MAIN_DISPLAY);
            if (info == null) {
                throw new StreamerException("display_unavailable", "The main display was not found", null);
            }
            Class<?> type = info.getClass();
            return new Info(type.getDeclaredField("logicalWidth").getInt(info),
                    type.getDeclaredField("logicalHeight").getInt(info),
                    type.getDeclaredField("rotation").getInt(info),
                    type.getDeclaredField("layerStack").getInt(info));
        } catch (ReflectiveOperationException | RuntimeException e) {
            throw new StreamerException("display_unavailable", "Could not read the display: " + e, e);
        }
    }

    /** Starts mirroring the main display into the surface, scaled to width x height. */
    static Closeable mirror(Info info, int width, int height, Surface surface) throws StreamerException {
        Exception displayManagerError;
        try {
            Method create = DisplayManager.class.getMethod("createVirtualDisplay",
                    String.class, int.class, int.class, int.class, Surface.class);
            final VirtualDisplay display = (VirtualDisplay) create.invoke(null, NAME, width, height, MAIN_DISPLAY, surface);
            if (display != null) {
                Ln.i("Capture: DisplayManager mirror");
                return display::release;
            }
            displayManagerError = new IllegalStateException("createVirtualDisplay returned null");
        } catch (ReflectiveOperationException | RuntimeException e) {
            displayManagerError = e;
        }
        try {
            return surfaceControlMirror(info, width, height, surface);
        } catch (ReflectiveOperationException | RuntimeException e) {
            throw new StreamerException("display_unavailable", "Could not mirror the display. DisplayManager: "
                    + displayManagerError + ". SurfaceControl: " + e, e);
        }
    }

    private static Closeable surfaceControlMirror(Info info, int width, int height, Surface surface)
            throws ReflectiveOperationException {
        final Class<?> control = Class.forName("android.view.SurfaceControl");
        // The shell user can only create secure displays before Android 12.
        boolean secure = Build.VERSION.SDK_INT < 31;
        final IBinder token = (IBinder) control.getMethod("createDisplay", String.class, boolean.class)
                .invoke(null, NAME, secure);
        control.getMethod("openTransaction").invoke(null);
        try {
            control.getMethod("setDisplaySurface", IBinder.class, Surface.class).invoke(null, token, surface);
            control.getMethod("setDisplayProjection", IBinder.class, int.class, Rect.class, Rect.class)
                    .invoke(null, token, 0, new Rect(0, 0, info.width, info.height), new Rect(0, 0, width, height));
            control.getMethod("setDisplayLayerStack", IBinder.class, int.class).invoke(null, token, info.layerStack);
        } finally {
            control.getMethod("closeTransaction").invoke(null);
        }
        Ln.i("Capture: SurfaceControl mirror");
        return new Closeable() {
            @Override
            public void close() {
                try {
                    control.getMethod("destroyDisplay", IBinder.class).invoke(null, token);
                } catch (ReflectiveOperationException e) {
                    Ln.w("Could not destroy the display: " + e);
                }
            }
        };
    }
}
