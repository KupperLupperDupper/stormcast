package com.stormitron.stormcast.server;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * Checks the server's encoding and decoding against protocol/vectors.txt, which the Rust tests
 * read too, and the plain-Java helpers. Runs on the JVM without Android:
 * java ProtocolTest path/to/vectors.txt
 */
public final class ProtocolTest {
    private interface Write {
        void to(MessageWriter writer) throws IOException;
    }

    private static final byte[] CONFIG = {0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, (byte) 0xac, 0x2b, 0x40, 0x3c,
            0, 0, 0, 1, 0x68, (byte) 0xee, 0x3c, (byte) 0x80};
    private static final byte[] KEY_FRAME = {0, 0, 0, 1, 0x65, (byte) 0x88};
    private static final byte[] DELTA_FRAME = {0, 0, 0, 1, 0x41, (byte) 0x9a};
    /** Two stereo frames, little-endian: 1, -1, -32768, 32767. */
    private static final byte[] SAMPLES = {1, 0, (byte) 0xff, (byte) 0xff, 0, (byte) 0x80, (byte) 0xff, 0x7f};
    private static final String VERSION = String.valueOf(Protocol.VERSION);

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
        encodes(vectors, "clipboard", w -> w.writeClipboard("Hej på dig".getBytes(StandardCharsets.UTF_8)));
        encodes(vectors, "audio_config", w -> w.writeAudioConfig(Protocol.AUDIO_CODEC_PCM_S16LE, 48000, 2));
        encodes(vectors, "audio", w -> w.writeAudio(1_234_600L, SAMPLES, 0, SAMPLES.length));
        encodes(vectors, "audio_off", w -> w.writeAudioOff(Protocol.AUDIO_OFF_UNSUPPORTED));

        decodes(vectors, "touch_down", "touch down pointer 1 at 600,960 on 1200x1920 pressure 1.0");
        decodes(vectors, "touch_up", "touch up pointer 4294967294 at 1199,0 on 1200x1920 pressure 0.5");
        decodes(vectors, "key_down", "key down keycode 29 repeat 2 meta 0x3000");
        decodes(vectors, "key_up", "key up keycode 66 repeat 0 meta 0x0");
        decodes(vectors, "text", "text \"Hi é😀\"");
        decodes(vectors, "button_back", "button back");
        decodes(vectors, "button_home", "button home");
        decodes(vectors, "button_recent_apps", "button recent apps");
        decodes(vectors, "button_power", "button power");
        decodes(vectors, "scroll", "scroll at 600,960 on 1200x1920 by 0.25,-1.0");
        decodes(vectors, "set_clipboard", "set clipboard and paste \"Hej på dig\"");
        decodes(vectors, "set_audio_on", "audio on");
        decodes(vectors, "set_audio_off", "audio off");
        readsControlStreams(unhex(vectors.get("button_home")));
        tracksFingers();
        timesAudio();

        Geometry geometry = new Geometry(800, 1280, 1200, 1920);
        check("positions scale to the middle of the display pixels",
                geometry.displayX(0) == 0.75f && geometry.displayY(1279) == 1919.25f);
        check("a rotated video does not match", geometry.matches(800, 1280) && !geometry.matches(1280, 800));

        check("fit keeps the size without a limit", Arrays.equals(VideoSize.fit(1200, 1920, 0), new int[] {1200, 1920}));
        check("fit limits the long side", Arrays.equals(VideoSize.fit(1200, 1920, 1280), new int[] {800, 1280}));
        check("fit handles landscape", Arrays.equals(VideoSize.fit(1920, 1200, 1280), new int[] {1280, 800}));
        check("fit rounds down to multiples of 8", Arrays.equals(VideoSize.fit(1080, 2340, 1920), new int[] {880, 1920}));
        check("the next fallback is smaller", VideoSize.nextFallback(new int[] {1920, 1600, 1280}, 1920) == 1600);
        check("no fallback below the smallest", VideoSize.nextFallback(new int[] {1920, 1600}, 1600) == 0);

        Options options = Options.parse(new String[] {VERSION, "socket=stormcast_0000abcd", "max_size=1280"});
        check("options are parsed", options.socketName.equals("stormcast_0000abcd") && options.maxSize == 1280
                && options.bitRate == Options.DEFAULT_BIT_RATE && options.maxFps == 0);
        rejects("a protocol mismatch", new String[] {"1", "socket=x"});
        rejects("a missing socket", new String[] {VERSION});
        rejects("an unknown option", new String[] {VERSION, "socket=x", "colour=red"});
        rejects("a negative number", new String[] {VERSION, "socket=x", "max_size=-1"});
        check("audio and the test tone are off by default", !options.audio && !options.tone);
        options = Options.parse(new String[] {VERSION, "socket=x", "audio=1", "tone=1"});
        check("audio and the test tone can be turned on", options.audio && options.tone);
        rejects("a flag that is not 0 or 1", new String[] {VERSION, "socket=x", "audio=yes"});

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

    /** The vector is one whole control message, and it reads as expected. */
    private static void decodes(Map<String, String> vectors, String name, String expected) throws IOException {
        ControlReader reader = new ControlReader(new ByteArrayInputStream(unhex(vectors.get(name))));
        ControlMessage message = reader.next();
        String actual = String.valueOf(message);
        check("vector " + name + " (expected " + expected + ", got " + actual + ")",
                actual.equals(expected) && reader.next() == null);
    }

    /** Unknown types and short payloads are skipped; an oversized length is a broken stream. */
    private static void readsControlStreams(byte[] home) throws IOException {
        ByteArrayOutputStream stream = new ByteArrayOutputStream();
        stream.write(new byte[] {99, 0, 0, 0, 2, 1, 2}); // a type from a newer app
        stream.write(new byte[] {Protocol.TYPE_TOUCH, 0, 0, 0, 1, 0}); // too short
        stream.write(new byte[] {Protocol.TYPE_BUTTON, 0, 0, 0, 1, 4}); // no such button
        stream.write(new byte[] {Protocol.TYPE_BUTTON, 0, 0, 0, 2, 2, 9}); // a newer app's extra byte
        stream.write(home);
        ControlReader reader = new ControlReader(new ByteArrayInputStream(stream.toByteArray()));
        check("the reader skips what it cannot use", String.valueOf(reader.next()).equals("button recent apps")
                && String.valueOf(reader.next()).equals("button home") && reader.next() == null);

        reader = new ControlReader(new ByteArrayInputStream(new byte[] {Protocol.TYPE_TEXT, 0, 1, 0, 1}));
        try {
            reader.next();
            check("the reader refuses an oversized message", false);
        } catch (IOException e) {
            check("the reader refuses an oversized message", true);
        }
    }

    private static void tracksFingers() {
        TouchPointers fingers = new TouchPointers();
        check("the first finger is a down", fingers.down(7, 1, 2, 1) == TouchPointers.ACTION_DOWN);
        fingers.removeLifted();
        check("the second finger is a pointer down at index 1",
                fingers.down(9, 3, 4, 1) == (TouchPointers.ACTION_POINTER_DOWN | 1 << 8));
        check("a finger that is down cannot go down again", fingers.isDown(9) && fingers.down(9, 0, 0, 1) == TouchPointers.NONE);
        check("a finger moves", fingers.move(7, 5, 6, 1) == TouchPointers.ACTION_MOVE && fingers.x(0) == 5);
        check("an unknown finger is ignored", fingers.move(8, 0, 0, 1) == TouchPointers.NONE);
        check("the first finger up is a pointer up at index 0",
                fingers.up(7, 5, 6, 1) == TouchPointers.ACTION_POINTER_UP && fingers.size() == 2);
        fingers.removeLifted();
        check("the second finger keeps its id", fingers.size() == 1 && fingers.localId(0) == 1);
        check("a new finger reuses the free id",
                fingers.down(11, 0, 0, 1) == (TouchPointers.ACTION_POINTER_DOWN | 1 << 8) && fingers.localId(1) == 0);
        check("cancel ends every finger", fingers.cancel() == TouchPointers.ACTION_CANCEL);
        fingers.removeLifted();
        check("nothing is left to cancel", fingers.size() == 0 && fingers.cancel() == TouchPointers.NONE);
        check("the last finger up is an up", fingers.down(1, 0, 0, 1) == TouchPointers.ACTION_DOWN
                && fingers.up(1, 0, 0, 0) == TouchPointers.ACTION_UP);
        fingers.removeLifted();
        for (int i = 0; i < TouchPointers.MAX; i++) {
            fingers.down(100 + i, 0, 0, 1);
        }
        check("at most " + TouchPointers.MAX + " fingers", fingers.down(200, 0, 0, 1) == TouchPointers.NONE);
    }

    /** PTS that count frames, follow AudioRecord's timestamps slowly, jump after a pause and never go back. */
    private static void timesAudio() {
        AudioTiming timing = new AudioTiming(48000);
        long none = AudioTiming.NO_TIMESTAMP;
        check("a first block without a timestamp ends now", timing.next(1024, 0, none, 1_000_000) == 978_667);
        check("the next block without a timestamp follows it", timing.next(1024, 0, none, 1_021_333) == 1_000_000);

        timing = new AudioTiming(48000);
        // Frame 1024 was captured at 2 s: the block of frames 0 to 1023 starts 1024 frames earlier.
        check("a timestamp dates the first block", timing.next(1024, 1024, 2_000_000_000L, 0) == 1_978_667);
        check("a matching timestamp keeps the count", timing.next(1024, 2048, 2_021_333_333L, 0) == 2_000_000);
        // This timestamp is 32 ms later than the count: a sixteenth of that moves the PTS.
        check("a jumpy timestamp moves the PTS slowly", timing.next(1024, 3072, 2_074_666_666L, 0) == 2_023_333);
        check("a timestamp after a pause jumps ahead", timing.next(1024, 4096, 9_000_000_000L, 0) == 8_978_667);
        check("PTS never go back", timing.next(1024, 0, 1_000_000_000L, 0) == 8_978_668);
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

    private static byte[] unhex(String hex) {
        byte[] bytes = new byte[hex.length() / 2];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
        }
        return bytes;
    }
}
