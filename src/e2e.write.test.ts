import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crc16Xmodem } from "./device/crc16.js";
import { type FakeDevice, startFakeDevice } from "./testing/fakeDevice.js";
import { connectServer, parseResult as parse } from "./testing/mcpClient.js";

let device: FakeDevice;
let stateDir: string;
let client: Client;

beforeAll(async () => {
  device = await startFakeDevice();
  stateDir = await mkdtemp(join(tmpdir(), "websps-mcp-write-"));
  client = await connectServer({ url: device.url, stateDir, env: { WEBSPS_PROFILE: "admin" } });
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
const crc = (text: string) => crc16Xmodem(Buffer.from(text));

describe.each([
  ["read", 11],
  ["operate", 13],
  ["develop", 19],
  ["admin", 22],
])("profile %s", (profile, count) => {
  it(`shows ${count} tools`, async () => {
    const c = await connectServer({ url: device.url, stateDir, env: { WEBSPS_PROFILE: profile } });
    try {
      expect((await c.listTools()).tools).toHaveLength(count);
    } finally {
      await c.close();
    }
  }, 20_000);
});

describe("io_write", () => {
  it("writes, verifies and validates values before sending", async () => {
    const ok = await call("io_write", {
      channel: "S5.0",
      value: true,
      verify: { channel: "A0.7", expect: 1, delay_ms: 0 },
    });
    expect(ok.body).toMatchObject({
      all_ok: true,
      verify: [{ channel: "A0.7", actual: 1, ok: true }],
    });

    const batch = await call("io_write", {
      writes: [
        { channel: "SW3", value: 31.5 },
        { channel: "SW2", value: 500 },
      ],
      verify: true,
    });
    expect(batch.body.all_ok).toBe(false);
    expect(batch.body.writes[1]).toMatchObject({ channel: "SW2", success: false });
    expect(batch.body.verify).toEqual([{ channel: "SW3", expected: 31.5, actual: 31.5, ok: true }]);

    const calls = device.state.calls.length;
    expect((await call("io_write", { channel: "E0.0", value: 1 })).body.error.code).toBe(1007);
    expect((await call("io_write", { channel: "S5.1", value: 2 })).body.error.code).toBe(1007);
    expect(device.state.calls.length).toBe(calls);
  });
});

describe("rules chain", () => {
  it("refuses invalid content and empty middle parameters", async () => {
    const lint = await call("rules_validate", {
      name: "x.txt",
      content: 'P9.5 = R9.5 TXT "a";;13;\n',
    });
    expect(lint.body).toMatchObject({ name: "X.TXT", valid: false });
    expect(lint.body.lint.errors[0].message).toContain("parameter 2 is empty");

    const bad = await call("rules_write", { name: "NEW.TXT", content: "M0.0 = BAD\n" });
    expect(bad.isError).toBe(true);
    expect(bad.body.error.details.device_check.errors[0].line).toBe(1);
    expect(device.state.files["rules/NEW.TXT"]).toBeUndefined();
  });

  it("writes with CRLF, needs expected_hash for changes and keeps backups", async () => {
    const created = await call("rules_write", { name: "NEW.TXT", content: "M0.0 = S0.0\n" });
    expect(created.body).toMatchObject({ created: true, activated: false, is_root: false });
    expect(device.state.files["rules/NEW.TXT"]).toBe("M0.0 = S0.0\r\n");

    const missingHash = await call("rules_write", { name: "NEW.TXT", content: "M0.1 = S0.1\n" });
    expect(missingHash.body.error.message).toContain("expected_hash");
    const stale = await call("rules_write", { name: "NEW.TXT", content: "x\n", expected_hash: 1 });
    expect(stale.body.error).toMatchObject({ code: 6 });

    const updated = await call("rules_write", {
      name: "NEW.TXT",
      content: "M0.1 = S0.1\n",
      expected_hash: created.body.crc16,
    });
    expect(updated.body.crc16).toBe(crc("M0.1 = S0.1\r\n"));
    const backup = await readFile(join(stateDir, "websps", "backups", updated.body.backup), "utf8");
    expect(backup).toBe("M0.0 = S0.0\r\n");
  });

  it("writes large files in chunks with the hash on every chunk", async () => {
    const line = "M0.0 = S0.0 // padding to make the file larger than one chunk\n";
    const content = line.repeat(200);
    const result = await call("rules_write", { name: "BIG.TXT", content });
    expect(result.body.bytes).toBe(Buffer.byteLength(content.replace(/\n/g, "\r\n")));
    expect(device.state.files["rules/BIG.TXT"]).toBe(content.replace(/\n/g, "\r\n"));
  });

  it("activates a file and restores the previous root if loading fails", async () => {
    const activated = await call("rules_activate", { name: "NEW.TXT" });
    expect(activated.body).toMatchObject({ root: "NEW.TXT", previous_root: "TEST.TXT" });
    expect(device.state.loaded).toBe("NEW.TXT");

    // Passes validation but fails to load; a new file has no .BAK for the device to roll back to.
    await call("rules_write", { name: "BROKEN.TXT", content: "M0.0 = FAIL\n" });
    const failed = await call("rules_activate", { name: "BROKEN.TXT" });
    expect(failed.isError).toBe(true);
    expect(failed.body.error.details).toMatchObject({ restored_previous_root: "NEW.TXT" });
    expect(device.state.root).toBe("NEW.TXT");
    expect(failed.body.error.details.status.status_text).toBe("STOP");
    expect(failed.body.error.hint).toContain("device_control RUN");

    expect((await call("device_control", { command: "RUN" })).body.result.success).toBe(true);
    await call("rules_activate", { name: "TEST.TXT" });
  });

  it("protects the active root and internal files from deletion", async () => {
    const root = await call("file_delete", { path: "rules/TEST.TXT" });
    expect(root.body.error.message).toContain("active root");
    expect((await call("file_delete", { path: "rules/TEST.BAK" })).body.error.code).toBe(1007);

    const deleted = await call("file_delete", { path: "rules/NEW.TXT" });
    expect(deleted.body).toMatchObject({ result: { deleted: true } });
    expect(deleted.body.backup).toMatch(/_rules_NEW\.TXT$/);
  });
});

describe("files, labels and configuration", () => {
  it("writes files outside rules only in the allowed directories", async () => {
    expect(
      (await call("file_write", { path: "rules/A.TXT", content: "x" })).body.error.message,
    ).toContain("rules_write");
    const svg = await call("file_write", { path: "svg/P.SVG", content: "<svg/>" });
    expect(svg.body).toMatchObject({ created: true, bytes: 6 });
  });

  it("sets labels and refreshes the label cache", async () => {
    await call("io_labels", {});
    await call("io_label_set", { channel: "M9.7", label: "Test marker" });
    expect((await call("io_labels", {})).body.labels["M9.7"]).toBe("Test marker");
    expect((await call("io_label_set", { channel: "M9.7", label: "a=b" })).isError).toBe(true);
  });

  it("changes configuration but never secrets", async () => {
    const set = await call("config_set", { key: "device_name", value: "Pool" });
    expect(set.body).toMatchObject({ previous: "Test", value: "Pool", critical: false });
    const secret = await call("config_set", { key: "admin_password", value: "leak" });
    expect(secret.body.error.message).toContain("secret");
    expect(device.state.config.admin_password).toBe("pw");
  });

  it("controls the device", async () => {
    await call("device_control", { command: "STOP" });
    expect(device.state.status.status_text).toBe("STOP");
    await call("device_reboot", { mode: "REINIT" });
    expect(device.state.status.status_text).toBe("RUN");
    const time = await call("device_control", {
      command: "SET_TIME",
      time: { hour: 8, minute: 30 },
    });
    expect(time.body.result).toEqual({ manual_hour: 8, manual_minute: 30 });
  });
});

describe("audit log", () => {
  it("records every write call without secrets or contents", async () => {
    const dir = join(stateDir, "websps");
    const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
    const entries = lines.map((l) => JSON.parse(l));
    expect(entries.some((e) => e.tool === "rules_write" && e.args.content_bytes > 0)).toBe(true);
    expect(entries.every((e) => e.args.content === undefined)).toBe(true);
    const secret = entries.find((e) => e.tool === "config_set" && e.args.key === "admin_password");
    expect(secret).toMatchObject({ outcome: "error", args: { value: "***" } });
    expect(lines.join("\n")).not.toContain("leak");
    expect((await readdir(join(dir, "backups"))).length).toBeGreaterThan(0);
  });
});
