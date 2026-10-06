import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { PROFILES, type Profile } from "./profiles.js";

export const DEFAULT_TIMEOUT_MS = 5000;
/** Reload-type methods block on the device for up to ~4s, plus queue latency. */
export const DEFAULT_METHOD_TIMEOUTS_MS: Readonly<Record<string, number>> = {
  "rules.reload": 10_000,
};
const DEFAULT_ENV_ALIAS = "websps";

/** Where a device password comes from; re-read when the auth circuit breaker probes again. */
export interface PasswordSource {
  /** e.g. `env WEBSPS_POOL_PW` — never the secret itself. */
  readonly description: string;
  read(): string;
}

export interface DeviceConfig {
  alias: string;
  url: string;
  user: string;
  password: PasswordSource;
  timeoutMs: number;
  methodTimeoutsMs: Record<string, number>;
}

export interface ServerConfig {
  profile: Profile;
  devices: DeviceConfig[];
}

export class ConfigError extends Error {}

const aliasSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "alias: 1-32 characters, letters, digits, '_' or '-'");
const urlSchema = z.url({ protocol: /^https?$/ });
const timeoutSchema = z.number().int().positive();

const fileSchema = z.strictObject({
  profile: z.enum(PROFILES).optional(),
  devices: z
    .array(
      z.strictObject({
        alias: aliasSchema,
        url: urlSchema,
        auth: z
          .strictObject({
            user: z.string().min(1),
            password_env: z.string().min(1).optional(),
            password_file: z.string().min(1).optional(),
          })
          .refine((a) => (a.password_env === undefined) !== (a.password_file === undefined), {
            message: "set exactly one of password_env or password_file",
          }),
        timeout_ms: timeoutSchema.optional(),
        timeouts_ms: z.record(z.string(), timeoutSchema).optional(),
      }),
    )
    .min(1),
});

type Env = Record<string, string | undefined>;

export interface LoadConfigOptions {
  argv?: readonly string[];
  env?: Env;
  readFile?: (path: string) => string;
}

/**
 * Configuration comes either from a JSON file (`--config <path>` or `WEBSPS_CONFIG`) for one or
 * more devices, or from `WEBSPS_URL`/`WEBSPS_USER`/`WEBSPS_PASSWORD[_FILE]` for a single device.
 * `WEBSPS_PROFILE` overrides the file's `profile`; the default profile is `read`.
 */
export function loadConfig(options: LoadConfigOptions = {}): ServerConfig {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const configPath = configPathFromArgs(options.argv ?? process.argv.slice(2)) ?? env.WEBSPS_CONFIG;

  if (configPath !== undefined && env.WEBSPS_URL !== undefined) {
    throw new ConfigError(
      "Use either a config file (--config / WEBSPS_CONFIG) or WEBSPS_URL, not both",
    );
  }

  const envProfile = parseProfile(env.WEBSPS_PROFILE);
  if (configPath !== undefined) {
    return loadFile(configPath, envProfile, env, readFile);
  }
  if (env.WEBSPS_URL !== undefined) {
    return { profile: envProfile ?? "read", devices: [deviceFromEnv(env, readFile)] };
  }
  throw new ConfigError(
    "No device configured: pass --config <file>, set WEBSPS_CONFIG, or set WEBSPS_URL/WEBSPS_USER/WEBSPS_PASSWORD",
  );
}

function configPathFromArgs(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError("--config needs a file path");
      return next;
    }
    if (arg?.startsWith("--config=")) return arg.slice("--config=".length);
  }
  return undefined;
}

function parseProfile(value: string | undefined): Profile | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = z.enum(PROFILES).safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`WEBSPS_PROFILE must be one of ${PROFILES.join(", ")}, got "${value}"`);
  }
  return parsed.data;
}

function loadFile(
  path: string,
  envProfile: Profile | undefined,
  env: Env,
  readFile: (path: string) => string,
): ServerConfig {
  let json: unknown;
  try {
    json = JSON.parse(readFile(path));
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config file ${path}:\n${z.prettifyError(parsed.error)}`);
  }

  const aliases = parsed.data.devices.map((d) => d.alias.toLowerCase());
  const duplicate = aliases.find((alias, i) => aliases.indexOf(alias) !== i);
  if (duplicate !== undefined) throw new ConfigError(`Duplicate device alias "${duplicate}"`);
  // The device locks out the requesting IP, not the user, and must see one request at a time:
  // two entries for the same device would bypass both protections.
  const hosts = parsed.data.devices.map((d) => new URL(d.url).host);
  const sameHost = hosts.find((host, i) => hosts.indexOf(host) !== i);
  if (sameHost !== undefined) {
    throw new ConfigError(
      `Device ${sameHost} is configured more than once; use one entry per device`,
    );
  }

  const baseDir = dirname(resolve(path));
  return {
    profile: envProfile ?? parsed.data.profile ?? "read",
    devices: parsed.data.devices.map((d) => ({
      alias: d.alias,
      url: d.url.replace(/\/+$/, ""),
      user: d.auth.user,
      password:
        d.auth.password_env !== undefined
          ? envPassword(d.auth.password_env, env)
          : filePassword(resolve(baseDir, d.auth.password_file as string), readFile),
      timeoutMs: d.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      methodTimeoutsMs: { ...DEFAULT_METHOD_TIMEOUTS_MS, ...d.timeouts_ms },
    })),
  };
}

function deviceFromEnv(env: Env, readFile: (path: string) => string): DeviceConfig {
  const url = urlSchema.safeParse(env.WEBSPS_URL);
  if (!url.success)
    throw new ConfigError(`WEBSPS_URL must be an http(s) URL, got "${env.WEBSPS_URL}"`);
  const alias = aliasSchema.safeParse(env.WEBSPS_ALIAS ?? DEFAULT_ENV_ALIAS);
  if (!alias.success)
    throw new ConfigError(`WEBSPS_ALIAS is invalid: ${alias.error.issues[0]?.message}`);
  const user = env.WEBSPS_USER;
  if (user === undefined || user === "")
    throw new ConfigError("WEBSPS_USER is required with WEBSPS_URL");

  const hasPassword = env.WEBSPS_PASSWORD !== undefined;
  const passwordFile = env.WEBSPS_PASSWORD_FILE;
  if (hasPassword === (passwordFile !== undefined)) {
    throw new ConfigError("Set exactly one of WEBSPS_PASSWORD or WEBSPS_PASSWORD_FILE");
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (env.WEBSPS_TIMEOUT_MS !== undefined) {
    const parsed = timeoutSchema.safeParse(Number(env.WEBSPS_TIMEOUT_MS));
    if (!parsed.success) throw new ConfigError("WEBSPS_TIMEOUT_MS must be a positive integer");
    timeoutMs = parsed.data;
  }

  return {
    alias: alias.data,
    url: url.data.replace(/\/+$/, ""),
    user,
    password:
      passwordFile !== undefined
        ? filePassword(resolve(passwordFile), readFile)
        : envPassword("WEBSPS_PASSWORD", env),
    timeoutMs,
    methodTimeoutsMs: { ...DEFAULT_METHOD_TIMEOUTS_MS },
  };
}

function envPassword(name: string, env: Env): PasswordSource {
  // Environment variables cannot change in a running process, so read once.
  const value = env[name];
  if (value === undefined)
    throw new ConfigError(`Environment variable ${name} (device password) is not set`);
  return { description: `env ${name}`, read: () => value };
}

function filePassword(path: string, readFile: (path: string) => string): PasswordSource {
  const read = () => {
    try {
      return readFile(path).replace(/\r?\n$/, "");
    } catch (error) {
      throw new ConfigError(`Cannot read password file ${path}: ${(error as Error).message}`);
    }
  };
  read();
  return { description: `file ${path}`, read };
}
