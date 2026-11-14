package com.stormitron.stormcast.server;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Checks the server's encoding against protocol/vectors.txt, which the Rust tests read too, and
 * the plain-Java helpers. Runs on the JVM without Android: java ProtocolTest path/to/vectors.txt
 */
public final class ProtocolTest {
    private interface Write {
        void to(MessageWriter writer) throws IOException;
    }

    private static final byte[] CONFIG = {0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, (byte) 0xac, 0x2b, 0x40, 0x3c,
            0, 0, 0, 1, 0x68, (byte) 0xee, 0x3c, (byte) 0x80};
    private static final byte[] KEY_FRAME = {0, 0, 0, 1, 0x65, (byte) 0x88};
    private static final byte[] DELTA_FRAME = {0, 0, 0, 1, 0x41, (byte) 0x9a};

    private static int failures;

    private ProtocolTest() {
    }

    public static void main(String[] args) throws IOException {
        Map<String, String> vectors = readVectors(args[0]);
        encodes(vectors, "preamble", w -> w.writePreamble());
        encodes(vectors, "hello", w -> w.writeHello("Lenovo TB311FU", "h264", "0.1.0", "16", 36));
        encodes(vectors, "session", w -> w.writeSession(1200, 1920, 1));
        encodes(vectors, "config", w -> w.writeConfig(CONFIG, 0, CONFIG.length));
        encodes(vectors, "frame_key", w -> w.writeFrame(true, 1_234_567L, KEY_FRAME, 0, KEY_FRAME.length));
        encodes(vectors, "frame_delta", w -> w.writeFrame(false, 1_251_234L, DELTA_FRAME, 0, DELTA_FRAME.length));
        encodes(vectors, "error", w -> w.writeError("encoder_failed", "No H.264 encoder\n\"quoted\" é"));

        check("fit keeps the size without a limit", Arrays.equals(VideoSize.fit(1200, 1920, 0), new int[] {1200, 1920}));
        check("fit limits the long side", Arrays.equals(VideoSize.fit(1200, 1920, 1280), new int[] {800, 1280}));
        check("fit handles landscape", Arrays.equals(VideoSize.fit(1920, 1200, 1280), new int[] {1280, 800}));
        check("fit rounds down to multiples of 8", Arrays.equals(VideoSize.fit(1080, 2340, 1920), new int[] {880, 1920}));
        check("the next fallback is smaller", VideoSize.nextFallback(new int[] {1920, 1600, 1280}, 1920) == 1600);
        check("no fallback below the smallest", VideoSize.nextFallback(new int[] {1920, 1600}, 1600) == 0);

        Options options = Options.parse(new String[] {"1", "socket=stormcast_0000abcd", "max_size=1280"});
        check("options are parsed", options.socketName.equals("stormcast_0000abcd") && options.maxSize == 1280
                && options.bitRate == Options.DEFAULT_BIT_RATE && options.maxFps == 0);
        rejects("a protocol mismatch", new String[] {"2", "socket=x"});
        rejects("a missing socket", new String[] {"1"});
        rejects("an unknown option", new String[] {"1", "socket=x", "colour=red"});
        rejects("a negative number", new String[] {"1", "socket=x", "max_size=-1"});

        check("JSON escapes like JSON.stringify", Json.quote("a\"b\\c\u0001").equals("\"a\\\"b\\\\c\\u0001\""));

        if (failures > 0) {
            System.err.println(failures + " server test(s) failed");
            System.exit(1);
        }
        System.out.println("Server protocol tests passed");
    }

    private static void encodes(Map<String, String> vectors, String name, Write write) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        MessageWriter writer = new MessageWriter(bytes);
        write.to(writer);
        writer.flush();
        String expected = vectors.get(name);
        String actual = hex(bytes.toByteArray());
        check("vector " + name + " (expected " + expected + ", got " + actual + ")", actual.equals(expected));
    }

    private static void rejects(String what, String[] args) {
        try {
            Options.parse(args);
            check("options reject " + what, false);
        } catch (IllegalArgumentException e) {
            check("options reject " + what, true);
        }
    }

    private static void check(String what, boolean ok) {
        if (!ok) {
            failures++;
            System.err.println("FAIL " + what);
        }
    }

    private static Map<String, String> readVectors(String path) throws IOException {
        Map<String, String> vectors = new HashMap<>();
        for (String line : Files.readAllLines(Paths.get(path), StandardCharsets.UTF_8)) {
            int bar = line.indexOf('|');
            if (line.trim().startsWith("#") || bar < 0) {
                continue;
            }
            vectors.put(line.substring(0, bar).trim(), line.substring(bar + 1).replaceAll("\\s", ""));
        }
        return vectors;
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) {
            out.append(String.format("%02x", b & 0xff));
        }
        return out.toString();
    }
}
