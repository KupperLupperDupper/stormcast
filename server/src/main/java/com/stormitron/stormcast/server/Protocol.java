package com.stormitron.stormcast.server;

/**
 * Constants of the Stormcast protocol (docs/PROTOCOL.md). Keep them in sync with
 * src-tauri/src/protocol.rs; protocol/vectors.txt is checked by the tests on both sides.
 */
final class Protocol {
    static final byte[] MAGIC = {'S', 'T', 'R', 'M'};
    static final int VERSION = 1;

    static final int TYPE_HELLO = 1;
    static final int TYPE_SESSION = 2;
    static final int TYPE_CONFIG = 3;
    static final int TYPE_FRAME = 4;
    static final int TYPE_ERROR = 5;

    static final int FLAG_KEY_FRAME = 1;

    private Protocol() {
    }
}
