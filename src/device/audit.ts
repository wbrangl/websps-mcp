import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "../state.js";

export interface AuditEntry {
  at: string;
  tool: string;
  profile: string;
  /** Arguments without secrets and without file contents (only their size and CRC). */
  args: Record<string, unknown>;
  outcome: "ok" | "error";
  result?: unknown;
  error?: unknown;
}

/**
 * Append-only JSON lines log of every write tool call, in addition to the device's own log.
 * Rotated by size: audit.jsonl → audit.jsonl.1 → … → audit.jsonl.<files>.
 */
export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly options: { maxBytes: number; files: number } = {
      maxBytes: 10 * 1024 * 1024,
      files: 5,
    },
  ) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.rotateIfFull();
    await appendJsonl(this.file, [entry]);
  }

  private async rotateIfFull(): Promise<void> {
    const size = await stat(this.file).then(
      (s) => s.size,
      () => 0,
    );
    if (size < this.options.maxBytes) return;
    await rm(`${this.file}.${this.options.files}`, { force: true });
    for (let i = this.options.files - 1; i >= 1; i--) {
      await rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => undefined);
    }
    await rename(this.file, `${this.file}.1`).catch(() => undefined);
  }
}

/**
 * Timestamped copies of files before the server overwrites or deletes them. The device itself keeps
 * only one `.BAK` generation, overwritten by every write. Only the newest `perFile` copies of each
 * device file are kept.
 */
export class BackupStore {
  constructor(
    private readonly dir: string,
    private readonly perFile = 20,
  ) {}

  /** Saves `content` of `path` (e.g. `rules/ANALOG.TXT`); returns the backup file name. */
  async save(path: string, content: Uint8Array, now = new Date()): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "");
    const suffix = `_${path.replace(/[/\\]/g, "_")}`;
    const name = `${stamp}${suffix}`;
    let saved: string;
    try {
      await writeFile(join(this.dir, name), content, { flag: "wx" });
      saved = name;
    } catch (error) {
      // Same millisecond, same file: keep both.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      saved = `${name}.${process.pid}.${Date.now()}`;
      await writeFile(join(this.dir, saved), content);
    }
    await this.prune(suffix);
    return saved;
  }

  /** Removes all but the newest copies of one device file (names start with a sortable time). */
  private async prune(suffix: string): Promise<void> {
    const copies = (await readdir(this.dir))
      .filter((n) => n.includes(suffix) && /^\d{8}T/.test(n))
      .filter((n) => {
        const rest = n.slice(n.indexOf("_"));
        return rest === suffix || rest.startsWith(`${suffix}.`);
      })
      .sort();
    for (const old of copies.slice(0, Math.max(0, copies.length - this.perFile))) {
      await rm(join(this.dir, old), { force: true });
    }
  }
}
