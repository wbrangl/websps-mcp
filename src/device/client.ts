import type { DeviceConfig, PasswordSource } from "../config.js";
import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";

/** The device locks an IP out for 60s after 5 failed logins. */
export const AUTH_LOCKOUT_MS = 60_000;
const BUSY_RETRY_DELAYS_MS = [250, 500, 1000];
const decoder = new TextDecoder();
/** Device request body limit (`post_size` in `api.describe`). */
export const MAX_POST_BYTES = 8192;

/**
 * - `closed`: normal operation
 * - `open`: an auth failure happened; no requests until `until`
 * - `probing`: the waiting time is over; the next request is the single probe
 * - `blocked`: the probe failed too; stays blocked until the password source changes
 */
export type CircuitState = "closed" | "open" | "probing" | "blocked";

export interface DeviceClientOptions
  extends Pick<DeviceConfig, "alias" | "url" | "user" | "timeoutMs" | "methodTimeoutsMs"> {
  password: PasswordSource;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type ApiResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

/**
 * HTTP client for one Web@SPS device. The device is single-threaded, so all requests of this
 * client are serialized through one queue. Uses Basic-Auth only (no session login: the device has
 * a single login slot that the web UI would take over).
 */
export class DeviceClient {
  readonly alias: string;
  readonly url: string;
  private readonly options: DeviceClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private circuit: CircuitState = "closed";
  private openUntil = 0;
  private password: string;

  constructor(options: DeviceClientOptions) {
    this.options = options;
    this.alias = options.alias;
    this.url = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.password = options.password.read();
  }

  get circuitState(): CircuitState {
    return this.circuit;
  }

  /** Calls an `/api` method and returns its `result`; device errors are thrown as WebspsError. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(params === undefined ? { method } : { method, params });
    if (Buffer.byteLength(body) > MAX_POST_BYTES) {
      return Promise.reject(
        this.error(
          ServerErrorCode.INVALID_INPUT,
          `Request exceeds the device limit of ${MAX_POST_BYTES} bytes`,
        ),
      );
    }
    const timeoutMs = this.options.methodTimeoutsMs[method] ?? this.options.timeoutMs;
    return this.send("/api", body, timeoutMs, (bytes) =>
      this.parse(decoder.decode(bytes)),
    ) as Promise<T>;
  }

  /** `/files` with `action:"hash"`: CRC-16/XMODEM and size, without the content. */
  fileHash(path: string): Promise<{ crc16: number; bytes: number }> {
    const body = JSON.stringify({ path, action: "hash" });
    return this.send("/files", body, this.filesTimeoutMs(), (bytes) =>
      this.parse(decoder.decode(bytes)),
    ) as Promise<{ crc16: number; bytes: number }>;
  }

  /** Raw file content from `/files`. Errors arrive as a JSON body instead of the content. */
  readFile(path: string): Promise<Uint8Array> {
    const body = JSON.stringify({ path });
    return this.send("/files", body, this.filesTimeoutMs(), (bytes) => {
      const head = decoder.decode(bytes.subarray(0, 16)).trimStart();
      return head.startsWith('{"ok":false')
        ? this.parse(decoder.decode(bytes))
        : { ok: true, result: bytes };
    }) as Promise<Uint8Array>;
  }

  private filesTimeoutMs(): number {
    return this.options.methodTimeoutsMs.files ?? this.options.timeoutMs;
  }

  private send(
    endpoint: string,
    body: string,
    timeoutMs: number,
    interpret: (bytes: Uint8Array) => ApiResponse,
  ): Promise<unknown> {
    return this.enqueue(async () => {
      for (let attempt = 0; ; attempt++) {
        this.checkCircuit();
        const bytes = await this.request(endpoint, { method: "POST", body }, timeoutMs);
        // The HTTP status is always 200 on the device; only the body tells success or failure.
        const response = interpret(bytes);
        if (response.ok) {
          this.onAuthAccepted();
          return response.result;
        }
        const { code, message } = response.error;
        if (code === DeviceErrorCode.AUTH) {
          this.onAuthRejected();
          throw this.error(code, message);
        }
        this.onAuthAccepted();
        const delay = BUSY_RETRY_DELAYS_MS[attempt];
        if (code === DeviceErrorCode.BUSY && delay !== undefined) {
          await this.sleep(delay);
          continue;
        }
        throw this.error(code, message);
      }
    });
  }

  /** Fetches a static page from the device web server (e.g. help pages). */
  getText(path: string): Promise<string> {
    return this.enqueue(async () => {
      this.checkCircuit();
      return decoder.decode(
        await this.request(path, { method: "GET" }, this.options.timeoutMs, true),
      );
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private checkCircuit(): void {
    if (this.circuit === "open") {
      const waitMs = this.openUntil - this.now();
      if (waitMs > 0) {
        throw this.error(
          ServerErrorCode.CIRCUIT_OPEN,
          `Authentication failed; requests paused for another ${Math.ceil(waitMs / 1000)}s`,
        );
      }
      this.password = this.readPassword();
      this.circuit = "probing";
    } else if (this.circuit === "blocked") {
      const current = this.readPassword();
      if (current === this.password) {
        throw this.error(
          ServerErrorCode.AUTH_BLOCKED,
          `Authentication keeps failing (password from ${this.options.password.description}); fix the configuration`,
        );
      }
      this.password = current;
      this.circuit = "probing";
    }
  }

  private onAuthRejected(): void {
    if (this.circuit === "probing") {
      this.circuit = "blocked";
    } else {
      this.circuit = "open";
      this.openUntil = this.now() + AUTH_LOCKOUT_MS;
    }
  }

  private onAuthAccepted(): void {
    if (this.circuit === "probing") this.circuit = "closed";
  }

  private readPassword(): string {
    try {
      return this.options.password.read();
    } catch (error) {
      throw this.error(ServerErrorCode.AUTH_BLOCKED, (error as Error).message);
    }
  }

  private async request(
    path: string,
    init: { method: string; body?: string },
    timeoutMs: number,
    checkStatus = false,
  ): Promise<Uint8Array> {
    const auth = Buffer.from(`${this.options.user}:${this.password}`).toString("base64");
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, {
        ...init,
        headers: {
          authorization: `Basic ${auth}`,
          ...(init.body !== undefined && { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (checkStatus && !response.ok) {
        throw this.error(
          ServerErrorCode.BAD_RESPONSE,
          `GET ${path} returned HTTP ${response.status}`,
        );
      }
      return bytes;
    } catch (error) {
      if (error instanceof WebspsError) throw error;
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw this.error(ServerErrorCode.TIMEOUT, `No answer within ${timeoutMs}ms`);
      }
      const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
      throw this.error(ServerErrorCode.UNREACHABLE, `Cannot reach ${this.url}: ${cause}`);
    }
  }

  private parse(text: string): ApiResponse {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw this.error(
        ServerErrorCode.BAD_RESPONSE,
        `Device answered with non-JSON: ${text.slice(0, 120)}`,
      );
    }
    if (typeof json === "object" && json !== null && "ok" in json) {
      if (json.ok === true) return { ok: true, result: (json as { result?: unknown }).result };
      const error = (json as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof error?.code === "number") {
        return { ok: false, error: { code: error.code, message: String(error.message ?? "") } };
      }
    }
    throw this.error(
      ServerErrorCode.BAD_RESPONSE,
      `Unexpected device response: ${text.slice(0, 120)}`,
    );
  }

  private error(code: number, message: string): WebspsError {
    return new WebspsError(code, message, { device: this.alias });
  }
}
