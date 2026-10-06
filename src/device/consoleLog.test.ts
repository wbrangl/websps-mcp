import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceClient } from "./client.js";
import { ConsoleLog } from "./consoleLog.js";

type Entry = { seq: number; timestamp: string; message: string };
const entry = (seq: number): Entry => ({ seq, timestamp: "10:00:00", message: `line ${seq}` });
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "websps-log-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A client whose `system.log` returns the next buffer (newest first, like the device). */
function clientWith(buffers: Entry[][]): DeviceClient {
  return {
    call: async () => ({ entries: [...(buffers.shift() ?? [])].reverse() }),
  } as unknown as DeviceClient;
}

describe("ConsoleLog", () => {
  it("accumulates new lines only and continues from a cursor", async () => {
    const log = new ConsoleLog(clientWith([range(1, 5), range(3, 8)]), join(dir, "c.jsonl"));
    await log.poll();
    const first = await log.read({ limit: 10 });
    expect(first.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);

    expect(await log.poll()).toEqual({ gap: false, restarted: false });
    const next = await log.read({ sinceCursor: first.nextCursor, limit: 2 });
    expect(next.entries.map((e) => e.seq)).toEqual([6, 7]);
    expect(next.more).toBe(true);
    const rest = await log.read({ sinceCursor: next.nextCursor, limit: 10 });
    expect(rest.entries.map((e) => e.seq)).toEqual([8]);
    expect(rest.more).toBe(false);
  });

  it("detects lost lines and device restarts", async () => {
    const log = new ConsoleLog(
      clientWith([range(1, 25), range(40, 64), range(1, 3)]),
      join(dir, "c.jsonl"),
    );
    await log.poll();
    expect(await log.poll()).toEqual({ gap: true, restarted: false });
    expect(await log.poll()).toEqual({ gap: false, restarted: true });
    const all = await log.read({ limit: 100 });
    expect(all.entries).toHaveLength(53);
    expect(all.entries.at(-1)).toMatchObject({ seq: 3, pos: 53 });
  });

  it("persists across instances and filters with grep", async () => {
    const file = join(dir, "c.jsonl");
    await new ConsoleLog(clientWith([range(1, 12)]), file).poll();
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(12);

    const reopened = new ConsoleLog(clientWith([range(5, 13)]), file);
    await reopened.poll();
    const matches = await reopened.read({ grep: "LINE 1", limit: 10 });
    expect(matches.entries.map((e) => e.seq)).toEqual([1, 10, 11, 12, 13]);
  });
});
