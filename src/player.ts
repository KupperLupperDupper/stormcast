/**
 * Decodes the H.264 stream from the Rust side with WebCodecs (hardware decoding in
 * WebView2) and draws the newest frame on a canvas. Audio messages go to the AudioPlayer.
 *
 * Message layout, first byte is the tag (written by src-tauri/src/mirror.rs):
 *   0 hello    JSON { deviceName }
 *   1 session  u32 width, u32 height            (new capture session, e.g. rotation)
 *   2 config   u8 codec length, codec, SPS/PPS  (before the first key frame)
 *   3 frame    u8 flags (bit 0: key frame), u64 PTS in µs, data
 *   4 end      JSON { code, detail }
 *   5–7        audio, see src/audio.ts
 *   8 device state  u8 flags: 1 screen on, 2 locked, 4 unlocking needs a code (B-012)
 */

import { AudioPlayer, median, type AudioStats } from "./audio";

const MSG_HELLO = 0;
const MSG_SESSION = 1;
const MSG_CONFIG = 2;
const MSG_FRAME = 3;
const MSG_END = 4;
const MSG_AUDIO_CONFIG = 5;
const MSG_AUDIO = 6;
const MSG_AUDIO_OFF = 7;
const MSG_DEVICE_STATE = 8;
/** Drawn frames kept for the picture's timing. */
const TIMING_KEPT = 120;
/** Samples both sides need before the offset between sound and picture is reported. */
const MIN_TIMING_SAMPLES = 10;
const MAX_DECODER_ERRORS = 3;
/** waitForChange compares tiny copies of the picture, this many pixels square. */
const PROBE_SIZE = 16;
/** Mean difference per colour channel (0–255) that counts as a new picture, far above encoder noise. */
const CHANGE_THRESHOLD = 12;

export interface PlayerStats {
  codec: string | null;
  width: number;
  height: number;
  fps: number;
  /** Frames handed to the decoder. Far more than framesDecoded means the decoder holds frames back. */
  framesReceived: number;
  decodeQueue: number;
  framesDecoded: number;
  framesDropped: number;
  decoderErrors: number;
  firstFrameMs: number | null;
  audio: AudioStats;
  /**
   * How much later the sound is heard than the picture is drawn, from both sides' PTS on the
   * device's clock: positive when the sound is late. Null until both have played a while.
   */
  avOffsetMs: number | null;
}

export interface PlayerEvents {
  hello(deviceName: string): void;
  end(error: { code: string; detail: string }): void;
  /** Whether the screen is on and the device locked, as flags; see the message layout above. */
  deviceState(flags: number): void;
}

export class MirrorPlayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly events: PlayerEvents;
  private readonly utf8 = new TextDecoder();
  private decoder: VideoDecoder | null = null;
  private codec: string | null = null;
  private config: Uint8Array | null = null;
  private needConfig = true;
  private waitingForKeyFrame = true;
  private pending: VideoFrame | null = null;
  private raf = 0;
  private readonly startedAt = performance.now();
  private firstFrameMs: number | null = null;
  private framesReceived = 0;
  private framesDecoded = 0;
  private framesDropped = 0;
  private decoderErrors = 0;
  private drawTimes: number[] = [];
  private closed = false;
  private probe: OffscreenCanvasRenderingContext2D | null = null;
  private onDraw: (() => void) | null = null;
  /** Draw time minus PTS, in ms, of recent frames. */
  private readonly drawnMinusPts: number[] = [];
  readonly audio: AudioPlayer;

  constructor(canvas: HTMLCanvasElement, events: PlayerEvents, audio: AudioPlayer) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.canvas = canvas;
    this.ctx = ctx;
    this.events = events;
    this.audio = audio;
  }

  /** Handles one message from the Rust side. */
  handle(packet: unknown): void {
    if (this.closed) return;
    const bytes = toBytes(packet);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (bytes[0]) {
      case MSG_HELLO:
        this.events.hello(JSON.parse(this.utf8.decode(bytes.subarray(1))).deviceName);
        break;
      case MSG_SESSION:
        this.setSize(view.getUint32(1), view.getUint32(5));
        break;
      case MSG_CONFIG: {
        const end = 2 + bytes[1];
        this.configure(this.utf8.decode(bytes.subarray(2, end)), bytes.slice(end));
        break;
      }
      case MSG_FRAME:
        this.decode((bytes[1] & 1) === 1, Number(view.getBigUint64(2)), bytes.subarray(10));
        break;
      case MSG_AUDIO_CONFIG:
        this.audio.configure(view.getUint32(1), bytes[5]);
        break;
      case MSG_AUDIO:
        this.audio.push(Number(view.getBigUint64(1)), bytes.subarray(9), performance.now());
        break;
      case MSG_AUDIO_OFF:
        this.audio.off(bytes[1]);
        break;
      case MSG_DEVICE_STATE:
        this.events.deviceState(bytes[1]);
        break;
      case MSG_END:
        this.events.end(JSON.parse(this.utf8.decode(bytes.subarray(1))));
        break;
      default:
        console.warn(`Unknown message tag ${bytes[0]}`);
    }
  }

  stats(): PlayerStats {
    const now = performance.now();
    this.drawTimes = this.drawTimes.filter((time) => now - time < 1000);
    return {
      codec: this.codec,
      width: this.canvas.width,
      height: this.canvas.height,
      fps: this.drawTimes.length,
      framesReceived: this.framesReceived,
      decodeQueue: this.decoder?.decodeQueueSize ?? 0,
      framesDecoded: this.framesDecoded,
      framesDropped: this.framesDropped,
      decoderErrors: this.decoderErrors,
      firstFrameMs: this.firstFrameMs === null ? null : Math.round(this.firstFrameMs),
      audio: this.audio.stats(),
      avOffsetMs: this.avOffset(),
    };
  }

  /**
   * Resolves with the time the drawn picture first clearly differs from the current one, or with
   * null after timeoutMs. The smoke test times input to picture with it.
   */
  waitForChange(timeoutMs: number): Promise<number | null> {
    const before = this.thumbnail();
    return new Promise((resolve) => {
      const finish = (time: number | null) => {
        window.clearTimeout(timer);
        this.onDraw = null;
        resolve(time);
      };
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      this.onDraw = () => {
        if (difference(before, this.thumbnail()) >= CHANGE_THRESHOLD) finish(performance.now());
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    this.pending?.close();
    this.pending = null;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
    this.audio.close();
  }

  private avOffset(): number | null {
    const audio = this.audio.timing();
    if (audio.length < MIN_TIMING_SAMPLES || this.drawnMinusPts.length < MIN_TIMING_SAMPLES) return null;
    // The clock offset between device and PC is in both, so it cancels out.
    return Math.round((median(audio) ?? 0) - (median(this.drawnMinusPts) ?? 0));
  }

  /**
   * Sizes the canvas before the first frame, so the layout does not jump (LAY-02), and tells the
   * CSS the picture's aspect ratio, so it fits the view (B-011).
   */
  private setSize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.setProperty("--video-aspect", `${width} / ${height}`);
  }

  private configure(codec: string, config: Uint8Array): void {
    this.codec = codec;
    this.config = config;
    this.createDecoder();
  }

  private createDecoder(): void {
    if (!this.codec) return;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (error) => this.onDecoderError(error),
    });
    // No `description`: the stream is Annex B, so SPS/PPS go in-band before the key frame.
    this.decoder.configure({ codec: this.codec, optimizeForLatency: true });
    this.needConfig = true;
    this.waitingForKeyFrame = true;
  }

  private decode(keyFrame: boolean, pts: number, data: Uint8Array): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    if (this.waitingForKeyFrame && !keyFrame) {
      this.framesDropped++;
      return;
    }
    this.waitingForKeyFrame = false;
    let payload = data;
    if (this.needConfig && this.config) {
      payload = new Uint8Array(this.config.length + data.length);
      payload.set(this.config);
      payload.set(data, this.config.length);
      this.needConfig = false;
    }
    this.framesReceived++;
    decoder.decode(new EncodedVideoChunk({ type: keyFrame ? "key" : "delta", timestamp: pts, data: payload }));
  }

  private onFrame(frame: VideoFrame): void {
    if (this.closed) {
      frame.close();
      return;
    }
    this.framesDecoded++;
    this.firstFrameMs ??= performance.now() - this.startedAt;
    // The newest frame wins: a frame that was never drawn is dropped, which keeps latency low.
    if (this.pending) {
      this.pending.close();
      this.framesDropped++;
    }
    this.pending = frame;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.raf = 0;
    const frame = this.pending;
    this.pending = null;
    if (!frame) return;
    if (this.closed) {
      frame.close();
      return;
    }
    this.setSize(frame.displayWidth, frame.displayHeight);
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    const drawnAt = performance.now();
    this.drawnMinusPts.push(drawnAt - frame.timestamp / 1000);
    if (this.drawnMinusPts.length > TIMING_KEPT) this.drawnMinusPts.shift();
    frame.close();
    this.drawTimes.push(drawnAt);
    if (this.drawTimes.length > 240) this.drawTimes.splice(0, 120);
    this.onDraw?.();
  }

  private thumbnail(): Uint8ClampedArray {
    this.probe ??= new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE).getContext("2d", { willReadFrequently: true });
    if (!this.probe) throw new Error("Canvas 2D is not available");
    this.probe.drawImage(this.canvas, 0, 0, PROBE_SIZE, PROBE_SIZE);
    return this.probe.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data;
  }

  private onDecoderError(error: DOMException): void {
    this.decoderErrors++;
    console.error("Video decoder error", error);
    if (this.decoderErrors > MAX_DECODER_ERRORS) {
      this.events.end({ code: "decoder", detail: `${error.name}: ${error.message}` });
      return;
    }
    // Start over at the next key frame with the stored SPS/PPS.
    this.createDecoder();
  }
}

/** Mean absolute difference of the red, green and blue values of two RGBA pictures. */
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((a.length / 4) * 3);
}

function toBytes(packet: unknown): Uint8Array {
  if (packet instanceof ArrayBuffer) return new Uint8Array(packet);
  if (ArrayBuffer.isView(packet)) return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
  if (Array.isArray(packet)) return Uint8Array.from(packet as number[]);
  throw new Error(`Unexpected packet type: ${Object.prototype.toString.call(packet)}`);
}
