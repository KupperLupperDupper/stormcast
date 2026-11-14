package com.stormitron.stormcast.server;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.BufferUnderflowException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * Reads the app's control messages: [u8 type][u32 length][payload], big-endian
 * (docs/PROTOCOL.md). Plain Java: tested on the JVM against protocol/vectors.txt.
 */
final class ControlReader {
    private final DataInputStream in;

    ControlReader(InputStream in) {
        this.in = new DataInputStream(in);
    }

    /** The next message, or null when the app closed the connection. */
    ControlMessage next() throws IOException {
        while (true) {
            int type = in.read();
            if (type < 0) {
                return null;
            }
            int length = in.readInt();
            if (length < 0 || length > Protocol.MAX_CONTROL_PAYLOAD) {
                throw new IOException("Control message of " + (length & 0xffffffffL) + " bytes");
            }
            byte[] payload = new byte[length];
            in.readFully(payload);
            ControlMessage message = parse(type, payload);
            if (message != null) {
                return message;
            }
        }
    }

    /**
     * The message, or null for a type this server does not know, which a newer app may send, and
     * for a payload it cannot read, which is logged. Longer payloads are fine: a newer app may add
     * fields at the end.
     */
    static ControlMessage parse(int type, byte[] payload) {
        ByteBuffer data = ByteBuffer.wrap(payload);
        try {
            switch (type) {
                case Protocol.TYPE_TOUCH:
                    return new ControlMessage.Touch(data.get() & 0xff, data.getInt() & 0xffffffffL,
                            u16(data), u16(data), u16(data), u16(data), data.getFloat());
                case Protocol.TYPE_KEY:
                    return new ControlMessage.Key(data.get() & 0xff, data.getInt(), data.getInt(), data.getInt());
                case Protocol.TYPE_TEXT:
                    return new ControlMessage.Text(new String(payload, StandardCharsets.UTF_8));
                case Protocol.TYPE_BUTTON:
                    return new ControlMessage.Button(data.get() & 0xff);
                case Protocol.TYPE_SCROLL:
                    return new ControlMessage.Scroll(u16(data), u16(data), u16(data), u16(data),
                            data.getFloat(), data.getFloat());
                default:
                    return null;
            }
        } catch (BufferUnderflowException e) {
            Ln.w("Skipped a control message of type " + type + ": " + payload.length + " bytes is too short");
        } catch (IllegalArgumentException e) {
            Ln.w("Skipped a control message: " + e.getMessage());
        }
        return null;
    }

    private static int u16(ByteBuffer data) {
        return data.getShort() & 0xffff;
    }
}
