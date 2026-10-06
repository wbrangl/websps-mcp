import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Appends records as JSON lines, creating the directory on first use. */
export async function appendJsonl(path: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

/** Reads a JSON lines file; a missing file is empty, broken lines (e.g. after a crash) are skipped. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // ignore a partially written last line
    }
  }
  return records;
}

/** Replaces a JSON lines file atomically (write to a temp file, then rename). */
export async function writeJsonl(path: string, records: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  await rename(temp, path);
}
