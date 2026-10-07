import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog, BackupStore } from "./audit.js";
import type { Device } from "./registry.js";
import { Sampler } from "./sampler.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "websps-retention-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("BackupStore", () => {
  it("keeps only the newest copies per device file", async () => {
    const store = new BackupStore(dir, 3);
    for (let i = 0; i < 5; i++) {
      await store.save(
        "rules/A.TXT",
        Buffer.from(`a${i}`),
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      );
    }
    await store.save("rules/A_B.TXT", Buffer.from("other"), new Date(Date.UTC(2026, 0, 1)));
    const names = (await readdir(dir)).sort();
    expect(names.filter((n) => n.endsWith("_rules_A.TXT"))).toHaveLength(3);
    expect(names.some((n) => n.endsWith("_rules_A_B.TXT"))).toBe(true);
    const kept = await Promise.all(
      names.filter((n) => n.endsWith("_rules_A.TXT")).map((n) => readFile(join(dir, n), "utf8")),
    );
    expect(kept).toEqual(["a2", "a3", "a4"]);
  });
});

describe("AuditLog", () => {
  it("rotates by size and keeps a limited number of files", async () => {
    const file = join(dir, "audit.jsonl");
    const log = new AuditLog(file, { maxBytes: 200, files: 2 });
    const entry = (i: number) => ({
      at: `t${i}`,
      tool: "io_write",
      profile: "operate",
      args: { padding: "x".repeat(80) },
      outcome: "ok" as const,
    });
    for (let i = 0; i < 12; i++) await log.write(entry(i));
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
    const current = (await readFile(file, "utf8")).trim().split("\n");
    expect(JSON.parse(current.at(-1) as string).at).toBe("t11");
  });
});

describe("Sampler retention", () => {
  const device = {
    alias: "dev",
    client: { call: async () => ({ channels: [{ channel: "S0.0", value: 1 }] }) },
    layout: { get: async () => [] },
  } as unknown as Device;

  async function recording(name: string, ageDays: number): Promise<void> {
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, '{"type":"header"}\n');
    const time = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
    await utimes(path, time, time);
  }

  it("removes old and surplus recordings when a new one starts, never the running one", async () => {
    await mkdir(dir, { recursive: true });
    await recording("aaaaaaa1", 40);
    await recording("aaaaaaa2", 2);
    await recording("aaaaaaa3", 1);
    const sampler = new Sampler(device, dir, undefined, { maxAgeDays: 30, maxCount: 2 });
    const { id } = sampler.start(["S0.0"], 1000, 5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const names = (await readdir(dir)).sort();
    expect(names).toEqual([`${id}.jsonl`, "aaaaaaa3.jsonl"].sort());
    await sampler.stop(id);
  });
});
