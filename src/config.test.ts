import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_TIMEOUT_MS, loadConfig } from "./config.js";

const files = (map: Record<string, string>) => (path: string) => {
  const content = map[path];
  if (content === undefined) throw new Error(`ENOENT ${path}`);
  return content;
};

const twoDevices = JSON.stringify({
  profile: "operate",
  devices: [
    { alias: "a", url: "http://10.0.0.2/", auth: { user: "api_user", password_env: "PW_A" } },
    {
      alias: "b",
      url: "http://10.0.0.3",
      auth: { user: "user1", password_file: "b.pw" },
      timeout_ms: 2000,
      timeouts_ms: { "io.read_all": 3000 },
    },
  ],
});

describe("loadConfig", () => {
  it("builds a single device from environment variables", () => {
    const config = loadConfig({
      argv: [],
      env: { WEBSPS_URL: "http://10.0.0.2", WEBSPS_USER: "api_user", WEBSPS_PASSWORD: "pw" },
    });
    expect(config.profile).toBe("read");
    expect(config.devices).toHaveLength(1);
    expect(config.devices[0]).toMatchObject({
      alias: "websps",
      url: "http://10.0.0.2",
      user: "api_user",
    });
    expect(config.devices[0]?.password.read()).toBe("pw");
    expect(config.devices[0]?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("loads several devices from a config file", () => {
    const config = loadConfig({
      argv: ["--config", "/etc/websps/devices.json"],
      env: { PW_A: "secret-a" },
      readFile: files({ "/etc/websps/devices.json": twoDevices, "/etc/websps/b.pw": "secret-b\n" }),
    });
    expect(config.profile).toBe("operate");
    expect(config.devices.map((d) => d.alias)).toEqual(["a", "b"]);
    expect(config.devices[0]?.url).toBe("http://10.0.0.2");
    expect(config.devices[0]?.password.read()).toBe("secret-a");
    expect(config.devices[1]?.password.read()).toBe("secret-b");
    expect(config.devices[1]?.password.description).toBe("file /etc/websps/b.pw");
    expect(config.devices[1]?.timeoutMs).toBe(2000);
    expect(config.devices[1]?.methodTimeoutsMs).toEqual({
      "rules.reload": 10_000,
      "logs.search": 45_000,
      "io.read_all": 3000,
    });
  });

  it("resolves the state directory", () => {
    const env = { WEBSPS_URL: "http://x", WEBSPS_USER: "u", WEBSPS_PASSWORD: "p" };
    expect(loadConfig({ argv: [], env: { ...env, HOME: "/home/u" } }).stateDir).toBe(
      "/home/u/.local/state/websps-mcp",
    );
    expect(loadConfig({ argv: [], env: { ...env, XDG_STATE_HOME: "/xdg" } }).stateDir).toBe(
      "/xdg/websps-mcp",
    );
    expect(loadConfig({ argv: [], env: { ...env, WEBSPS_STATE_DIR: "/s" } }).stateDir).toBe("/s");

    const file = JSON.stringify({ ...JSON.parse(twoDevices), state_dir: "state" });
    const fromFile = loadConfig({
      argv: ["--config", "/etc/websps/c.json"],
      env: { PW_A: "x" },
      readFile: files({ "/etc/websps/c.json": file, "/etc/websps/b.pw": "y" }),
    });
    expect(fromFile.stateDir).toBe("/etc/websps/state");
  });

  it("lets WEBSPS_PROFILE override the file profile", () => {
    const config = loadConfig({
      argv: [],
      env: { WEBSPS_CONFIG: "/c.json", WEBSPS_PROFILE: "admin", PW_A: "x" },
      readFile: files({ "/c.json": twoDevices, "/b.pw": "y" }),
    });
    expect(config.profile).toBe("admin");
  });

  it.each([
    [{}, "No device configured"],
    [{ WEBSPS_URL: "http://x", WEBSPS_CONFIG: "/c.json" }, "not both"],
    [{ WEBSPS_URL: "ftp://x", WEBSPS_USER: "u", WEBSPS_PASSWORD: "p" }, "http(s) URL"],
    [{ WEBSPS_URL: "http://x", WEBSPS_PASSWORD: "p" }, "WEBSPS_USER"],
    [{ WEBSPS_URL: "http://x", WEBSPS_USER: "u" }, "exactly one of WEBSPS_PASSWORD"],
    [
      { WEBSPS_URL: "http://x", WEBSPS_USER: "u", WEBSPS_PASSWORD: "p", WEBSPS_PROFILE: "root" },
      "WEBSPS_PROFILE",
    ],
  ])("rejects invalid environment %j", (env, message) => {
    expect(() => loadConfig({ argv: [], env })).toThrow(message);
  });

  it("rejects a missing password variable without revealing secrets", () => {
    const run = () =>
      loadConfig({
        argv: ["--config=/c.json"],
        env: {},
        readFile: files({ "/c.json": twoDevices }),
      });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow("PW_A");
  });

  it("rejects the same device configured twice", () => {
    const twice = JSON.stringify({
      devices: [
        { alias: "a", url: "http://10.0.0.2", auth: { user: "u", password_env: "P" } },
        { alias: "b", url: "http://10.0.0.2/", auth: { user: "v", password_env: "P" } },
      ],
    });
    expect(() =>
      loadConfig({
        argv: ["--config", "/t.json"],
        env: { P: "x" },
        readFile: files({ "/t.json": twice }),
      }),
    ).toThrow("10.0.0.2 is configured more than once");
  });

  it("rejects duplicate aliases and unknown keys", () => {
    const duplicate = JSON.stringify({
      devices: [
        { alias: "a", url: "http://x", auth: { user: "u", password_env: "P" } },
        { alias: "A", url: "http://y", auth: { user: "u", password_env: "P" } },
      ],
    });
    const unknownKey = JSON.stringify({
      devices: [{ alias: "a", url: "http://x", auth: { user: "u", password: "plain" } }],
    });
    const readFile = files({ "/d.json": duplicate, "/u.json": unknownKey });
    expect(() => loadConfig({ argv: ["--config", "/d.json"], env: { P: "x" }, readFile })).toThrow(
      'Duplicate device alias "a"',
    );
    expect(() => loadConfig({ argv: ["--config", "/u.json"], env: {}, readFile })).toThrow(
      "Invalid config file",
    );
  });
});
