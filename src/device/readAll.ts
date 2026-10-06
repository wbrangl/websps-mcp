import type { DeviceClient } from "./client.js";

/**
 * Field layout of the `io.read_all` response, taken from the device's own help page
 * (table "Variablen ID") instead of being hard-coded, so it follows firmware changes.
 */
export const VARIABLE_TABLE_PATH = "/system/html/dat_vis.htm";
const TABLE_RETRY_MS = 5 * 60_000;

export interface FieldLayout {
  /** Field name in the `io.read_all` response, e.g. `HB`, `CV`, `WAE`. */
  field: string;
  /** Channel prefix, e.g. `H`, `CV`, `AE`. */
  prefix: string;
  /** `bit`: channels named `<prefix><byte>.<bit>`; `index`: `<prefix><index>`. */
  naming: "bit" | "index";
  /** Values are bytes holding 8 packed bits each. */
  packed: boolean;
  description?: string;
  valueType?: string;
}

export interface OperandGroup extends FieldLayout {
  channels: string[];
  values: number[];
}

export interface UnpackedReadAll {
  groups: OperandGroup[];
  /** Fields that could not be mapped to channels, passed through unchanged. */
  extra: Record<string, unknown>;
}

/** Parses the "Variablen ID" table; rows that do not describe a response field are skipped. */
export function parseVariableTable(html: string): FieldLayout[] {
  const start = html.search(/<div[^>]*\bid="ID"/i);
  if (start < 0) return [];
  const tableEnd = html.indexOf("</table>", start);
  const section = html.slice(start, tableEnd < 0 ? undefined : tableEnd);

  const layouts: FieldLayout[] = [];
  for (const row of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      cellText(c[1] ?? ""),
    );
    if (cells.length < 6) continue;
    const [, , description, valueType, fieldCell, idExample] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    // e.g. "HBx (Byte)", "CVxx", "WAE[x] (Array)"; the field name is the leading capitals.
    const field = /^[A-Z]+/.exec(fieldCell)?.[0];
    // e.g. "H0.0" (byte.bit naming) or "AE0" (index naming).
    const id = /^([A-Z]+)\d+(\.\d+)?$/.exec(idExample);
    if (field === undefined || id?.[1] === undefined) continue;
    layouts.push({
      field,
      prefix: id[1],
      naming: id[2] === undefined ? "index" : "bit",
      packed: /\(Byte\)/i.test(fieldCell),
      ...(description !== "" && { description }),
      ...(valueType !== "" && { valueType }),
    });
  }
  return layouts;
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function channelName(prefix: string, naming: "bit" | "index", index: number): string {
  return naming === "bit" ? `${prefix}${index >> 3}.${index & 7}` : `${prefix}${index}`;
}

/**
 * Unpacks an `io.read_all` result into channel/value pairs. Fields missing from the layout table
 * still unpack if they follow the generic `<Op>B` byte-array convention (e.g. `WB` → `W0.0`…).
 */
export function unpackReadAll(
  result: Record<string, unknown>,
  layouts: readonly FieldLayout[],
): UnpackedReadAll {
  const groups: OperandGroup[] = [];
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(result)) {
    const layout = layouts.find((l) => l.field === key) ?? genericLayout(key, value);
    if (layout === undefined || !isNumberArray(value)) {
      extra[key] = value;
      continue;
    }
    const channels: string[] = [];
    const values: number[] = [];
    if (layout.packed) {
      value.forEach((byte, i) => {
        for (let bit = 0; bit < 8; bit++) {
          channels.push(channelName(layout.prefix, "bit", i * 8 + bit));
          values.push((byte >> bit) & 1);
        }
      });
    } else {
      value.forEach((v, i) => {
        channels.push(channelName(layout.prefix, layout.naming, i));
        values.push(v);
      });
    }
    groups.push({ ...layout, channels, values });
  }
  return { groups, extra };
}

function genericLayout(key: string, value: unknown): FieldLayout | undefined {
  const match = /^([A-Z]+)B$/.exec(key);
  if (match?.[1] === undefined || !isNumberArray(value)) return undefined;
  if (!value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return undefined;
  return { field: key, prefix: match[1], naming: "bit", packed: true };
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}

/** Per-device cache of the layout table; on failure falls back to the generic rule only. */
export class LayoutCache {
  private layouts: FieldLayout[] | undefined;
  private failedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly client: DeviceClient,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<FieldLayout[]> {
    if (this.layouts !== undefined) return this.layouts;
    if (this.now() - this.failedAt < TABLE_RETRY_MS) return [];
    try {
      const layouts = parseVariableTable(await this.client.getText(VARIABLE_TABLE_PATH));
      if (layouts.length > 0) {
        this.layouts = layouts;
        return layouts;
      }
      console.error(`[${this.client.alias}] ${VARIABLE_TABLE_PATH}: no layout rows found`);
    } catch (error) {
      console.error(
        `[${this.client.alias}] cannot load ${VARIABLE_TABLE_PATH}: ${(error as Error).message}`,
      );
    }
    this.failedAt = this.now();
    return [];
  }
}
