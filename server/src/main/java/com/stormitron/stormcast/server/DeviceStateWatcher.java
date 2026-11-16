package com.stormitron.stormcast.server;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Tells the app whether the screen is on and the device locked (B-012). The mirror shows a secure
 * lock screen as black, so the app needs this to offer its own code entry. Polls a few times a
 * second and sends the state when it changes. When the device does not tell, it stops, and the app
 * shows no unlock prompt.
 */
final class DeviceStateWatcher implements Runnable {
    static final int UNKNOWN = -1;
    private static final long INTERVAL_MS = 300;

    private final InputInjector injector;
    private final MessageWriter writer;
    private final AtomicInteger state = new AtomicInteger(UNKNOWN);

    private DeviceStateWatcher(InputInjector injector, MessageWriter writer) {
        this.injector = injector;
        this.writer = writer;
    }

    static DeviceStateWatcher start(InputInjector injector, MessageWriter writer) {
        DeviceStateWatcher watcher = new DeviceStateWatcher(injector, writer);
        Thread thread = new Thread(watcher, "stormcast-device-state");
        thread.setDaemon(true);
        thread.start();
        return watcher;
    }

    /** Whether the device is locked now, as far as it is known. */
    boolean isLocked() {
        int flags = state.get();
        return flags != UNKNOWN && (flags & Protocol.STATE_LOCKED) != 0;
    }

    @Override
    public void run() {
        try {
            while (true) {
                int flags = injector.deviceState();
                if (flags == UNKNOWN) {
                    state.set(UNKNOWN);
                    Ln.w("The device does not tell whether it is locked; the app shows no unlock prompt");
                    return;
                }
                if (state.getAndSet(flags) != flags) {
                    Ln.i("Device state: " + Protocol.describeState(flags));
                    writer.writeDeviceState(flags);
                    writer.flush();
                }
                Thread.sleep(INTERVAL_MS);
            }
        } catch (IOException | InterruptedException e) {
            // The connection closed; the streamer stops the server.
        }
    }
}
