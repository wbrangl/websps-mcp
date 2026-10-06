import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeDevice, startFakeDevice } from "./testing/fakeDevice.js";

const tsx = createRequire(import.meta.url).resolve("tsx/cli");

let device: FakeDevice;
beforeAll(async () => {
  device = await startFakeDevice();
});
afterAll(() => device.close());

async function connect(mode: "legacy" | { pin: string }, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, "src/index.ts"],
    env: {
      PATH: process.env.PATH ?? "",
      WEBSPS_URL: device.url,
      WEBSPS_USER: "api_user",
      WEBSPS_PASSWORD: "secret",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = (result.content as { type: string; text: string }[])[0];
  return JSON.parse(first?.text ?? "null");
}

describe.each([
  ["2026-07-28", { pin: "2026-07-28" } as const],
  ["legacy initialize", "legacy" as const],
])("stdio server (%s)", (_name, mode) => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(mode);
  }, 20_000);
  afterAll(() => client.close());

  it("negotiates the expected era", () => {
    expect(client.getProtocolEra()).toBe(mode === "legacy" ? "legacy" : "modern");
    expect(client.getInstructions()).toContain("Web@SPS");
  });

  it("lists the read-profile tools sorted by name", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "device_status",
      "devices_list",
      "io_labels",
      "io_read",
    ]);
  });

  it("reads channels with labels and falls back to io.read_all for value operands", async () => {
    const result = await client.callTool({
      name: "io_read",
      arguments: { channels: ["S0.0", "CV0.3", "AE0", "W0.1", "NOPE"] },
    });
    expect(result.isError).toBeFalsy();
    expect(parse(result).channels).toEqual([
      { channel: "S0.0", value: 1, label: "Pump on" },
      { channel: "CV0.3", value: 7 },
      { channel: "AE0", value: 12.5 },
      { channel: "W0.1", value: 1 },
      { channel: "NOPE", error: "unbekannter Kanal" },
    ]);
  });

  it("returns the complete state with all: true", async () => {
    const result = await client.callTool({ name: "io_read", arguments: { all: true } });
    const body = parse(result);
    expect(body.operands.H).toMatchObject({ description: "Melder", on: ["H1.2"] });
    expect(body.operands.CV).toMatchObject({ values: { "CV0.3": 7 }, zero_omitted: true });
    expect(body.operands.AE.values).toEqual({ AE0: 12.5, AE1: 0 });
    expect(body.labeled).toEqual({ "S0.0": { label: "Pump on", value: 1 } });
    expect(body.extra).toEqual({ status: 1 });
    expect(body.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  it("reports partial failures in device_status", async () => {
    const body = parse(await client.callTool({ name: "device_status", arguments: {} }));
    expect(body.status.status_text).toBe("RUN");
    expect(body.errors.mbox).toMatchObject({ code: 2, name: "FORBIDDEN" });
  });

  it("rejects invalid input without contacting the device", async () => {
    const result = await client.callTool({ name: "io_read", arguments: {} });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatchObject({ code: 1007, name: "INVALID_INPUT" });
  });
});

describe("authentication failures", () => {
  it("stops after the first rejected login instead of retrying", async () => {
    const client = await connect({ pin: "2026-07-28" }, { WEBSPS_PASSWORD: "wrong" });
    try {
      const before = device.state.calls.length;
      const first = parse(await client.callTool({ name: "io_labels", arguments: {} }));
      const second = parse(await client.callTool({ name: "io_labels", arguments: {} }));
      expect(first.error).toMatchObject({ code: 1, name: "AUTH" });
      expect(second.error).toMatchObject({ code: 1001, name: "CIRCUIT_OPEN" });
      const status = await client.callTool({ name: "device_status", arguments: {} });
      expect(status.isError).toBe(true);
      expect(parse(status).error).toMatchObject({ code: 1001 });
      expect(device.state.calls.length - before).toBe(1);

      const list = parse(await client.callTool({ name: "devices_list", arguments: {} }));
      expect(list.devices[0]).toMatchObject({ alias: "websps", reachable: false, circuit: "open" });
    } finally {
      await client.close();
    }
  }, 20_000);
});
