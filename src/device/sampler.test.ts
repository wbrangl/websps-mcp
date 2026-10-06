import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";
import type { Device } from "./registry.js";
import { Sampler } from "./sampler.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "websps-sample-"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** Advances the fake clock second by second, letting the real file I/O of each tick finish. */
async function seconds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await vi.advanceTimersByTimeAsync(1000);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function deviceWith(read: () => Promise<unknown>): Device {
  return {
    alias: "dev",
    client: { call: read },
    layout: { get: async () => [] },
  } as unknown as Device;
}

const reading = (value: number) => async () => ({
  channels: [{ channel: "S0.0", value }],
  timestamp: "t",
});

describe("Sampler", () => {
  it("records at the interval until the duration is over", async () => {
    let value = 0;
    const sampler = new Sampler(
      deviceWith(async () => reading(value++)()),
      dir,
    );
    const started = sampler.start(["S0.0"], 1000, 3);
    expect(started).toMatchObject({ device: "dev", status: "running", interval_ms: 1000 });

    await seconds(5);
    const result = await sampler.read(started.id, 0, 100);
    expect(result.recording.status).toBe("finished");
    expect(result.samples.map((s) => s.values["S0.0"])).toEqual([0, 1, 2]);
    expect(result.more).toBe(false);

    const page = await sampler.read(started.id, 1, 1);
    expect(page.samples.map((s) => s.values["S0.0"])).toEqual([1]);
    expect(page).toMatchObject({ nextIndex: 2, more: true });
  });

  it("can be stopped and read back from the file by a new process", async () => {
    const sampler = new Sampler(deviceWith(reading(1)), dir);
    const { id } = sampler.start(["S0.0"], 1000, 60);
    await seconds(2);
    expect((await sampler.stop(id)).status).toBe("stopped");

    const later = new Sampler(deviceWith(reading(1)), dir);
    const stored = await later.read(id, 0, 100);
    expect(stored.recording).toMatchObject({ id, status: "stopped", count: 3 });
  });

  it("records outages as gaps but gives up on auth errors", async () => {
    let calls = 0;
    const sampler = new Sampler(
      deviceWith(async () => {
        calls++;
        if (calls === 2) throw new WebspsError(ServerErrorCode.TIMEOUT, "slow");
        if (calls === 3) throw new WebspsError(DeviceErrorCode.AUTH, "denied");
        return reading(1)();
      }),
      dir,
    );
    const { id } = sampler.start(["S0.0"], 1000, 60);
    await seconds(5);
    const result = await sampler.read(id, 0, 100);
    expect(result.recording).toMatchObject({ status: "failed", error: "AUTH: denied" });
    expect(result.samples).toHaveLength(2);
    expect(result.samples[1]).toMatchObject({ values: { "S0.0": null } });
    expect(calls).toBe(3);
  });

  it("validates interval, duration and the number of recordings", () => {
    const sampler = new Sampler(deviceWith(reading(1)), dir);
    expect(() => sampler.start(["S0.0"], 500, 10)).toThrow("interval_ms");
    expect(() => sampler.start(["S0.0"], 1000, 0)).toThrow("duration_s");
    for (let i = 0; i < 3; i++) sampler.start(["S0.0"], 1000, 10);
    expect(() => sampler.start(["S0.0"], 1000, 10)).toThrow("At most 3");
  });
});
