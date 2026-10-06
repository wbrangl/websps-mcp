import { z } from "zod";
import { type OperandGroup, type UnpackedReadAll, unpackReadAll } from "../device/readAll.js";
import type { Device } from "../device/registry.js";
import { deviceParam, handler, invalidInput, READ_ONLY, type ToolDefinition } from "./common.js";

/** Device batch limit for `io.read`/`io.write`, not reported by `api.describe`. */
export const MAX_BATCH = 32;
/** Channel names are limited to 15 bytes on the device. */
export const MAX_CHANNEL_BYTES = 15;
/** Value groups up to this size are listed completely, larger ones only with non-zero values. */
const FULL_VALUE_GROUP_MAX = 16;

interface IoReadEntry {
  channel: string;
  value?: number;
  error?: string;
}

export const ioRead: ToolDefinition = {
  name: "io_read",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "io_read",
      {
        title: "Read channels",
        description: [
          "Read current values of Web@SPS operands, e.g. S0.0 (visu switch), A0.0 (output), M0.0 (marker), AE0 (analog input).",
          "Counters/timers: C0.0/T0.0 return only the 'preset reached' flag (0/1); read CV0.0/TV0.0 for the counter/timer value.",
          `Either pass up to ${MAX_BATCH} \`channels\`, or \`all: true\` for the complete state of all operands`,
          '(optionally narrowed with `types`, e.g. ["S","A","AE"]); for bit operands `all` lists only the channels that are 1.',
          "Results include the channel label when one is set on the device.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          channels: z.array(z.string().min(1)).min(1).max(MAX_BATCH).optional(),
          all: z.boolean().optional(),
          types: z.array(z.string().min(1)).min(1).optional(),
        }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, channels, all, types }) => {
        const device = app.devices.resolve(alias);
        if ((channels === undefined) === (all !== true)) {
          throw invalidInput("Pass either `channels` or `all: true`");
        }
        if (channels !== undefined) return readChannels(device, channels);
        return readAll(device, types);
      }),
    );
  },
};

async function readChannels(device: Device, requested: string[]): Promise<Record<string, unknown>> {
  const channels = [...new Set(requested.map((c) => c.trim()))];
  const tooLong = channels.find((c) => Buffer.byteLength(c) > MAX_CHANNEL_BYTES);
  if (tooLong !== undefined) {
    throw invalidInput(`Channel name "${tooLong}" exceeds ${MAX_CHANNEL_BYTES} bytes`);
  }

  // Always use the batch form: the single-channel form reports unknown channels misleadingly.
  const result = await device.client.call<{ channels?: IoReadEntry[]; timestamp?: string }>(
    "io.read",
    { channels },
  );
  const entries = result.channels ?? [];

  // io.read does not serve value operands such as counters, timers and analog channels;
  // take those from io.read_all instead.
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

  const labels = await device.labels.get().catch(() => ({}) as Record<string, string>);
  return {
    device: device.alias,
    timestamp: result.timestamp,
    channels: entries.map((entry) => {
      const label = labels[entry.channel];
      return label === undefined ? entry : { ...entry, label };
    }),
  };
}

async function fetchReadAll(device: Device): Promise<UnpackedReadAll> {
  const [result, layouts] = await Promise.all([
    device.client.call<Record<string, unknown>>("io.read_all"),
    device.layout.get(),
  ]);
  return unpackReadAll(result, layouts);
}

async function readAll(
  device: Device,
  types: string[] | undefined,
): Promise<Record<string, unknown>> {
  const { groups, extra } = await fetchReadAll(device);
  const labels = await device.labels.get().catch(() => ({}) as Record<string, string>);
  const wanted = types?.map((t) => t.toUpperCase());

  const byPrefix: Record<string, unknown> = {};
  const labeled: Record<string, { label: string; value: number }> = {};
  for (const group of groups) {
    if (wanted !== undefined && !wanted.includes(group.prefix)) continue;
    const key = group.prefix in byPrefix ? group.field : group.prefix;
    byPrefix[key] = summarize(group);
    group.channels.forEach((channel, i) => {
      const label = labels[channel];
      if (label !== undefined) labeled[channel] = { label, value: group.values[i] as number };
    });
  }

  const { timestamp, ...rest } = extra;
  return { device: device.alias, timestamp, operands: byPrefix, labeled, extra: rest };
}

function summarize(group: OperandGroup): Record<string, unknown> {
  const meta = {
    ...(group.description !== undefined && { description: group.description }),
    ...(group.valueType !== undefined && { value_type: group.valueType }),
    count: group.channels.length,
  };
  if (group.packed) {
    return { ...meta, on: group.channels.filter((_, i) => group.values[i] === 1) };
  }
  const full = group.channels.length <= FULL_VALUE_GROUP_MAX;
  const values: Record<string, number> = {};
  group.channels.forEach((channel, i) => {
    const value = group.values[i] as number;
    if (full || value !== 0) values[channel] = value;
  });
  return full ? { ...meta, values } : { ...meta, values, zero_omitted: true };
}

export const ioLabels: ToolDefinition = {
  name: "io_labels",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "io_labels",
      {
        title: "Channel labels",
        description:
          'Human-readable labels of channels as set on the device, e.g. {"S0.0":"Pool pump on"}. Use it to resolve names to channels. Channels without a label are not listed.',
        inputSchema: z.object({ device: deviceParam(app) }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias }) => {
        const device = app.devices.resolve(alias);
        return { device: device.alias, labels: await device.labels.get() };
      }),
    );
  },
};
