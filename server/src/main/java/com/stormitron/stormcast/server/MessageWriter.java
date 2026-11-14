package com.stormitron.stormcast.server;

import java.io.DataOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Writes the stream to the app: the preamble, then messages of [u8 type][u32 length][payload].
 * Integers are big-endian. Each message is written whole, also when the clipboard watcher writes
 * from another thread than the streamer. Plain Java: tested on the JVM against
 * protocol/vectors.txt.
 */
final class MessageWriter {
    private static final int FRAME_PREFIX = 9; // flags + pts

    private final DataOutputStream out;

    MessageWriter(OutputStream out) {
        this.out = new DataOutputStream(out);
    }

    synchronized void writePreamble() throws IOException {
        out.write(Protocol.MAGIC);
        out.writeByte(Protocol.VERSION);
    }

    synchronized void writeHello(String device, String codec, String server, String android, int sdk)
            throws IOException {
        String json = "{\"device\":" + Json.quote(device)
                + ",\"codec\":" + Json.quote(codec)
                + ",\"server\":" + Json.quote(server)
                + ",\"android\":" + Json.quote(android)
                + ",\"sdk\":" + sdk + "}";
        writeMessage(Protocol.TYPE_HELLO, json.getBytes(StandardCharsets.UTF_8));
    }

    synchronized void writeSession(int width, int height, int rotation) throws IOException {
        header(Protocol.TYPE_SESSION, 9);
        out.writeInt(width);
        out.writeInt(height);
        out.writeByte(rotation);
    }

    synchronized void writeConfig(byte[] data, int offset, int length) throws IOException {
        header(Protocol.TYPE_CONFIG, length);
        out.write(data, offset, length);
    }

    synchronized void writeFrame(boolean keyFrame, long ptsUs, byte[] data, int offset, int length)
            throws IOException {
        header(Protocol.TYPE_FRAME, FRAME_PREFIX + length);
        out.writeByte(keyFrame ? Protocol.FLAG_KEY_FRAME : 0);
        out.writeLong(ptsUs);
        out.write(data, offset, length);
    }

    synchronized void writeError(String code, String message) throws IOException {
        String json = "{\"code\":" + Json.quote(code) + ",\"message\":" + Json.quote(String.valueOf(message)) + "}";
        writeMessage(Protocol.TYPE_ERROR, json.getBytes(StandardCharsets.UTF_8));
    }

    synchronized void writeClipboard(byte[] utf8) throws IOException {
        writeMessage(Protocol.TYPE_CLIPBOARD, utf8);
    }

    synchronized void flush() throws IOException {
        out.flush();
    }

    private void writeMessage(int type, byte[] payload) throws IOException {
        header(type, payload.length);
        out.write(payload);
    }

    private void header(int type, int length) throws IOException {
        out.writeByte(type);
        out.writeInt(length);
    }
}
