import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DeviceLockOptions {
  /** How often the holder refreshes the lock's timestamp. */
  heartbeatMs?: number;
  /** A lock whose timestamp is older than this is considered abandoned. */
  staleMs?: number;
  /** Best effort: after waiting this long, proceed without the lock instead of hanging. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 20;

/**
 * Best-effort lock across server processes for one device, so separate stdio server processes
 * (one per client, possibly in different containers) do not talk to the single-threaded device at
 * the same time. Uses an atomic `mkdir`. While held, a heartbeat refreshes the directory's
 * timestamp; a lock without heartbeat is abandoned. This needs no PIDs or host names, which are
 * not comparable across containers (own PID namespaces, shared host name with --network host).
 */
export class DeviceLock {
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly id = randomUUID();

  constructor(
    private readonly dir: string,
    options: DeviceLockOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.staleMs = options.staleMs ?? 30_000;
    this.maxWaitMs = options.maxWaitMs ?? 45_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async acquire(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.dir), { recursive: true });
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      try {
        await mkdir(this.dir);
        await writeFile(join(this.dir, "owner"), this.id).catch(() => undefined);
        return this.hold();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await this.isStale()) {
        await rm(this.dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        console.error(
          `websps-mcp: lock ${this.dir} still held after ${this.maxWaitMs}ms, continuing`,
        );
        return async () => undefined;
      }
      await this.sleep(POLL_MS);
    }
  }

  private hold(): () => Promise<void> {
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(this.dir, now, now).catch(() => undefined);
    }, this.heartbeatMs);
    // Never keep the process alive just for the heartbeat (e.g. after stdin closed).
    heartbeat.unref();
    return async () => {
      clearInterval(heartbeat);
      await rm(this.dir, { recursive: true, force: true });
    };
  }

  private async isStale(): Promise<boolean> {
    try {
      return Date.now() - (await stat(this.dir)).mtimeMs > this.staleMs;
    } catch {
      // The lock vanished meanwhile; the next mkdir decides.
      return false;
    }
  }
}
