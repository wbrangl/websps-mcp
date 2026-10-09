import { z } from "zod";
import { encodeText, readVerified, safeWrite } from "../device/fileOps.js";
import {
  DIRECTORIES,
  DIRECTORY_ALIASES,
  decodeText,
  isInternalRulesFile,
  LEGACY_READABLE,
  LEGACY_WRITABLE,
  MAX_FILE_BYTES,
  parseFilePath,
  TEXT_DIRECTORIES,
} from "../device/files.js";
import type { Device } from "../device/registry.js";
import {
  auditedHandler,
  DESTRUCTIVE,
  deviceParam,
  handler,
  invalidInput,
  READ_ONLY,
  type ToolDefinition,
  WRITES,
} from "./common.js";
import { getDoc } from "./docs.js";

interface RulesList {
  root?: string;
  files?: { name: string; size: number; is_root: boolean }[];
}

export const fileList: ToolDefinition = {
  name: "file_list",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "file_list",
      {
        title: "List files",
        description:
          "List the files of a device directory. For `rules` the active root rules file is marked; internal files (SYMBOLIK.INI, .BAK backups) are not listed.",
        inputSchema: z.object({ device: deviceParam(app), directory: z.enum(DIRECTORIES) }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, directory }) => {
        const device = app.devices.resolve(alias);
        if (directory === "rules") {
          // rules.list also tells which file is the active root.
          const result = await device.client.call<RulesList>("rules.list");
          return {
            device: device.alias,
            directory,
            root: result.root,
            files: (result.files ?? []).filter((f) => !isInternalRulesFile(f.name)),
          };
        }
        requireArea((await fileAreas(device)).readable, directory, "listed");
        return { device: device.alias, directory, files: await listFiles(device, directory) };
      }),
    );
  },
};

const MAX_LIST_PAGES = 20;

interface FilesPage {
  limit?: number;
  files?: string[];
}

/** `files.list` pages names (32 per page) and pads each page with "-". */
async function listFiles(device: Device, directory: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await device.client.call<FilesPage>("files.list", { directory, page });
    const real = (result.files ?? []).filter((name) => name !== "-" && name !== "");
    names.push(...real);
    if (real.length < (result.limit ?? 32)) break;
  }
  return names;
}

interface FileAreasDescribe {
  file_endpoint_prefixes?: string[];
  file_endpoint_write_prefixes?: string[];
}

/**
 * Readable and writable directories as the device reports them in api.describe, so renames on the
 * firmware side (svg/ → scripts/) need no server change; older firmware without these fields gets
 * the previously known lists. Old names stay accepted next to their new ones (the device keeps
 * them as aliases).
 */
export async function fileAreas(
  device: Device,
): Promise<{ readable: Set<string>; writable: Set<string> }> {
  const describe = (await getDoc(device, "api").catch(() => undefined)) as
    | FileAreasDescribe
    | undefined;
  const names = (prefixes: string[] | undefined, fallback: readonly string[]) => {
    const set = new Set(prefixes?.map((p) => p.replace(/\/+$/, "")) ?? fallback);
    for (const [old, renamed] of Object.entries(DIRECTORY_ALIASES)) {
      if (set.has(renamed)) set.add(old);
    }
    return set;
  };
  return {
    readable: names(describe?.file_endpoint_prefixes, LEGACY_READABLE),
    writable: names(describe?.file_endpoint_write_prefixes, LEGACY_WRITABLE),
  };
}

function requireArea(areas: Set<string>, directory: string, action: string): void {
  if (!areas.has(directory)) {
    throw invalidInput(
      `${directory}/ cannot be ${action} on this device; available: ${[...areas].join(", ")}`,
    );
  }
}

export const fileRead: ToolDefinition = {
  name: "file_read",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "file_read",
      {
        title: "Read file",
        description: [
          `Read a text file from the device, e.g. \`rules/ANALOG.TXT\` (max ${MAX_FILE_BYTES} bytes; larger files such as the log file cannot be read through the API, use log_read).`,
          "Returns the content and its `crc16`, which is the `expected_hash` for a later write of this file.",
        ].join(" "),
        inputSchema: z.object({ device: deviceParam(app), path: z.string().min(1) }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, path }) => {
        const device = app.devices.resolve(alias);
        const { directory, name } = parseFilePath(path);
        requireArea((await fileAreas(device)).readable, directory, "read");
        if (!TEXT_DIRECTORIES.includes(directory)) {
          throw invalidInput(`Binary files in ${directory}/ are not supported`);
        }
        const normalized = `${directory}/${name}`;
        const { bytes, crc16 } = await readVerified(device, normalized);
        const { text, encoding } = decodeText(bytes);
        return {
          device: device.alias,
          path: normalized,
          bytes: bytes.length,
          crc16,
          encoding,
          content: text,
        };
      }),
    );
  },
};

/** Writable through file_write; rules go through rules_write (validation, activation). */
export const fileWrite: ToolDefinition = {
  name: "file_write",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "file_write",
      {
        title: "Write file",
        description: [
          "Write a text file in a writable device directory other than rules/, typically mails/ (mail templates), scripts/ (svg/ on older firmware) and htm/ (visualization pages).",
          "Rules files: use rules_write; channel labels: io_labels_set.",
          "To change an existing file pass `expected_hash` (the crc16 from file_read); the previous content is kept as a backup on the server.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          path: z.string().min(1),
          content: z.string(),
          encoding: z.enum(["utf-8", "latin1"]).optional(),
          expected_hash: z.number().int().min(0).max(0xffff).optional(),
        }),
        annotations: WRITES,
      },
      auditedHandler(
        app,
        "file_write",
        ({ content, ...rest }) => ({ ...rest, content_bytes: Buffer.byteLength(content) }),
        async (device, { path, content, encoding, expected_hash }) => {
          const { directory, name } = parseFilePath(path);
          if (directory === "rules") {
            throw invalidInput(
              isInternalRulesFile(name)
                ? `${name} is managed by the device; use io_labels_set / io_label_set for labels`
                : "Use rules_write for rules files (it validates them first)",
            );
          }
          requireArea((await fileAreas(device)).writable, directory, "written");
          const outcome = await safeWrite(
            device,
            `${directory}/${name}`,
            encodeText(content, encoding ?? "utf-8"),
            expected_hash,
          );
          return { device: device.alias, ...outcome };
        },
        ({ path, crc16, created, backup }) => ({ path, crc16, created, backup }),
      ),
    );
  },
};

export const fileDelete: ToolDefinition = {
  name: "file_delete",
  profile: "develop",
  register(server, app) {
    server.registerTool(
      "file_delete",
      {
        title: "Delete file",
        description:
          "Delete a file on the device; the content is kept as a backup on the server. The active root rules file and internal files cannot be deleted.",
        inputSchema: z.object({ device: deviceParam(app), path: z.string().min(1) }),
        annotations: DESTRUCTIVE,
      },
      auditedHandler(
        app,
        "file_delete",
        (args) => ({ ...args }),
        async (device, { path }) => {
          const { directory, name } = parseFilePath(path);
          if (directory !== "rules") {
            requireArea((await fileAreas(device)).writable, directory, "deleted");
          }
          if (directory === "rules" && isInternalRulesFile(name)) {
            throw invalidInput(`${name} is managed by the device and cannot be deleted here`);
          }
          if (directory === "rules") {
            const root = await device.client.call<{
              configured_root?: string;
              loaded_root?: string;
            }>("rules.get_root");
            const upper = name.toUpperCase();
            if (root.configured_root === upper || root.loaded_root === upper) {
              throw invalidInput(
                `${upper} is the active root rules file; activate another file first`,
              );
            }
          }
          const normalized = `${directory}/${name}`;
          const old = TEXT_DIRECTORIES.includes(directory)
            ? await readVerified(device, normalized)
            : undefined;
          const backup =
            old !== undefined ? await device.backups.save(normalized, old.bytes) : undefined;
          // rules.delete protects the active root file (never pass `force`); files.delete has no
          // such protection and takes the directory and file name separately.
          const result =
            directory === "rules"
              ? await device.client.call<Record<string, unknown>>("rules.delete", { name })
              : await device.client.call<Record<string, unknown>>("files.delete", {
                  directory,
                  filename: name,
                });
          return {
            device: device.alias,
            path: normalized,
            ...(backup !== undefined && { backup }),
            result,
          };
        },
        ({ path, backup }) => ({ path, backup }),
      ),
    );
  },
};
