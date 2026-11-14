package com.stormitron.stormcast.server;

import android.content.ClipData;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.PersistableBundle;
import android.os.RemoteException;
import android.view.InputEvent;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Arrays;

/**
 * Injects input events and reads and writes the clipboard. Android has no public API for either
 * from the shell user, so this class, like DisplayCapture, uses hidden APIs by reflection:
 * <ul>
 * <li>Android 14 and later: InputManagerGlobal.getInstance().injectInputEvent(event, mode);</li>
 * <li>older Android, and the fallback: the same method on InputManager.getInstance();</li>
 * <li>the clipboard: the IClipboard service, whose parameters differ between versions.</li>
 * </ul>
 */
final class InputInjector {
    private static final int MODE_ASYNC = 0;
    private static final int MODE_WAIT_FOR_FINISH = 2;
    private static final long WARNING_INTERVAL_MS = 5000;
    private static final String SHELL_PACKAGE = "com.android.shell";
    /** SystemUI shows no clipboard preview for a clip from the shell with this extra. */
    private static final String EXTRA_SUPPRESS_OVERLAY = "com.android.systemui.SUPPRESS_CLIPBOARD_OVERLAY";
    private static final String LISTENER = "android.content.IOnPrimaryClipChangedListener";

    private final Object manager;
    private final Method injectInputEvent;
    private Object clipboard;
    private Method setPrimaryClip;
    private Method getPrimaryClip;
    /** The text setClipboard put there last, so the watcher does not send it back. */
    private volatile String ownClip;
    private long lastWarning;

    private InputInjector(Object manager, Method injectInputEvent) {
        this.manager = manager;
        this.injectInputEvent = injectInputEvent;
    }

    static InputInjector create() throws ReflectiveOperationException {
        Exception globalError;
        try {
            Class<?> global = Class.forName("android.hardware.input.InputManagerGlobal");
            InputInjector injector = new InputInjector(global.getMethod("getInstance").invoke(null),
                    global.getMethod("injectInputEvent", InputEvent.class, int.class));
            Ln.i("Input: InputManagerGlobal");
            return injector;
        } catch (ReflectiveOperationException | RuntimeException e) {
            globalError = e; // Expected before Android 14.
        }
        Class<?> legacy = android.hardware.input.InputManager.class;
        try {
            InputInjector injector = new InputInjector(legacy.getMethod("getInstance").invoke(null),
                    legacy.getMethod("injectInputEvent", InputEvent.class, int.class));
            Ln.i("Input: InputManager");
            return injector;
        } catch (ReflectiveOperationException e) {
            throw new ReflectiveOperationException("InputManagerGlobal: " + globalError + ". InputManager: " + e, e);
        }
    }

    /** Queues the event and returns at once. */
    boolean inject(InputEvent event) {
        return inject(event, MODE_ASYNC);
    }

    /** Returns once the app that got the event has handled it. */
    boolean injectAndWait(InputEvent event) {
        return inject(event, MODE_WAIT_FOR_FINISH);
    }

    private boolean inject(InputEvent event, int mode) {
        try {
            if ((Boolean) injectInputEvent.invoke(manager, event, mode)) {
                return true;
            }
            warn("The device refused an input event");
        } catch (InvocationTargetException e) {
            // A SecurityException means the shell user may not inject input. Some devices have a
            // developer option for it, next to USB debugging.
            warn("Could not inject input: " + e.getCause());
        } catch (ReflectiveOperationException e) {
            warn("Could not inject input: " + e);
        }
        return false;
    }

    /** Puts plain text on the clipboard. False when the device did not allow it. */
    boolean setClipboard(String text) {
        try {
            connectClipboard();
            ClipData clip = ClipData.newPlainText("Stormcast", text);
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean(EXTRA_SUPPRESS_OVERLAY, true);
            clip.getDescription().setExtras(extras);
            ownClip = text;
            setPrimaryClip.invoke(clipboard, clipboardArguments(setPrimaryClip.getParameterTypes(), clip));
            return true;
        } catch (InvocationTargetException e) {
            warn("Could not set the clipboard: " + e.getCause());
        } catch (ReflectiveOperationException | RuntimeException e) {
            warn("Could not set the clipboard: " + e);
        }
        return false;
    }

    /** The clipboard's text, unless it holds none or the text setClipboard put there. */
    String newClipboardText() {
        try {
            connectClipboard();
            ClipData clip = (ClipData) getPrimaryClip.invoke(clipboard,
                    clipboardArguments(getPrimaryClip.getParameterTypes(), null));
            CharSequence text = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getText();
            return text == null || text.toString().equals(ownClip) ? null : text.toString();
        } catch (InvocationTargetException e) {
            warn("Could not read the clipboard: " + e.getCause());
        } catch (ReflectiveOperationException | RuntimeException e) {
            warn("Could not read the clipboard: " + e);
        }
        return null;
    }

    /**
     * Calls back on a binder thread whenever the clipboard changes. The listener is a hidden
     * interface, so a proxy stands in for it, and a plain Binder takes the system's one call.
     */
    void watchClipboard(final Runnable onChange) throws ReflectiveOperationException {
        connectClipboard();
        final Binder binder = new Binder() {
            @Override
            protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
                if (code == IBinder.FIRST_CALL_TRANSACTION) { // dispatchPrimaryClipChanged(), one way
                    onChange.run();
                    return true;
                }
                return super.onTransact(code, data, reply, flags);
            }
        };
        Class<?> type = Class.forName(LISTENER);
        InvocationHandler handler = (proxy, method, args) -> {
            switch (method.getName()) {
                case "asBinder":
                    return binder;
                case "hashCode":
                    return System.identityHashCode(proxy);
                case "equals":
                    return proxy == args[0];
                case "toString":
                    return LISTENER;
                default:
                    return null;
            }
        };
        Object listener = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler);
        Method add = method(clipboard.getClass(), "addPrimaryClipChangedListener");
        add.invoke(clipboard, clipboardArguments(add.getParameterTypes(), listener));
    }

    private synchronized void connectClipboard() throws ReflectiveOperationException {
        if (clipboard != null) {
            return;
        }
        IBinder binder = (IBinder) Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class).invoke(null, "clipboard");
        Object service = Class.forName("android.content.IClipboard$Stub")
                .getMethod("asInterface", IBinder.class).invoke(null, binder);
        setPrimaryClip = method(service.getClass(), "setPrimaryClip");
        getPrimaryClip = method(service.getClass(), "getPrimaryClip");
        clipboard = service;
    }

    private static Method method(Class<?> type, String name) throws NoSuchMethodException {
        for (Method method : type.getMethods()) {
            if (method.getName().equals(name)) {
                return method;
            }
        }
        throw new NoSuchMethodException(type.getName() + "." + name);
    }

    /**
     * IClipboard's parameters depend on the Android version: (object, callingPackage
     * [, attributionTag], userId[, deviceId]). The first string is the shell's package and later
     * ones are null; the user and the device are 0, the main user and the device itself.
     */
    private static Object[] clipboardArguments(Class<?>[] types, Object object) {
        Object[] arguments = new Object[types.length];
        boolean packageSet = false;
        for (int i = 0; i < types.length; i++) {
            if (types[i] == String.class) {
                arguments[i] = packageSet ? null : SHELL_PACKAGE;
                packageSet = true;
            } else if (types[i] == int.class) {
                arguments[i] = 0;
            } else if (object != null && types[i].isInstance(object)) {
                arguments[i] = object;
            } else {
                throw new IllegalStateException("Unknown IClipboard parameters " + Arrays.toString(types));
            }
        }
        return arguments;
    }

    /** At most one warning every few seconds, so a refusing device does not flood the log. */
    private synchronized void warn(String message) {
        long now = System.currentTimeMillis();
        if (now - lastWarning >= WARNING_INTERVAL_MS) {
            lastWarning = now;
            Ln.w(message);
        }
    }
}
