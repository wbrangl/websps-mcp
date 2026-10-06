import { ServerErrorCode, WebspsError } from "../errors.js";
import { type UnpackedReadAll, unpackReadAll } from "./readAll.js";
import type { Device } from "./registry.js";

/** Device batch limit for `io.read`/`io.write`, not reported by `api.describe`. */
export const MAX_BATCH = 32;
/** Channel names are limited to 15 bytes on the device. */
export const MAX_CHANNEL_BYTES = 15;

export interface ChannelValue {
  channel: string;
  value?: number;
  error?: string;
}

/** Trims, de-duplicates and checks channel names before anything is sent to the device. */
export function normalizeChannels(requested: readonly string[]): string[] {
  const channels = [...new Set(requested.map((c) => c.trim()))];
  if (channels.length > MAX_BATCH) {
    throw new WebspsError(ServerErrorCode.INVALID_INPUT, `At most ${MAX_BATCH} channels per call`);
  }
  const tooLong = channels.find((c) => c === "" || Buffer.byteLength(c) > MAX_CHANNEL_BYTES);
  if (tooLong !== undefined) {
    throw new WebspsError(
      ServerErrorCode.INVALID_INPUT,
      `Invalid channel name "${tooLong}" (1-${MAX_CHANNEL_BYTES} bytes)`,
    );
  }
  return channels;
}

/**
 * Reads channel values. `io.read` does not serve every operand (counter/timer values CV/TV, and
 * analog channels on older firmware), so whatever it rejects is looked up in `io.read_all`.
 */
export async function readChannelValues(
  device: Device,
  channels: readonly string[],
): Promise<{ timestamp: string | undefined; entries: ChannelValue[] }> {
  // Always use the batch form: the single-channel form reports unknown channels misleadingly.
  const result = await device.client.call<{ channels?: ChannelValue[]; timestamp?: string }>(
    "io.read",
    { channels },
  );
  const entries = result.channels ?? [];

  if (entries.some((e) => e.error !== undefined)) {
    const values = new Map<string, number>();
    for (const group of (await fetchReadAll(device)).groups) {
      group.channels.forEach((channel, i) => {
        values.set(channel, group.values[i] as number);
      });
    }
    for (const entry of entries) {
      const value = entry.error !== undefined ? values.get(entry.channel) : undefined;
      if (value !== undefined) {
        entry.value = value;
        delete entry.error;
      }
    }
  }
  return { timestamp: result.timestamp, entries };
}

export async function fetchReadAll(device: Device): Promise<UnpackedReadAll> {
  const [result, layouts] = await Promise.all([
    device.client.call<Record<string, unknown>>("io.read_all"),
    device.layout.get(),
  ]);
  return unpackReadAll(result, layouts);
}
