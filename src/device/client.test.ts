import { describe, expect, it, vi } from "vitest";
import { ServerErrorCode, WebspsError } from "../errors.js";
import { AUTH_LOCKOUT_MS, DeviceClient, MAX_POST_BYTES } from "./client.js";

type Reply = string | Error | ((body: string) => string | Promise<string>);

function setup(replies: Reply[], password = () => "pw") {
  let time = 0;
  const bodies: string[] = [];
  const auths: string[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    auths.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
    const reply = replies.shift();
    if (reply === undefined) throw new Error("unexpected request");
    if (reply instanceof Error) throw reply;
    const text = typeof reply === "function" ? await reply(body) : reply;
    return new Response(text, { status: 200 });
  });
  const client = new DeviceClient({
    alias: "dev",
    url: "http://device/",
    user: "u",
    password: { description: "test", read: password },
    timeoutMs: 1000,
    methodTimeoutsMs: {},
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => time,
    sleep: async () => undefined,
  });
  return { client, fetch, bodies, auths, advance: (ms: number) => (time += ms) };
}

const ok = (result: unknown) => JSON.stringify({ ok: true, result });
const fail = (code: number) =>
  JSON.stringify({ ok: false, error: { code, message: `code ${code}` } });

async function rejection(promise: Promise<unknown>): Promise<WebspsError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WebspsError);
  return error as WebspsError;
}

describe("DeviceClient", () => {
  it("posts method and params with Basic-Auth and returns the result", async () => {
    const { client, bodies, auths, fetch } = setup([ok({ value: 1 })]);
    await expect(client.call("io.read", { channels: ["S0.0"] })).resolves.toEqual({ value: 1 });
    expect(JSON.parse(bodies[0] as string)).toEqual({
      method: "io.read",
      params: { channels: ["S0.0"] },
    });
    expect(auths[0]).toBe(`Basic ${Buffer.from("u:pw").toString("base64")}`);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://device/api");
  });

  it("maps device errors from the body (HTTP status is always 200)", async () => {
    const { client } = setup([fail(4)]);
    const error = await rejection(client.call("config.get", { key: "x" }));
    expect(error.toPayload()).toMatchObject({ code: 4, name: "NOT_FOUND", device: "dev" });
  });

  it("retries BUSY with backoff and then succeeds", async () => {
    const { client, fetch } = setup([fail(5), fail(5), ok("done")]);
    await expect(client.call("system.status")).resolves.toBe("done");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after the BUSY retries", async () => {
    const { client, fetch } = setup([fail(5), fail(5), fail(5), fail(5)]);
    expect((await rejection(client.call("system.status"))).code).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("opens the circuit on an auth failure and sends nothing during the lockout", async () => {
    const { client, fetch, advance } = setup([fail(1)]);
    expect((await rejection(client.call("system.status"))).code).toBe(1);
    expect(client.circuitState).toBe("open");

    advance(AUTH_LOCKOUT_MS - 1000);
    const paused = await rejection(client.call("system.status"));
    expect(paused.code).toBe(ServerErrorCode.CIRCUIT_OPEN);
    expect(paused.message).toContain("1s");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends exactly one probe after the lockout and closes the circuit on success", async () => {
    const { client, fetch, advance } = setup([fail(1), ok(1), ok(2)]);
    await rejection(client.call("system.status"));
    advance(AUTH_LOCKOUT_MS);
    await expect(client.call("system.status")).resolves.toBe(1);
    expect(client.circuitState).toBe("closed");
    await expect(client.call("system.status")).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("blocks after a failed probe until the password source changes", async () => {
    let password = "old";
    const { client, fetch, advance, auths } = setup([fail(1), fail(1), ok("ok")], () => password);
    await rejection(client.call("system.status"));
    advance(AUTH_LOCKOUT_MS);
    await rejection(client.call("system.status"));
    expect(client.circuitState).toBe("blocked");

    advance(10 * AUTH_LOCKOUT_MS);
    expect((await rejection(client.call("system.status"))).code).toBe(ServerErrorCode.AUTH_BLOCKED);
    expect(fetch).toHaveBeenCalledTimes(2);

    password = "new";
    await expect(client.call("system.status")).resolves.toBe("ok");
    expect(client.circuitState).toBe("closed");
    expect(auths[2]).toBe(`Basic ${Buffer.from("u:new").toString("base64")}`);
  });

  it("serializes concurrent requests", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return ok(null);
    };
    const { client } = setup([slow, slow, slow]);
    await Promise.all([client.call("a"), client.call("b"), client.call("c")]);
    expect(maxActive).toBe(1);
  });

  it("keeps the queue running after a failed request", async () => {
    const { client } = setup([new Error("boom"), ok("next")]);
    await rejection(client.call("a"));
    await expect(client.call("b")).resolves.toBe("next");
  });

  it("reports network errors, timeouts and bad responses", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { client } = setup([new TypeError("fetch failed"), timeout, "<html>", '{"x":1}']);
    expect((await rejection(client.call("a"))).code).toBe(ServerErrorCode.UNREACHABLE);
    expect((await rejection(client.call("a"))).code).toBe(ServerErrorCode.TIMEOUT);
    expect((await rejection(client.call("a"))).code).toBe(ServerErrorCode.BAD_RESPONSE);
    expect((await rejection(client.call("a"))).code).toBe(ServerErrorCode.BAD_RESPONSE);
  });

  it("rejects requests above the device body limit without sending them", async () => {
    const { client, fetch } = setup([]);
    const error = await rejection(client.call("x", { data: "a".repeat(MAX_POST_BYTES) }));
    expect(error.code).toBe(ServerErrorCode.INVALID_INPUT);
    expect(fetch).not.toHaveBeenCalled();
  });
});
