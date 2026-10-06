import { DeviceErrorCode, WebspsError } from "../errors.js";
import type { DeviceClient } from "./client.js";

export const LABEL_TTL_MS = 60_000;

/** Caches `io.labels` per device so enriching `io_read` results does not double the requests. */
export class LabelCache {
  private cached: { at: number; labels: Record<string, string> } | undefined;

  constructor(
    private readonly client: DeviceClient,
    private readonly ttlMs = LABEL_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<Record<string, string>> {
    if (this.cached !== undefined && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.labels;
    }
    let labels: Record<string, string>;
    try {
      const result = await this.client.call<{ labels?: Record<string, string> }>("io.labels");
      labels = result.labels ?? {};
    } catch (error) {
      // Without permission there are no labels; cache that instead of asking again on every read.
      if (!(error instanceof WebspsError && error.code === DeviceErrorCode.FORBIDDEN)) throw error;
      labels = {};
    }
    this.cached = { at: this.now(), labels };
    return labels;
  }

  /** Call after the server itself changed a label (`io_label_set`). */
  invalidate(): void {
    this.cached = undefined;
  }
}
