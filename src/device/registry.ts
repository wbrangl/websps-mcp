import type { DeviceConfig } from "../config.js";
import { ServerErrorCode, WebspsError } from "../errors.js";
import { DeviceClient, type DeviceClientOptions } from "./client.js";
import { LabelCache } from "./labels.js";
import { LayoutCache } from "./readAll.js";

export interface Device {
  alias: string;
  url: string;
  client: DeviceClient;
  labels: LabelCache;
  layout: LayoutCache;
}

/**
 * All configured devices with their per-device state. Lives outside the MCP server factory so the
 * queue, circuit breaker and caches are shared by every connection of this process.
 */
export class DeviceRegistry {
  private readonly devices: Device[];

  constructor(configs: readonly DeviceConfig[], overrides: Partial<DeviceClientOptions> = {}) {
    this.devices = configs.map((config) => {
      const client = new DeviceClient({ ...config, ...overrides });
      return {
        alias: config.alias,
        url: client.url,
        client,
        labels: new LabelCache(client),
        layout: new LayoutCache(client),
      };
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
