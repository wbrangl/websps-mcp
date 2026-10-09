import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultState, type FakeDevice, startFakeDevice } from "./testing/fakeDevice.js";
import { connectServer, parseResult as parse } from "./testing/mcpClient.js";

// Newer firmware: directories reported by api.describe, svg/ renamed to scripts/.
let device: FakeDevice;
let stateDir: string;
let client: Client;

beforeAll(async () => {
  const state = defaultState();
  state.describe = {
    file_endpoint_prefixes: [
      "rules/",
      "log/",
      "rec/",
      "mails/",
      "scripts/",
      "pic/",
      "img/",
      "htm/",
    ],
    file_endpoint_write_prefixes: ["rules/", "mails/", "scripts/", "htm/"],
  };
  state.files["scripts/GAUGE.SVG"] = "<svg/>";
  device = await startFakeDevice(state);
  stateDir = await mkdtemp(join(tmpdir(), "websps-mcp-areas-"));
  client = await connectServer({ url: device.url, stateDir, env: { WEBSPS_PROFILE: "develop" } });
}, 20_000);
afterAll(async () => {
  await client.close();
  await device.close();
  await rm(stateDir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: parse(result) };
};

describe("file directories from api.describe", () => {
  it("lists, reads and writes scripts/", async () => {
    expect((await call("file_list", { directory: "scripts" })).body.files).toEqual(["GAUGE.SVG"]);
    expect((await call("file_read", { path: "scripts/GAUGE.SVG" })).body.content).toBe("<svg/>");
    const written = await call("file_write", { path: "scripts/NEW.SVG", content: "<svg></svg>" });
    expect(written.body).toMatchObject({ created: true });
  });

  it("accepts the old name svg/ as an alias", async () => {
    expect((await call("file_write", { path: "svg/OLD.SVG", content: "<svg/>" })).isError).toBe(
      false,
    );
  });

  it("refuses directories the device does not offer for writing", async () => {
    const result = await call("file_write", { path: "log/X.TXT", content: "x" });
    expect(result.body.error).toMatchObject({ code: 1007 });
    expect(result.body.error.message).toContain("available: rules, mails, scripts, htm, svg");
  });

  it("keeps rules files and the label file out of file_write", async () => {
    expect(
      (await call("file_write", { path: "rules/A.TXT", content: "x" })).body.error.message,
    ).toContain("rules_write");
    expect(
      (await call("file_write", { path: "rules/SYMBOLIK.INI", content: "x" })).body.error.message,
    ).toContain("io_labels_set");
  });
});
