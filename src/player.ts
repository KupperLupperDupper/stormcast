/**
 * Decodes the H.264 stream from the Rust side with WebCodecs (hardware decoding in
 * WebView2) and draws the newest frame on a canvas.
 *
 * Message layout, first byte is the tag (written by src-tauri/src/mirror.rs):
 *   0 hello    JSON { deviceName }
 *   1 session  u32 width, u32 height            (new capture session, e.g. rotation)
 *   2 config   u8 codec length, codec, SPS/PPS  (before the first key frame)
 *   3 frame    u8 flags (bit 0: key frame), u64 PTS in µs, data
 *   4 end      JSON { code, detail }
 */

const MSG_HELLO = 0;
const MSG_SESSION = 1;
const MSG_CONFIG = 2;
const MSG_FRAME = 3;
const MSG_END = 4;
const MAX_DECODER_ERRORS = 3;

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
}

export interface PlayerEvents {
  hello(deviceName: string): void;
  end(error: { code: string; detail: string }): void;
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

  constructor(canvas: HTMLCanvasElement, events: PlayerEvents) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.canvas = canvas;
    this.ctx = ctx;
    this.events = events;
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
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    this.pending?.close();
    this.pending = null;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  /** Sizes the canvas before the first frame, so the layout does not jump (LAY-02). */
  private setSize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
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
    frame.close();
    this.drawTimes.push(performance.now());
    if (this.drawTimes.length > 240) this.drawTimes.splice(0, 120);
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

function toBytes(packet: unknown): Uint8Array {
  if (packet instanceof ArrayBuffer) return new Uint8Array(packet);
  if (ArrayBuffer.isView(packet)) return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
  if (Array.isArray(packet)) return Uint8Array.from(packet as number[]);
  throw new Error(`Unexpected packet type: ${Object.prototype.toString.call(packet)}`);
}
