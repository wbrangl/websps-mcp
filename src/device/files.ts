import { ServerErrorCode, WebspsError } from "../errors.js";

/**
 * Directory names the server knows for the `/files` endpoint. Which of them a device actually
 * offers comes from its `api.describe` (see `fileAreas` in tools/files.ts); `svg` was renamed to
 * `scripts` in newer firmware and stays valid as an alias.
 */
export const DIRECTORIES = [
  "rules",
  "log",
  "rec",
  "mails",
  "scripts",
  "svg",
  "pic",
  "img",
  "htm",
] as const;
export type Directory = (typeof DIRECTORIES)[number];
/** Binary directories have no wire format on the device yet. */
export const TEXT_DIRECTORIES: readonly Directory[] = [
  "rules",
  "log",
  "rec",
  "mails",
  "scripts",
  "svg",
  "htm",
];
/** Older firmware does not report its directories in api.describe. */
export const LEGACY_READABLE: readonly string[] = [
  "rules",
  "log",
  "rec",
  "mails",
  "svg",
  "pic",
  "img",
  "htm",
];
export const LEGACY_WRITABLE: readonly string[] = ["rules", "mails", "svg", "htm"];
/** Old name → new name; the device accepts the old one as an alias. */
export const DIRECTORY_ALIASES: Readonly<Record<string, string>> = { svg: "scripts" };
/** Device limit per file for `/files`; larger files cannot be read through the API at all. */
export const MAX_FILE_BYTES = 32767;

const RULES_INTERNAL_FILE = "SYMBOLIK.INI";

/**
 * Internal files in `rules/` that the server hides from listings and never writes: the channel
 * labels (only via `io_label_set`) and the device's single-generation backups.
 */
export function isInternalRulesFile(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === RULES_INTERNAL_FILE || upper.endsWith(".BAK");
}

/** Validates `<directory>/<name>`; `name` must be a plain file name (no path, no `..`). */
export function parseFilePath(path: string): { directory: Directory; name: string } {
  const match = /^([a-z]+)\/([^/\\]+)$/i.exec(path.trim());
  const directory = match?.[1]?.toLowerCase() as Directory | undefined;
  const name = match?.[2];
  if (directory === undefined || name === undefined || !DIRECTORIES.includes(directory)) {
    throw new WebspsError(
      ServerErrorCode.INVALID_INPUT,
      `Path must be <directory>/<file> with directory one of ${DIRECTORIES.join(", ")}`,
    );
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new WebspsError(ServerErrorCode.INVALID_INPUT, `Invalid file name "${name}"`);
  }
  return { directory, name };
}

/** Text as UTF-8 when valid, otherwise Latin-1 (older DOS-era files); the bytes are unchanged. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: "utf-8" | "latin1" } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("latin1").decode(bytes), encoding: "latin1" };
  }
}
