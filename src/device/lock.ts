import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A lock older than this is considered left over from a crashed process. */
const STALE_MS = 60_000;
const POLL_MS = 20;
/** Best effort: after waiting this long, proceed without the lock instead of hanging. */
const MAX_WAIT_MS = 30_000;

/**
 * Best-effort lock across server processes for one device, so separate stdio server processes
 * (one per client) do not talk to the single-threaded device at the same time. Uses an atomic
 * `mkdir`; a lock held by a dead process or older than a minute is taken over.
 */
export class DeviceLock {
  private readonly dir: string;

  constructor(
    path: string,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.dir = path;
  }

  async acquire(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.dir), { recursive: true });
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      try {
        await mkdir(this.dir);
        await writeFile(join(this.dir, "owner"), String(process.pid)).catch(() => undefined);
        return () => rm(this.dir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (await this.isStale()) {
        await rm(this.dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        console.error(`websps-mcp: lock ${this.dir} still held after ${MAX_WAIT_MS}ms, continuing`);
        return async () => undefined;
      }
      await this.sleep(POLL_MS);
    }
  }

  private async isStale(): Promise<boolean> {
    try {
      const info = await stat(this.dir);
      if (Date.now() - info.mtimeMs > STALE_MS) return true;
      const pid = Number(await readFile(join(this.dir, "owner"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } catch {
      // Lock vanished meanwhile or owner file not written yet.
      return false;
    }
  }
}
