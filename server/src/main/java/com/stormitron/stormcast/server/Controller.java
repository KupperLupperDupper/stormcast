package com.stormitron.stormcast.server;

import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
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
    /** Time for the lock screen's code entry to open before the code is typed. */
    private static final long CODE_ENTRY_DELAY_MS = 700;
    /** How long a screen may take to turn on, and how long it then settles before the code entry opens. */
    private static final long SCREEN_ON_TIMEOUT_MS = 1500;
    private static final long SCREEN_ON_POLL_MS = 50;
    private static final long SCREEN_ON_SETTLE_MS = 300;
    /** The swipe that opens the code entry when dismissKeyguard is not available. */
    private static final int SWIPE_STEPS = 10;
    private static final long SWIPE_STEP_MS = 15;
    /** A pointer id the app never uses: its ids are 32-bit. */
    private static final long SWIPE_POINTER = 1L << 32;

    private final ControlReader reader;
    private final AtomicReference<Geometry> geometry;
    private final AudioStreamer audio;
    /** Null when the device offers no way to inject: messages are then read and dropped. */
    private final InputInjector injector;
    /** The virtual keyboard's key map, which turns text into key presses; null if missing. */
    private final KeyCharacterMap keyboard;
    /** Null when input cannot be injected. */
    private final DeviceStateWatcher state;
    private final TouchPointers fingers = new TouchPointers();
    private final MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[TouchPointers.MAX];
    private final MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[TouchPointers.MAX];
    private final Map<Integer, Long> keyDownTimes = new HashMap<>();
    private final Set<Integer> loggedTypes = new HashSet<>();
    private long touchDownTime;
    private boolean pasteLogged;
    private boolean lockedPasteLogged;

    private Controller(InputStream in, AtomicReference<Geometry> geometry, AudioStreamer audio,
            InputInjector injector, KeyCharacterMap keyboard, DeviceStateWatcher state) {
        this.reader = new ControlReader(in);
        this.geometry = geometry;
        this.audio = audio;
        this.injector = injector;
        this.keyboard = keyboard;
        this.state = state;
        for (int i = 0; i < TouchPointers.MAX; i++) {
            properties[i] = new MotionEvent.PointerProperties();
            properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
        }
    }

    /**
     * Reads control messages on a new thread. It reads them even when they cannot be injected, so
     * the app is never blocked writing them. The streamer publishes each session's geometry, text
     * copied on the device goes to the app through the writer, and audio messages turn the audio
     * streamer on and off, also when input cannot be injected. The device's lock state goes to the
     * app too (B-012).
     */
    static void start(InputStream in, MessageWriter writer, AtomicReference<Geometry> geometry,
            AudioStreamer audio) {
        InputInjector injector = null;
        KeyCharacterMap keyboard = null;
        try {
            injector = InputInjector.create();
            keyboard = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
        } catch (ReflectiveOperationException | RuntimeException e) {
            Ln.w((injector == null ? "Control is not available: " : "No virtual keyboard; text is pasted: ") + e);
        }
        DeviceStateWatcher state = null;
        if (injector != null) {
            final InputInjector clipboard = injector;
            try {
                clipboard.watchClipboard(() -> sendClipboard(clipboard, writer));
            } catch (ReflectiveOperationException | RuntimeException e) {
                Ln.w("The device's clipboard does not reach the app: " + e);
            }
            state = DeviceStateWatcher.start(injector, writer);
        }
        Thread thread = new Thread(new Controller(in, geometry, audio, injector, keyboard, state),
                "stormcast-control");
        thread.setDaemon(true);
        thread.start();
    }

    /** Sends text copied on the device to the app. Runs on a binder thread; never logs the text. */
    private static void sendClipboard(InputInjector injector, MessageWriter writer) {
        String text = injector.newClipboardText();
        if (text == null) {
            return;
        }
        byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
        if (utf8.length > Protocol.MAX_CLIPBOARD) {
            Ln.w("Copied text of " + utf8.length + " bytes is too large for the PC's clipboard");
            return;
        }
        try {
            writer.writeClipboard(utf8);
            writer.flush();
        } catch (IOException e) {
            // The connection closed; the streamer stops the server.
        }
    }

    @Override
    public void run() {
        try {
            ControlMessage message;
            while ((message = reader.next()) != null) {
                if (message.type == Protocol.TYPE_SET_AUDIO) {
                    audio.setEnabled(((ControlMessage.Audio) message).on);
                    continue;
                }
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
            case Protocol.TYPE_SET_CLIPBOARD:
                ControlMessage.Clipboard clip = (ControlMessage.Clipboard) message;
                if (injector.setClipboard(clip.text) && clip.paste) {
                    pressPaste();
                }
                break;
            case Protocol.TYPE_UNLOCK:
                unlock(((ControlMessage.Unlock) message).code);
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

    /**
     * Types with the virtual keyboard's keys, and pastes what it has no keys for. While the device
     * is locked, the text may be its code, so nothing goes through the clipboard (B-012).
     */
    private void type(String text) {
        boolean locked = state != null && state.isLocked();
        StringBuilder paste = new StringBuilder();
        for (int i = 0; i < text.length(); ) {
            int codePoint = text.codePointAt(i);
            i += Character.charCount(codePoint);
            KeyEvent[] events = keysFor(codePoint);
            if (events == null) {
                if (locked) {
                    if (!lockedPasteLogged) {
                        lockedPasteLogged = true;
                        Ln.w("Characters the keyboard cannot type are not pasted while the device is locked");
                    }
                } else {
                    paste.appendCodePoint(codePoint);
                }
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
     * Wakes the screen and opens the lock screen's code entry, then types the code and Enter, if
     * there is a code. The code goes only as key presses: never through the clipboard, and never to
     * the log. If the keyboard cannot type one of its characters, none of it is typed.
     */
    private void unlock(String code) {
        List<KeyEvent> keys = new ArrayList<>();
        for (int i = 0; i < code.length() && keys != null; ) {
            int codePoint = code.codePointAt(i);
            i += Character.charCount(codePoint);
            KeyEvent[] events = keysFor(codePoint);
            if (events == null) {
                Ln.w("The unlock code has a character the device's keyboard cannot type; nothing was typed");
                keys = null;
            } else {
                Collections.addAll(keys, events);
            }
        }
        // The swipe must reach a lock screen that is awake, so wait for the screen to turn on.
        boolean wasOn = injector.screenOn();
        long now = SystemClock.uptimeMillis();
        injector.injectAndWait(keyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_WAKEUP, 0, 0));
        injector.injectAndWait(keyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_WAKEUP, 0, 0));
        if (!wasOn) {
            long end = SystemClock.uptimeMillis() + SCREEN_ON_TIMEOUT_MS;
            while (!injector.screenOn() && SystemClock.uptimeMillis() < end) {
                SystemClock.sleep(SCREEN_ON_POLL_MS);
            }
            SystemClock.sleep(SCREEN_ON_SETTLE_MS);
        }
        // A swipe up opens the code entry itself, as a user does. dismissKeyguard is only the
        // fallback: on some lock screens (OnePlus with a fingerprint) it opens a fingerprint prompt
        // with an "Enter password" button instead, and typed keys go nowhere.
        if (!swipeUp()) {
            injector.dismissKeyguard();
        }
        if (keys == null || keys.isEmpty()) {
            return;
        }
        SystemClock.sleep(CODE_ENTRY_DELAY_MS);
        for (KeyEvent event : keys) {
            injector.inject(event);
        }
        key(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, 0);
        key(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0, 0);
    }

    /**
     * Swipes up the middle of the display, which opens the code entry on lock screens. False
     * before the first capture session, when the display's size is not known.
     */
    private boolean swipeUp() {
        Geometry current = geometry.get();
        if (current == null) {
            return false;
        }
        float x = current.displayWidth / 2f;
        float from = current.displayHeight * 0.85f;
        float to = current.displayHeight * 0.3f;
        injectTouch(fingers.down(SWIPE_POINTER, x, from, 1f));
        for (int step = 1; step < SWIPE_STEPS; step++) {
            SystemClock.sleep(SWIPE_STEP_MS);
            injectTouch(fingers.move(SWIPE_POINTER, x, from + (to - from) * step / SWIPE_STEPS, 1f));
        }
        injectTouch(fingers.up(SWIPE_POINTER, x, to, 1f));
        return true;
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
            pressPaste();
        }
        text.setLength(0);
    }

    /** Presses paste, and waits until the app has pasted, so the next text cannot replace the clip before that. */
    private void pressPaste() {
        long now = SystemClock.uptimeMillis();
        injector.injectAndWait(keyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_PASTE, 0, 0));
        injector.inject(keyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_PASTE, 0, 0));
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
