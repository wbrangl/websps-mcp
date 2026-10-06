import { mkdir, writeFile } from "node:fs/promises";
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

/** Append-only JSON lines log of every write tool call, in addition to the device's own log. */
export class AuditLog {
  constructor(private readonly file: string) {}

  write(entry: AuditEntry): Promise<void> {
    return appendJsonl(this.file, [entry]);
  }
}

/**
 * Timestamped copies of files before the server overwrites or deletes them. The device itself keeps
 * only one `.BAK` generation, overwritten by every write.
 */
export class BackupStore {
  constructor(private readonly dir: string) {}

  /** Saves `content` of `path` (e.g. `rules/ANALOG.TXT`); returns the backup file name. */
  async save(path: string, content: Uint8Array, now = new Date()): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, "");
    const name = `${stamp}_${path.replace(/[/\\]/g, "_")}`;
    try {
      await writeFile(join(this.dir, name), content, { flag: "wx" });
      return name;
    } catch (error) {
      // Same millisecond, same file: keep both.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const unique = `${name}.${process.pid}.${Date.now()}`;
      await writeFile(join(this.dir, unique), content);
      return unique;
    }
  }
}
