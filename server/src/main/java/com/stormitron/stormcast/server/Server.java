package com.stormitron.stormcast.server;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Build;
import android.os.Looper;

import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Stormcast's phone-side server. The Windows app copies this jar to the device and starts it
 * with app_process, so it runs with the rights of the adb shell user:
 *
 * <pre>
 * CLASSPATH=/data/local/tmp/stormcast-server.jar app_process / \
 *     com.stormitron.stormcast.server.Server 2 socket=stormcast_0123abcd
 * </pre>
 *
 * It connects to the app through the adb reverse tunnel, streams the screen as H.264 and
 * injects the app's input, with the protocol in docs/PROTOCOL.md.
 */
public final class Server {
    public static final String VERSION = "0.1.0";

    private Server() {
    }

    public static void main(String... args) {
        System.exit(run(args));
    }

    private static int run(String[] args) {
        Ln.i("Stormcast server " + VERSION + " on Android " + Build.VERSION.RELEASE
                + " (API " + Build.VERSION.SDK_INT + ")");
        Options options;
        try {
            options = Options.parse(args);
        } catch (IllegalArgumentException e) {
            Ln.e(e.getMessage());
            return 2;
        }
        deleteOwnJar();
        prepareMainLooper();

        LocalSocket socket = new LocalSocket();
        try {
            socket.connect(new LocalSocketAddress(options.socketName));
        } catch (IOException e) {
            Ln.e("Could not connect to the app: " + e.getMessage());
            closeQuietly(socket);
            return 1;
        }
        try {
            MessageWriter writer = new MessageWriter(new BufferedOutputStream(socket.getOutputStream(), 1 << 16));
            writer.writePreamble();
            writer.writeHello(deviceName(), "h264", VERSION, Build.VERSION.RELEASE, Build.VERSION.SDK_INT);
            writer.flush();
            AtomicReference<Geometry> geometry = new AtomicReference<>();
            Controller.start(socket.getInputStream(), geometry);
            try {
                new ScreenStreamer(options, writer, geometry).run();
                return 0;
            } catch (StreamerException e) {
                Ln.e(e.code + ": " + e.getMessage());
                writer.writeError(e.code, e.getMessage());
                writer.flush();
                return 1;
            } catch (RuntimeException e) {
                Ln.e("Unexpected error: " + e);
                writer.writeError("server_error", e.toString());
                writer.flush();
                return 1;
            }
        } catch (IOException e) {
            // The app closed the connection, which is the normal way to stop.
            Ln.i("Connection closed");
            return 0;
        } finally {
            closeQuietly(socket);
        }
    }

    /** "Lenovo TB311FU": the manufacturer in title case, unless the model already starts with it. */
    static String deviceName() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "Android device" : Build.MODEL.trim();
        if (manufacturer.isEmpty()
                || model.toLowerCase(Locale.ROOT).startsWith(manufacturer.toLowerCase(Locale.ROOT))) {
            return model;
        }
        return manufacturer.substring(0, 1).toUpperCase(Locale.ROOT)
                + manufacturer.substring(1).toLowerCase(Locale.ROOT) + " " + model;
    }

    /** The jar deletes itself at once. The running process keeps it open, so nothing is left behind. */
    private static void deleteOwnJar() {
        String path = System.getenv("CLASSPATH");
        if (path != null && path.startsWith("/data/local/tmp/") && path.endsWith(".jar")
                && !new File(path).delete()) {
            Ln.w("Could not delete " + path);
        }
    }

    /** Some framework classes expect a main looper, which app_process does not create. */
    @SuppressWarnings("deprecation")
    private static void prepareMainLooper() {
        try {
            Looper.prepareMainLooper();
        } catch (IllegalStateException e) {
            // Already prepared.
        }
    }

    private static void closeQuietly(Closeable closeable) {
        try {
            closeable.close();
        } catch (IOException e) {
            // Nothing left to do.
        }
    }
}
