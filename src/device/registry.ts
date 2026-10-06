import { join } from "node:path";
import type { DeviceConfig } from "../config.js";
import { ServerErrorCode, WebspsError } from "../errors.js";
import { AuditLog, BackupStore } from "./audit.js";
import { DeviceClient, type DeviceClientOptions } from "./client.js";
import { ConfigSchemaCache } from "./configSchema.js";
import { ConsoleLog } from "./consoleLog.js";
import { LabelCache } from "./labels.js";
import { DeviceLock } from "./lock.js";
import { LayoutCache } from "./readAll.js";
import { Sampler } from "./sampler.js";

export interface Device {
  alias: string;
  url: string;
  client: DeviceClient;
  labels: LabelCache;
  layout: LayoutCache;
  configSchema: ConfigSchemaCache;
  consoleLog: ConsoleLog;
  sampler: Sampler;
  audit: AuditLog;
  backups: BackupStore;
  /** Static device documents (help pages, operator list), cached for the process lifetime. */
  docs: Map<string, unknown>;
}

/**
 * All configured devices with their per-device state. Lives outside the MCP server factory so the
 * queue, circuit breaker and caches are shared by every connection of this process.
 */
export class DeviceRegistry {
  private readonly devices: Device[];

  constructor(
    configs: readonly DeviceConfig[],
    stateDir: string,
    overrides: Partial<DeviceClientOptions> = {},
  ) {
    this.devices = configs.map((config) => {
      const dir = join(stateDir, config.alias);
      const client = new DeviceClient({
        ...config,
        lock: new DeviceLock(join(dir, "device.lock")),
        ...overrides,
      });
      const device = {
        alias: config.alias,
        url: client.url,
        client,
        labels: new LabelCache(client),
        layout: new LayoutCache(client),
        configSchema: new ConfigSchemaCache(client),
        consoleLog: new ConsoleLog(client, join(dir, "console.jsonl")),
        docs: new Map<string, unknown>(),
        audit: new AuditLog(join(dir, "audit.jsonl")),
        backups: new BackupStore(join(dir, "backups")),
      } as Device;
      device.sampler = new Sampler(device, join(dir, "samples"));
      return device;
    });
  }

  get aliases(): string[] {
    return this.devices.map((d) => d.alias);
  }

  list(): readonly Device[] {
    return this.devices;
  }

  /** `alias` may be omitted only when exactly one device is configured. */
  resolve(alias: string | undefined): Device {
    if (alias === undefined) {
      const [only, ...rest] = this.devices;
      if (only !== undefined && rest.length === 0) return only;
      throw new WebspsError(
        ServerErrorCode.UNKNOWN_DEVICE,
        `Several devices are configured; pass device as one of: ${this.aliases.join(", ")}`,
      );
    }
    const device = this.devices.find((d) => d.alias.toLowerCase() === alias.toLowerCase());
    if (device !== undefined) return device;
    throw new WebspsError(
      ServerErrorCode.UNKNOWN_DEVICE,
      `Unknown device "${alias}"; configured: ${this.aliases.join(", ")}`,
    );
  }
}
