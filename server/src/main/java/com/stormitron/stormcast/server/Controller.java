package com.stormitron.stormcast.server;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.io.IOException;
import java.io.InputStream;
import java.text.Normalizer;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Turns the app's control messages (docs/PROTOCOL.md) into input on the main display. Runs on its
 * own thread until the app closes the connection.
 */
final class Controller implements Runnable {
    /** Input from the app comes from no real input device. */
    private static final int DEVICE_ID = 0;
    /** By ControlMessage.Button: back, home, recent apps and power. */
    private static final int[] BUTTON_KEYCODES = {
        KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_POWER,
    };

    private final ControlReader reader;
    private final AtomicReference<Geometry> geometry;
    /** Null when the device offers no way to inject: messages are then read and dropped. */
    private final InputInjector injector;
    /** The virtual keyboard's key map, which turns text into key presses; null if missing. */
    private final KeyCharacterMap keyboard;
    private final TouchPointers fingers = new TouchPointers();
    private final MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[TouchPointers.MAX];
    private final MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[TouchPointers.MAX];
    private final Map<Integer, Long> keyDownTimes = new HashMap<>();
    private final Set<Integer> loggedTypes = new HashSet<>();
    private long touchDownTime;
    private boolean pasteLogged;

    private Controller(InputStream in, AtomicReference<Geometry> geometry, InputInjector injector,
            KeyCharacterMap keyboard) {
        this.reader = new ControlReader(in);
        this.geometry = geometry;
        this.injector = injector;
        this.keyboard = keyboard;
        for (int i = 0; i < TouchPointers.MAX; i++) {
            properties[i] = new MotionEvent.PointerProperties();
            properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
        }
    }

    /**
     * Reads control messages on a new thread. It reads them even when they cannot be injected, so
     * the app is never blocked writing them. The streamer publishes each session's geometry.
     */
    static void start(InputStream in, AtomicReference<Geometry> geometry) {
        InputInjector injector = null;
        KeyCharacterMap keyboard = null;
        try {
            injector = InputInjector.create();
            keyboard = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
        } catch (ReflectiveOperationException | RuntimeException e) {
            Ln.w((injector == null ? "Control is not available: " : "No virtual keyboard; text is pasted: ") + e);
        }
        Thread thread = new Thread(new Controller(in, geometry, injector, keyboard), "stormcast-control");
        thread.setDaemon(true);
        thread.start();
    }

    @Override
    public void run() {
        try {
            ControlMessage message;
            while ((message = reader.next()) != null) {
                if (injector == null) {
                    continue;
                }
                if (loggedTypes.add(message.type)) {
                    Ln.i("Control: first " + message.name() + " message");
                }
                try {
                    handle(message);
                } catch (RuntimeException e) {
                    Ln.w("Could not inject " + message.name() + " input: " + e);
                }
            }
        } catch (IOException e) {
            // The connection closed; the streamer notices too and stops the server.
        }
    }

    private void handle(ControlMessage message) {
        switch (message.type) {
            case Protocol.TYPE_TOUCH:
                touch((ControlMessage.Touch) message);
                break;
            case Protocol.TYPE_KEY:
                ControlMessage.Key press = (ControlMessage.Key) message;
                key(press.action == ControlMessage.Key.DOWN ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP,
                        press.keycode, press.repeat, press.metaState);
                break;
            case Protocol.TYPE_TEXT:
                type(((ControlMessage.Text) message).text);
                break;
            case Protocol.TYPE_BUTTON:
                int keycode = BUTTON_KEYCODES[((ControlMessage.Button) message).button];
                key(KeyEvent.ACTION_DOWN, keycode, 0, 0);
                key(KeyEvent.ACTION_UP, keycode, 0, 0);
                break;
            case Protocol.TYPE_SCROLL:
                scroll((ControlMessage.Scroll) message);
                break;
            default:
                break;
        }
    }

    private void touch(ControlMessage.Touch touch) {
        Geometry current = geometry.get();
        if (current == null || !current.matches(touch.width, touch.height)) {
            // Made for the video before the display rotated: touch nothing, but let go of every finger.
            if (touch.action == ControlMessage.Touch.UP || touch.action == ControlMessage.Touch.CANCEL) {
                injectTouch(fingers.cancel());
            }
            return;
        }
        float x = current.displayX(touch.x);
        float y = current.displayY(touch.y);
        switch (touch.action) {
            case ControlMessage.Touch.DOWN:
                if (fingers.isDown(touch.pointer)) {
                    // Its up never came, so that touch is stale: end it before the new one starts.
                    injectTouch(fingers.cancel());
                }
                injectTouch(fingers.down(touch.pointer, x, y, touch.pressure));
                break;
            case ControlMessage.Touch.MOVE:
                injectTouch(fingers.move(touch.pointer, x, y, touch.pressure));
                break;
            case ControlMessage.Touch.UP:
                injectTouch(fingers.up(touch.pointer, x, y, touch.pressure));
                break;
            default:
                injectTouch(fingers.cancel());
                break;
        }
    }

    /** Sends the fingers as a MotionEvent with this action, then forgets the ones that went up. */
    private void injectTouch(int action) {
        if (action == TouchPointers.NONE) {
            return;
        }
        long now = SystemClock.uptimeMillis();
        if (action == TouchPointers.ACTION_DOWN) {
            touchDownTime = now;
        }
        int count = fingers.size();
        for (int i = 0; i < count; i++) {
            properties[i].id = fingers.localId(i);
            coords[i].x = fingers.x(i);
            coords[i].y = fingers.y(i);
            coords[i].pressure = fingers.pressure(i);
        }
        MotionEvent event = MotionEvent.obtain(touchDownTime, now, action, count, properties, coords, 0, 0, 1f, 1f,
                DEVICE_ID, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        injector.inject(event);
        event.recycle();
        fingers.removeLifted();
    }

    private void key(int action, int keycode, int repeat, int metaState) {
        long now = SystemClock.uptimeMillis();
        Long downTime;
        if (action == KeyEvent.ACTION_DOWN) {
            if (repeat == 0 || !keyDownTimes.containsKey(keycode)) {
                keyDownTimes.put(keycode, now);
            }
            downTime = keyDownTimes.get(keycode);
        } else {
            downTime = keyDownTimes.remove(keycode);
        }
        injector.inject(keyEvent(downTime == null ? now : downTime, now, action, keycode, repeat, metaState));
    }

    /** Types with the virtual keyboard's keys, and pastes what it has no keys for. */
    private void type(String text) {
        StringBuilder paste = new StringBuilder();
        for (int i = 0; i < text.length(); ) {
            int codePoint = text.codePointAt(i);
            i += Character.charCount(codePoint);
            KeyEvent[] events = keysFor(codePoint);
            if (events == null) {
                paste.appendCodePoint(codePoint);
                continue;
            }
            paste(paste);
            for (KeyEvent event : events) {
                injector.inject(event);
            }
        }
        paste(paste);
    }

    /**
     * The key events that type the character: its own key, or for an accented letter the accent
     * as a dead key and then the letter. Null when the keyboard has neither.
     */
    private KeyEvent[] keysFor(int codePoint) {
        if (keyboard == null || Character.charCount(codePoint) != 1) {
            return null;
        }
        char c = (char) codePoint;
        KeyEvent[] events = keyboard.getEvents(new char[] {c});
        if (events != null) {
            return events;
        }
        String parts = Normalizer.normalize(String.valueOf(c), Normalizer.Form.NFD);
        return parts.length() == 2 ? keyboard.getEvents(new char[] {parts.charAt(1), parts.charAt(0)}) : null;
    }

    private void paste(StringBuilder text) {
        if (text.length() == 0) {
            return;
        }
        if (!pasteLogged) {
            pasteLogged = true;
            Ln.i("Control: pasting characters the virtual keyboard cannot type");
        }
        if (injector.setClipboard(text.toString())) {
            long now = SystemClock.uptimeMillis();
            // Wait until the app has pasted, so the next text cannot replace the clip before that.
            injector.injectAndWait(keyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_PASTE, 0, 0));
            injector.inject(keyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_PASTE, 0, 0));
        }
        text.setLength(0);
    }

    private void scroll(ControlMessage.Scroll scroll) {
        Geometry current = geometry.get();
        if (current == null || !current.matches(scroll.width, scroll.height)) {
            return;
        }
        MotionEvent.PointerProperties pointer = new MotionEvent.PointerProperties();
        pointer.toolType = MotionEvent.TOOL_TYPE_MOUSE;
        MotionEvent.PointerCoords position = new MotionEvent.PointerCoords();
        position.x = current.displayX(scroll.x);
        position.y = current.displayY(scroll.y);
        position.setAxisValue(MotionEvent.AXIS_HSCROLL, scroll.horizontal);
        position.setAxisValue(MotionEvent.AXIS_VSCROLL, scroll.vertical);
        long now = SystemClock.uptimeMillis();
        MotionEvent event = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1,
                new MotionEvent.PointerProperties[] {pointer}, new MotionEvent.PointerCoords[] {position}, 0, 0,
                1f, 1f, DEVICE_ID, 0, InputDevice.SOURCE_MOUSE, 0);
        injector.inject(event);
        event.recycle();
    }

    private static KeyEvent keyEvent(long downTime, long now, int action, int keycode, int repeat, int metaState) {
        return new KeyEvent(downTime, now, action, keycode, repeat, metaState, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0,
                InputDevice.SOURCE_KEYBOARD);
    }
}
