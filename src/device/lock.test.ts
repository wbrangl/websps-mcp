import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceLock } from "./lock.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "websps-lock-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("DeviceLock", () => {
  it("lets only one holder in at a time", async () => {
    const path = join(dir, "device.lock");
    const a = new DeviceLock(path);
    const b = new DeviceLock(path);
    const order: string[] = [];
    const releaseA = await a.acquire();
    const pending = b.acquire().then((release) => {
      order.push("b");
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    order.push("a done");
    await releaseA();
    await (await pending)();
    expect(order).toEqual(["a done", "b"]);
  });

  it("takes over a lock left by a dead process or after a minute", async () => {
    const path = join(dir, "device.lock");
    await mkdir(path);
    await writeFile(join(path, "owner"), "999999999");
    await (await new DeviceLock(path).acquire())();

    await mkdir(path);
    const old = new Date(Date.now() - 120_000);
    await utimes(path, old, old);
    await (await new DeviceLock(path).acquire())();
  });
});
