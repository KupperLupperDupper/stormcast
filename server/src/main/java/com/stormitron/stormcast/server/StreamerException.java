package com.stormitron.stormcast.server;

/** A failure the app can explain. The code is sent in the error message (docs/PROTOCOL.md). */
final class StreamerException extends Exception {
    private static final long serialVersionUID = 1L;

    final String code;

    StreamerException(String code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
}
