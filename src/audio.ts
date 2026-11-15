/**
 * Plays the device's sound with Web Audio (docs/PROTOCOL.md, audio). Blocks of PCM are scheduled
 * back to back on the audio clock, a little ahead of now. The lead absorbs uneven arrival: it grows
 * after an underrun, up to a limit, and a block that would play far behind is dropped, so the delay
 * stays low. Each block's audible time is known, which lets the player measure how far the sound is
 * from the picture.
 *
 * Messages from src-tauri/src/mirror.rs, after the tag:
 *   5 audio config  u32 sample rate, u8 channels
 *   6 audio         u64 PTS in µs (the clock of the video's PTS), PCM s16le, channels interleaved
 *   7 audio off     u8 reason
 */

export type AudioState = "off" | "starting" | "playing" | "unsupported" | "refused" | "failed";

/** Audio off reasons by number (docs/PROTOCOL.md). */
const OFF_REASONS: readonly AudioState[] = ["off", "unsupported", "refused", "failed"];

const INITIAL_LEAD_S = 0.02;
const LEAD_STEP_S = 0.01;
const MAX_LEAD_S = 0.12;
/** A block that would start less than this ahead of now comes too late: an underrun. */
const MIN_LEAD_S = 0.002;
/**
 * A block this much beyond the lead is dropped, to catch up. Blocks pile up like that while the
 * audio clock starts, and they would otherwise delay the sound for the rest of the session.
 */
const CATCH_UP_S = 0.025;
/** A gap in the PTS this long is a pause on the device, not an underrun. */
const PAUSE_US = 30_000;
const FADE_S = 0.01;
const SAMPLES_KEPT = 200;

export interface AudioStats {
  state: AudioState;
  context: AudioContextState | "none";
  sampleRate: number;
  blocksReceived: number;
  blocksPlayed: number;
  underruns: number;
  dropped: number;
  leadMs: number;
  bufferedMs: number;
  /** From the audio clock to the speaker, as the web view reports it. */
  outputMs: number | null;
  /** Median time from a block's arrival to when it is heard. */
  delayMs: number | null;
  /** The loudest sample so far, from 0 to 1. */
  peak: number;
  /** Times the device said capture stopped because the app turned it off. */
  stops: number;
}

export class AudioPlayer {
  private readonly onState: (state: AudioState) => void;
  private enabled: boolean;
  private state: AudioState;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private sampleRate = 0;
  private channels = 0;
  private lead = INITIAL_LEAD_S;
  /** Audio clock time where the next block starts; 0 when nothing is scheduled. */
  private nextTime = 0;
  private nextPts = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private blocksReceived = 0;
  private blocksPlayed = 0;
  private underruns = 0;
  private dropped = 0;
  private peak = 0;
  private stops = 0;
  /** Heard time minus PTS, in ms: the delay plus the offset between the device's and the PC's clocks. */
  private readonly heardMinusPts: number[] = [];
  private readonly delays: number[] = [];
  private closed = false;
  private readonly resumeOnGesture = () => void this.ctx?.resume().catch(() => undefined);

  constructor(enabled: boolean, onState: (state: AudioState) => void) {
    this.enabled = enabled;
    this.state = enabled ? "starting" : "off";
    this.onState = onState;
  }

  get current(): AudioState {
    return this.state;
  }

  /** Turns the sound on the PC on or off. Off is silent at once; the device stops soon after. */
  setEnabled(on: boolean): void {
    if (this.closed || on === this.enabled) return;
    this.enabled = on;
    if (!on) this.silence();
    this.setState(on ? "starting" : "off");
  }

  configure(sampleRate: number, channels: number): void {
    if (this.closed) return;
    this.silence();
    this.sampleRate = sampleRate;
    this.channels = channels;
    const ctx = this.context();
    if (ctx && this.gain) {
      this.gain.gain.cancelScheduledValues(0);
      this.gain.gain.setValueAtTime(1, ctx.currentTime);
    }
  }

  /** Schedules one block. `arrivedAt` is performance.now() when it reached the web view. */
  push(pts: number, bytes: Uint8Array, arrivedAt: number): void {
    if (this.closed || !this.enabled || this.channels === 0) return;
    const ctx = this.ctx;
    const gain = this.gain;
    if (!ctx || !gain) return;
    this.blocksReceived++;
    const frames = Math.floor(bytes.byteLength / (2 * this.channels));
    if (frames === 0) return;
    const buffer = ctx.createBuffer(this.channels, frames, this.sampleRate);
    this.decode(bytes, frames, buffer);
    if (ctx.state !== "running") {
      // Nothing plays yet (the web view waits for a click): keep no backlog.
      this.nextTime = 0;
      return;
    }

    const duration = frames / this.sampleRate;
    const now = ctx.currentTime;
    let start = this.nextTime;
    const paused = this.nextPts > 0 && pts - this.nextPts > PAUSE_US;
    if (this.nextTime === 0 || paused || start - now < MIN_LEAD_S) {
      if (this.nextTime > 0 && !paused) {
        this.underruns++;
        this.lead = Math.min(MAX_LEAD_S, this.lead + LEAD_STEP_S);
      }
      start = now + this.lead;
    } else if (start - now > this.lead + CATCH_UP_S) {
      this.dropped++;
      this.nextPts = pts + duration * 1e6;
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start(start);
    this.nextTime = start + duration;
    this.nextPts = pts + duration * 1e6;
    this.blocksPlayed++;
    if (this.state === "starting") this.setState("playing");

    // When the block will be heard, on the clock of performance.now().
    const stamp = ctx.getOutputTimestamp();
    if (stamp.performanceTime && stamp.contextTime !== undefined) {
      const heardAt = stamp.performanceTime + (start - stamp.contextTime) * 1000;
      keep(this.heardMinusPts, heardAt - pts / 1000);
      keep(this.delays, heardAt - arrivedAt);
    }
  }

  /** The device stopped capture. */
  off(reason: number): void {
    if (this.closed) return;
    this.silence();
    const state = OFF_REASONS[reason] ?? "failed";
    if (state === "off") this.stops++;
    // A stop the app asked for comes after it, so it may belong to an earlier toggle.
    if (state === "off" && this.enabled) return;
    this.setState(state);
  }

  /** Recent values of heard time minus PTS, in ms, to compare with the picture. */
  timing(): readonly number[] {
    return this.heardMinusPts;
  }

  stats(): AudioStats {
    const ctx = this.ctx;
    return {
      state: this.state,
      context: ctx?.state ?? "none",
      sampleRate: this.sampleRate,
      blocksReceived: this.blocksReceived,
      blocksPlayed: this.blocksPlayed,
      underruns: this.underruns,
      dropped: this.dropped,
      leadMs: Math.round(this.lead * 1000),
      bufferedMs: ctx && this.nextTime > 0 ? Math.max(0, Math.round((this.nextTime - ctx.currentTime) * 1000)) : 0,
      outputMs: ctx ? Math.round((ctx.baseLatency + (ctx.outputLatency ?? 0)) * 1000) : null,
      delayMs: roundOrNull(median(this.delays)),
      peak: Math.round(this.peak * 1000) / 1000,
      stops: this.stops,
    };
  }

  close(): void {
    if (this.closed) return;
    this.silence();
    this.closed = true;
    document.removeEventListener("pointerdown", this.resumeOnGesture, true);
    document.removeEventListener("keydown", this.resumeOnGesture, true);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.gain = null;
  }

  private setState(state: AudioState) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }

  /** The context, made at the first audio config. It runs at the device's rate, so blocks join without resampling. */
  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext({ latencyHint: "interactive", sampleRate: this.sampleRate });
    } catch (error) {
      console.warn(`No audio context at ${this.sampleRate} Hz; using the default rate`, error);
      try {
        this.ctx = new AudioContext({ latencyHint: "interactive" });
      } catch (fallbackError) {
        console.error("Web Audio is not available", fallbackError);
        this.setState("failed");
        return null;
      }
    }
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    if (this.ctx.state !== "running") {
      // Without a click in this window yet, the web view may hold sound back until the next one.
      void this.ctx.resume().catch(() => undefined);
      document.addEventListener("pointerdown", this.resumeOnGesture, true);
      document.addEventListener("keydown", this.resumeOnGesture, true);
    }
    return this.ctx;
  }

  /** Copies interleaved 16-bit little-endian samples into the buffer's channels. */
  private decode(bytes: Uint8Array, frames: number, buffer: AudioBuffer) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2 * this.channels);
    const outputs = Array.from({ length: this.channels }, (_, channel) => buffer.getChannelData(channel));
    let peak = this.peak;
    let offset = 0;
    for (let frame = 0; frame < frames; frame++) {
      for (const output of outputs) {
        const sample = view.getInt16(offset, true) / 32768;
        output[frame] = sample;
        peak = Math.max(peak, Math.abs(sample));
        offset += 2;
      }
    }
    this.peak = peak;
  }

  /** Fades out what is scheduled and forgets the schedule. */
  private silence() {
    const ctx = this.ctx;
    const gain = this.gain;
    if (ctx && gain) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      for (const source of this.sources) source.stop(now + FADE_S);
    }
    this.sources.clear();
    this.nextTime = 0;
    this.nextPts = 0;
  }
}

function keep(values: number[], value: number) {
  values.push(value);
  if (values.length > SAMPLES_KEPT) values.splice(0, values.length - SAMPLES_KEPT);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const roundOrNull = (value: number | null) => (value === null ? null : Math.round(value));
