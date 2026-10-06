import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";
import { appendJsonl, readJsonl } from "../state.js";
import { readChannelValues } from "./channels.js";
import type { Device } from "./registry.js";

export const MIN_INTERVAL_MS = 1000;
export const MAX_DURATION_S = 24 * 3600;
export const MAX_ACTIVE_PER_DEVICE = 3;
/** Samples kept in memory per recording; the full recording is in the state directory. */
const MAX_IN_MEMORY = 10_000;
const TRANSIENT_CODES = new Set<number>([
  DeviceErrorCode.BUSY,
  ServerErrorCode.UNREACHABLE,
  ServerErrorCode.TIMEOUT,
]);

export type RecordingStatus = "running" | "finished" | "stopped" | "failed";

export interface Sample {
  t: string;
  values: Record<string, number | null>;
  errors?: Record<string, string>;
}

interface Header {
  type: "header";
  id: string;
  device: string;
  channels: string[];
  interval_ms: number;
  started_at: string;
  ends_at: string;
}

interface Footer {
  type: "end";
  status: RecordingStatus;
  at: string;
  error?: string;
}

interface Recording {
  header: Header;
  status: RecordingStatus;
  error?: string;
  samples: Sample[];
  /** Samples dropped from memory (still in the file); keeps sample indexes stable. */
  dropped: number;
  timer?: NodeJS.Timeout;
  busy: boolean;
}

export interface RecordingView {
  id: string;
  device: string;
  channels: string[];
  interval_ms: number;
  started_at: string;
  ends_at: string;
  status: RecordingStatus;
  error?: string;
  count: number;
}

/**
 * Server-side recordings: polls the given channels at a fixed interval and stores the values in
 * the state directory. Nothing is changed on the device; reading uses the normal request queue.
 */
export class Sampler {
  private readonly recordings = new Map<string, Recording>();

  constructor(
    private readonly device: Device,
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(channels: string[], intervalMs: number, durationS: number): RecordingView {
    if (intervalMs < MIN_INTERVAL_MS) {
      throw invalid(`interval_ms must be at least ${MIN_INTERVAL_MS}`);
    }
    if (durationS <= 0 || durationS > MAX_DURATION_S) {
      throw invalid(`duration_s must be between 1 and ${MAX_DURATION_S}`);
    }
    const active = [...this.recordings.values()].filter((r) => r.status === "running");
    if (active.length >= MAX_ACTIVE_PER_DEVICE) {
      throw invalid(
        `At most ${MAX_ACTIVE_PER_DEVICE} recordings may run per device; stop one first`,
      );
    }

    const started = this.now();
    const header: Header = {
      type: "header",
      id: randomUUID().slice(0, 8),
      device: this.device.alias,
      channels,
      interval_ms: intervalMs,
      started_at: started.toISOString(),
      ends_at: new Date(started.getTime() + durationS * 1000).toISOString(),
    };
    const recording: Recording = {
      header,
      status: "running",
      samples: [],
      dropped: 0,
      busy: false,
    };
    this.recordings.set(header.id, recording);
    void appendJsonl(this.file(header.id), [header]).catch((error: unknown) =>
      this.fail(recording, error),
    );

    const timer = setInterval(() => void this.tick(recording), intervalMs);
    timer.unref();
    recording.timer = timer;
    void this.tick(recording);
    return view(recording);
  }

  /** Samples from `sinceIndex` on (0-based); falls back to the file for earlier processes' recordings. */
  async read(
    id: string,
    sinceIndex: number,
    limit: number,
  ): Promise<{ recording: RecordingView; samples: Sample[]; nextIndex: number; more: boolean }> {
    let recording = this.recordings.get(id) ?? (await this.loadFromFile(id));
    if (sinceIndex < recording.dropped) recording = await this.loadFromFile(id);
    const start = sinceIndex - recording.dropped;
    const samples = recording.samples.slice(start, start + limit);
    const nextIndex = sinceIndex + samples.length;
    return {
      recording: view(recording),
      samples,
      nextIndex,
      more: nextIndex < recording.dropped + recording.samples.length,
    };
  }

  async stop(id: string): Promise<RecordingView> {
    const recording = this.recordings.get(id);
    if (recording === undefined) {
      const stored = await this.loadFromFile(id);
      return view(stored);
    }
    if (recording.status === "running") await this.finish(recording, "stopped");
    return view(recording);
  }

  list(): RecordingView[] {
    return [...this.recordings.values()].map(view);
  }

  private async tick(recording: Recording): Promise<void> {
    if (recording.status !== "running" || recording.busy) return;
    if (this.now().getTime() >= Date.parse(recording.header.ends_at)) {
      await this.finish(recording, "finished");
      return;
    }
    recording.busy = true;
    try {
      const sample = await this.sample(recording.header.channels);
      if (recording.status !== "running") return;
      recording.samples.push(sample);
      if (recording.samples.length > MAX_IN_MEMORY) {
        recording.samples.shift();
        recording.dropped++;
      }
      await appendJsonl(this.file(recording.header.id), [sample]);
    } catch (error) {
      // Anything but a short outage (auth, permission, bad channel) would just repeat: give up.
      await this.fail(recording, error);
    } finally {
      recording.busy = false;
    }
  }

  private async sample(channels: string[]): Promise<Sample> {
    const t = this.now().toISOString();
    try {
      const { entries } = await readChannelValues(this.device, channels);
      const values: Record<string, number | null> = {};
      const errors: Record<string, string> = {};
      for (const entry of entries) {
        values[entry.channel] = entry.value ?? null;
        if (entry.error !== undefined) errors[entry.channel] = entry.error;
      }
      return Object.keys(errors).length > 0 ? { t, values, errors } : { t, values };
    } catch (error) {
      if (!(error instanceof WebspsError) || !TRANSIENT_CODES.has(error.code)) throw error;
      // Keep recording through short outages; the gap is visible in the data.
      const message = `${error.errorName}: ${error.message}`;
      return {
        t,
        values: Object.fromEntries(channels.map((c) => [c, null])),
        errors: Object.fromEntries(channels.map((c) => [c, message])),
      };
    }
  }

  private async finish(recording: Recording, status: RecordingStatus, error?: string) {
    clearInterval(recording.timer);
    recording.status = status;
    if (error !== undefined) recording.error = error;
    const footer: Footer = {
      type: "end",
      status,
      at: this.now().toISOString(),
      ...(error !== undefined && { error }),
    };
    await appendJsonl(this.file(recording.header.id), [footer]).catch(() => undefined);
  }

  private fail(recording: Recording, error: unknown): Promise<void> {
    const message =
      error instanceof WebspsError ? `${error.errorName}: ${error.message}` : String(error);
    return this.finish(recording, "failed", message);
  }

  private async loadFromFile(id: string): Promise<Recording> {
    if (!/^[0-9a-f]{8}$/.test(id)) throw unknownRecording(id);
    const lines = await readJsonl<Header | Footer | Sample>(this.file(id));
    const header = lines.find((l): l is Header => "type" in l && l.type === "header");
    if (header === undefined) throw unknownRecording(id);
    const footer = lines.find((l): l is Footer => "type" in l && l.type === "end");
    const samples = lines.filter((l): l is Sample => !("type" in l));
    // No footer: the recording was cut off by a server restart.
    const recording: Recording = {
      header,
      status: footer?.status ?? "stopped",
      samples,
      dropped: 0,
      busy: false,
    };
    if (footer?.error !== undefined) recording.error = footer.error;
    else if (footer === undefined) recording.error = "server process ended during the recording";
    return recording;
  }

  private file(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }
}

function view(recording: Recording): RecordingView {
  const { type: _type, ...header } = recording.header;
  return {
    ...header,
    status: recording.status,
    ...(recording.error !== undefined && { error: recording.error }),
    count: recording.dropped + recording.samples.length,
  };
}

function invalid(message: string): WebspsError {
  return new WebspsError(ServerErrorCode.INVALID_INPUT, message);
}

function unknownRecording(id: string): WebspsError {
  return new WebspsError(ServerErrorCode.INVALID_INPUT, `Unknown recording id "${id}"`);
}
