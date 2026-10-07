import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceLock } from "./lock.js";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "websps-lock-"));
  path = join(dir, "device.lock");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lock as another process would leave it: owner id and a chosen age. */
async function foreignLock(ageMs: number): Promise<void> {
  await mkdir(path);
  await writeFile(join(path, "owner"), "another-process");
  const time = new Date(Date.now() - ageMs);
  await utimes(path, time, time);
}

describe("DeviceLock", () => {
  it("lets only one holder in at a time", async () => {
    const a = new DeviceLock(path);
    const b = new DeviceLock(path);
    const order: string[] = [];
    const releaseA = await a.acquire();
    const pending = b.acquire().then((release) => {
      order.push("b");
      return release;
    });
    await wait(60);
    order.push("a done");
    await releaseA();
    await (await pending)();
    expect(order).toEqual(["a done", "b"]);
  });

  it("does not take over a fresh lock of another process", async () => {
    await foreignLock(0);
    const polls: number[] = [];
    const lock = new DeviceLock(path, {
      staleMs: 10_000,
      sleep: async (ms) => {
        polls.push(ms);
        if (polls.length === 3) await rm(path, { recursive: true, force: true });
      },
    });
    await (await lock.acquire())();
    expect(polls).toHaveLength(3);
  });

  it("takes over a lock without heartbeat once it is stale", async () => {
    await foreignLock(5_000);
    const polls: number[] = [];
    const lock = new DeviceLock(path, { staleMs: 1_000, sleep: async (ms) => void polls.push(ms) });
    await (await lock.acquire())();
    expect(polls).toHaveLength(0);
  });

  it("keeps a long-held lock alive with the heartbeat", async () => {
    const options = { heartbeatMs: 30, staleMs: 150 };
    const holder = new DeviceLock(path, options);
    const release = await holder.acquire();
    let acquired = false;
    const other = new DeviceLock(path, options).acquire().then((r) => {
      acquired = true;
      return r;
    });
    await wait(500);
    expect(acquired).toBe(false);
    await release();
    await (await other)();
    expect(acquired).toBe(true);
  });
});
