import { appendJsonl, readJsonl, writeJsonl } from "../state.js";
import type { DeviceClient } from "./client.js";

/** The device keeps only the last 25 console lines. */
export const DEVICE_LOG_CAPACITY = 25;
const MAX_STORED = 5000;

interface DeviceLogEntry {
  seq: number;
  timestamp: string;
  message: string;
}

export interface StoredLogEntry {
  /** Position in the accumulated log; the cursor for `since_cursor`. Survives device restarts. */
  pos: number;
  seq: number;
  /** Device time of day as reported by the device. */
  time: string;
  message: string;
  /** Server time when the line was fetched. */
  received_at: string;
}

export interface PollResult {
  /** Lines were lost between two polls (more than 25 new lines in between). */
  gap: boolean;
  /** The sequence numbers restarted, i.e. the device rebooted since the last poll. */
  restarted: boolean;
}

/**
 * Accumulates the device console (25-line ring buffer) into a longer log in the state directory.
 * New lines are only fetched when the log is read; the `seq` numbers reveal lost lines.
 */
export class ConsoleLog {
  private entries: StoredLogEntry[] | undefined;
  private lastSeq: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: DeviceClient,
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Fetches the device buffer and appends lines not seen yet. Serialized per device. */
  poll(): Promise<PollResult> {
    const run = this.chain.then(() => this.pollOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  async read(options: {
    sinceCursor?: number | undefined;
    grep?: string | undefined;
    limit: number;
  }): Promise<{ entries: StoredLogEntry[]; nextCursor: number; more: boolean }> {
    const all = await this.load();
    const needle = options.grep?.toLowerCase();
    const matching = all.filter(
      (e) =>
        (options.sinceCursor === undefined || e.pos > options.sinceCursor) &&
        (needle === undefined || e.message.toLowerCase().includes(needle)),
    );
    // Without a cursor: the most recent lines. With a cursor: continue in order from there.
    const entries =
      options.sinceCursor === undefined
        ? matching.slice(-options.limit)
        : matching.slice(0, options.limit);
    const lastPos = all.at(-1)?.pos ?? 0;
    const nextCursor =
      options.sinceCursor === undefined || entries.length === matching.length
        ? lastPos
        : (entries.at(-1)?.pos ?? options.sinceCursor);
    return { entries, nextCursor, more: entries.length < matching.length };
  }

  private async pollOnce(): Promise<PollResult> {
    // Re-read the file: another server process for the same device may have appended to it.
    this.entries = undefined;
    const entries = await this.load();
    const result = await this.client.call<{ entries?: DeviceLogEntry[] }>("system.log", {
      limit: DEVICE_LOG_CAPACITY,
    });
    const fetched = [...(result.entries ?? [])].sort((a, b) => a.seq - b.seq);
    const newest = fetched.at(-1)?.seq;

    let fresh = fetched;
    let restarted = false;
    let gap = false;
    if (this.lastSeq !== undefined && newest !== undefined) {
      if (newest < this.lastSeq) {
        restarted = true;
      } else {
        const last = this.lastSeq;
        fresh = fetched.filter((e) => e.seq > last);
        const oldestFresh = fresh[0]?.seq;
        gap = oldestFresh !== undefined && oldestFresh > last + 1;
      }
    }
    if (fresh.length === 0) return { gap, restarted };

    let pos = entries.at(-1)?.pos ?? 0;
    const receivedAt = this.now().toISOString();
    const stored = fresh.map((e) => ({
      pos: ++pos,
      seq: e.seq,
      time: e.timestamp,
      message: e.message,
      received_at: receivedAt,
    }));
    entries.push(...stored);
    this.lastSeq = newest;

    if (entries.length > MAX_STORED * 1.2) {
      entries.splice(0, entries.length - MAX_STORED);
      await writeJsonl(this.file, entries);
    } else {
      await appendJsonl(this.file, stored);
    }
    return { gap, restarted };
  }

  private async load(): Promise<StoredLogEntry[]> {
    if (this.entries === undefined) {
      this.entries = await readJsonl<StoredLogEntry>(this.file);
      this.lastSeq = this.entries.at(-1)?.seq;
    }
    return this.entries;
  }
}
