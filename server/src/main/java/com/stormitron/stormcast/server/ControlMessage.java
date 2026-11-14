package com.stormitron.stormcast.server;

/**
 * A control message from the app (docs/PROTOCOL.md, "Control from the app"). Plain Java: tested on
 * the JVM.
 */
abstract class ControlMessage {
    final int type;

    private ControlMessage(int type) {
        this.type = type;
    }

    /** The kind of message, for log lines that must not show what was typed. */
    abstract String name();

    private static int checked(int value, String[] names, String what) {
        if (value < 0 || value >= names.length) {
            throw new IllegalArgumentException("Unknown " + what + " " + value);
        }
        return value;
    }

    /** A message about a pixel on a video of width x height. */
    abstract static class Positioned extends ControlMessage {
        final int x;
        final int y;
        final int width;
        final int height;

        private Positioned(int type, int x, int y, int width, int height) {
            super(type);
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;
        }

        String position() {
            return x + "," + y + " on " + width + "x" + height;
        }
    }

    static final class Touch extends Positioned {
        static final int DOWN = 0;
        static final int MOVE = 1;
        static final int UP = 2;
        static final int CANCEL = 3;
        private static final String[] ACTIONS = {"down", "move", "up", "cancel"};

        final int action;
        /** The app's id for a finger, the mouse or a pen. */
        final long pointer;
        /** From 0 to 1. */
        final float pressure;

        Touch(int action, long pointer, int x, int y, int width, int height, float pressure) {
            super(Protocol.TYPE_TOUCH, x, y, width, height);
            this.action = checked(action, ACTIONS, "touch action");
            this.pointer = pointer;
            this.pressure = pressure;
        }

        @Override
        String name() {
            return "touch";
        }

        @Override
        public String toString() {
            return "touch " + ACTIONS[action] + " pointer " + pointer + " at " + position() + " pressure " + pressure;
        }
    }

    /** Android's KeyEvent values. */
    static final class Key extends ControlMessage {
        static final int DOWN = 0;
        static final int UP = 1;
        private static final String[] ACTIONS = {"down", "up"};

        final int action;
        final int keycode;
        final int repeat;
        final int metaState;

        Key(int action, int keycode, int repeat, int metaState) {
            super(Protocol.TYPE_KEY);
            this.action = checked(action, ACTIONS, "key action");
            this.keycode = keycode;
            this.repeat = repeat;
            this.metaState = metaState;
        }

        @Override
        String name() {
            return "key";
        }

        @Override
        public String toString() {
            return "key " + ACTIONS[action] + " keycode " + keycode + " repeat " + repeat
                    + " meta 0x" + Integer.toHexString(metaState);
        }
    }

    static final class Text extends ControlMessage {
        final String text;

        Text(String text) {
            super(Protocol.TYPE_TEXT);
            this.text = text;
        }

        @Override
        String name() {
            return "text";
        }

        @Override
        public String toString() {
            return "text " + Json.quote(text);
        }
    }

    static final class Button extends ControlMessage {
        static final int BACK = 0;
        static final int HOME = 1;
        static final int RECENT_APPS = 2;
        static final int POWER = 3;
        private static final String[] BUTTONS = {"back", "home", "recent apps", "power"};

        final int button;

        Button(int button) {
            super(Protocol.TYPE_BUTTON);
            this.button = checked(button, BUTTONS, "button");
        }

        @Override
        String name() {
            return "button";
        }

        @Override
        public String toString() {
            return "button " + BUTTONS[button];
        }
    }

    /** Wheel notches, positive to the right and up. */
    static final class Scroll extends Positioned {
        final float horizontal;
        final float vertical;

        Scroll(int x, int y, int width, int height, float horizontal, float vertical) {
            super(Protocol.TYPE_SCROLL, x, y, width, height);
            this.horizontal = horizontal;
            this.vertical = vertical;
        }

        @Override
        String name() {
            return "scroll";
        }

        @Override
        public String toString() {
            return "scroll at " + position() + " by " + horizontal + "," + vertical;
        }
    }
}
