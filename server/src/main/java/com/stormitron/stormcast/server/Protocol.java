package com.stormitron.stormcast.server;

/**
 * Constants of the Stormcast protocol (docs/PROTOCOL.md). Keep them in sync with
 * src-tauri/src/protocol.rs; protocol/vectors.txt is checked by the tests on both sides.
 */
final class Protocol {
    static final byte[] MAGIC = {'S', 'T', 'R', 'M'};
    static final int VERSION = 2;

    // From the phone to the app.
    static final int TYPE_HELLO = 1;
    static final int TYPE_SESSION = 2;
    static final int TYPE_CONFIG = 3;
    static final int TYPE_FRAME = 4;
    static final int TYPE_ERROR = 5;
    static final int TYPE_CLIPBOARD = 6;

    static final int FLAG_KEY_FRAME = 1;

    // From the app to the phone.
    static final int TYPE_TOUCH = 16;
    static final int TYPE_KEY = 17;
    static final int TYPE_TEXT = 18;
    static final int TYPE_BUTTON = 19;
    static final int TYPE_SCROLL = 20;
    static final int TYPE_SET_CLIPBOARD = 21;

    /** Clipboard text in either direction, in UTF-8 bytes. */
    static final int MAX_CLIPBOARD = 256 * 1024;
    /** A larger control message means a broken stream. */
    static final int MAX_CONTROL_PAYLOAD = MAX_CLIPBOARD + 1;

    private Protocol() {
    }
}
