import { z } from "zod";
import {
  fetchReadAll,
  MAX_BATCH,
  normalizeChannels,
  readChannelValues,
} from "../device/channels.js";
import { channelName, type OperandGroup } from "../device/readAll.js";
import type { Device } from "../device/registry.js";
import { deviceParam, handler, invalidInput, READ_ONLY, type ToolDefinition } from "./common.js";

/** Value groups up to this size are listed completely, larger ones only with non-zero values. */
const FULL_VALUE_GROUP_MAX = 16;

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
  const { timestamp, entries } = await readChannelValues(device, normalizeChannels(requested));
  const labels = await device.labels.get().catch(() => ({}) as Record<string, string>);
  return {
    device: device.alias,
    timestamp,
    channels: entries.map((entry) => {
      const label = labels[entry.channel];
      return label === undefined ? entry : { ...entry, label };
    }),
  };
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

export const ioUsage: ToolDefinition = {
  name: "io_usage",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "io_usage",
      {
        title: "Channel usage in rules",
        description: [
          "Shows which channel addresses the active rules reference and how often, e.g. to find a free marker before writing new rules.",
          'Without `type` returns the used channels of every operand type; with `type` (e.g. "M") also lists the free ones.',
        ].join(" "),
        inputSchema: z.object({ device: deviceParam(app), type: z.string().min(1).optional() }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, type }) => {
        const device = app.devices.resolve(alias);
        const result = await device.client.call<Record<string, unknown>>("io.read_used");
        const wanted = type?.toUpperCase();
        if (wanted !== undefined && !Array.isArray(result[wanted])) {
          const known = Object.keys(result).filter((k) => Array.isArray(result[k]));
          throw invalidInput(`Unknown operand type "${type}"; known: ${known.join(", ")}`);
        }

        const types: Record<string, unknown> = {};
        for (const [key, counts] of Object.entries(result)) {
          if (!Array.isArray(counts) || (wanted !== undefined && key !== wanted)) continue;
          const used: Record<string, number> = {};
          const free: string[] = [];
          counts.forEach((count: unknown, i) => {
            const channel = channelName(key, "bit", i);
            if (typeof count === "number" && count > 0) used[channel] = count;
            else free.push(channel);
          });
          types[key] = {
            total: counts.length,
            used_count: Object.keys(used).length,
            used,
            ...(wanted !== undefined && { free }),
          };
        }
        return { device: device.alias, types };
      }),
    );
  },
};

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
