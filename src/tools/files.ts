import { z } from "zod";
import { crc16Xmodem } from "../device/crc16.js";
import {
  DIRECTORIES,
  decodeText,
  isInternalRulesFile,
  MAX_FILE_BYTES,
  parseFilePath,
  TEXT_DIRECTORIES,
} from "../device/files.js";
import type { Device } from "../device/registry.js";
import { DeviceErrorCode, ServerErrorCode, WebspsError } from "../errors.js";
import { deviceParam, handler, invalidInput, READ_ONLY, type ToolDefinition } from "./common.js";

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
        const result = await device.client.call<Record<string, unknown>>("files.list", {
          directory,
        });
        return { device: device.alias, directory, ...result };
      }),
    );
  },
};

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

/**
 * Reads a file and checks it against the device's CRC: this tells content from an error body
 * and detects a change between hashing and reading (one retry).
 */
async function readVerified(device: Device, path: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const hash = await device.client.fileHash(path).catch((error: unknown) => {
      // The device refuses even to hash files above its size limit.
      if (error instanceof WebspsError && error.code === DeviceErrorCode.VALIDATION) {
        throw new WebspsError(error.code, error.message, {
          device: device.alias,
          hint: `Files above ${MAX_FILE_BYTES} bytes cannot be read through the device API; for the log file use log_read.`,
        });
      }
      throw error;
    });
    const bytes = await device.client.readFile(path);
    const crc16 = crc16Xmodem(bytes);
    if (crc16 === hash.crc16 && bytes.length === hash.bytes) return { bytes, crc16 };
  }
  throw new WebspsError(
    ServerErrorCode.BAD_RESPONSE,
    `${path} changed while reading or arrived incomplete; try again`,
    { device: device.alias },
  );
}
