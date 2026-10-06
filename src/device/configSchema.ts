import type { DeviceClient } from "./client.js";

export interface ConfigField {
  name: string;
  type: string;
  secret: boolean;
  critical: boolean;
  restart_required: boolean;
}

interface SchemaPage {
  page?: number;
  page_size?: number;
  total?: number;
  fields?: ConfigField[];
}

export const MASK = "***";
const MAX_PAGES = 20;
/** Safety net for secrets the schema does not flag (or when the schema is unavailable). */
const SECRET_NAME = /pass|secret|token|key$/i;

/** All fields of `config.schema` (the device pages them), cached per device. */
export class ConfigSchemaCache {
  private fields: ConfigField[] | undefined;

  constructor(private readonly client: DeviceClient) {}

  async get(): Promise<ConfigField[]> {
    if (this.fields !== undefined) return this.fields;
    const fields: ConfigField[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.client.call<SchemaPage>("config.schema", { page });
      const batch = result.fields ?? [];
      fields.push(...batch);
      const total = result.total ?? fields.length;
      if (batch.length === 0 || fields.length >= total) break;
    }
    this.fields = fields;
    return fields;
  }

  /**
   * Masks secrets regardless of the device user's `config_secrets` permission: an agent never gets
   * to see passwords. Empty values stay visible so "not set" remains recognizable.
   */
  async mask(values: Record<string, unknown>): Promise<Record<string, unknown>> {
    const secret = new Set<string>();
    try {
      for (const field of await this.get()) if (field.secret) secret.add(field.name);
    } catch {
      // schema unavailable: fall back to the name heuristic only
    }
    return Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        (secret.has(name) || SECRET_NAME.test(name)) && value !== "" ? MASK : value,
      ]),
    );
  }
}
