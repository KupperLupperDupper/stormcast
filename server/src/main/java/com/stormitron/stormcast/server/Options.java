package com.stormitron.stormcast.server;

/**
 * The server's command line: the protocol version, then key=value options. The app and the
 * server ship together, so anything unexpected is an error. Plain Java: tested on the JVM.
 */
final class Options {
    static final int DEFAULT_BIT_RATE = 8_000_000;

    /** Abstract Unix socket to connect to, mapped to the app by adb reverse. */
    final String socketName;
    /** Long side of the video in pixels; 0 keeps the display size. */
    final int maxSize;
    /** Bits per second. */
    final int bitRate;
    /** Frames per second; 0 means no limit. */
    final int maxFps;
    /** Start audio capture at once. */
    final boolean audio;
    /** Play a short test tone on the device once audio capture runs, for the smoke test. */
    final boolean tone;

    private Options(String socketName, int maxSize, int bitRate, int maxFps, boolean audio, boolean tone) {
        this.socketName = socketName;
        this.maxSize = maxSize;
        this.bitRate = bitRate;
        this.maxFps = maxFps;
        this.audio = audio;
        this.tone = tone;
    }

    static Options parse(String[] args) {
        if (args.length == 0) {
            throw new IllegalArgumentException("Missing the protocol version");
        }
        int version = parseInt("protocol version", args[0]);
        if (version != Protocol.VERSION) {
            throw new IllegalArgumentException("Protocol mismatch: the app speaks " + version
                    + ", this server " + Protocol.VERSION);
        }
        String socketName = null;
        int maxSize = 0;
        int bitRate = DEFAULT_BIT_RATE;
        int maxFps = 0;
        boolean audio = false;
        boolean tone = false;
        for (int i = 1; i < args.length; i++) {
            String arg = args[i];
            int equals = arg.indexOf('=');
            if (equals <= 0) {
                throw new IllegalArgumentException("Invalid argument: " + arg);
            }
            String key = arg.substring(0, equals);
            String value = arg.substring(equals + 1);
            switch (key) {
                case "socket":
                    socketName = value;
                    break;
                case "max_size":
                    maxSize = parseInt(key, value);
                    break;
                case "bit_rate":
                    bitRate = parseInt(key, value);
                    break;
                case "max_fps":
                    maxFps = parseInt(key, value);
                    break;
                case "audio":
                    audio = parseFlag(key, value);
                    break;
                case "tone":
                    tone = parseFlag(key, value);
                    break;
                default:
                    throw new IllegalArgumentException("Unknown option: " + key);
            }
        }
        if (socketName == null || socketName.isEmpty()) {
            throw new IllegalArgumentException("Missing socket=<name>");
        }
        return new Options(socketName, maxSize, bitRate, maxFps, audio, tone);
    }

    private static boolean parseFlag(String what, String value) {
        if (value.equals("0") || value.equals("1")) {
            return value.equals("1");
        }
        throw new IllegalArgumentException("Invalid " + what + ": " + value + " (0 or 1)");
    }

    private static int parseInt(String what, String value) {
        try {
            int number = Integer.parseInt(value);
            if (number < 0) {
                throw new NumberFormatException();
            }
            return number;
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Invalid " + what + ": " + value);
        }
    }
}
