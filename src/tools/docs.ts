import { z } from "zod";
import { htmlToText } from "../device/htmlText.js";
import type { Device } from "../device/registry.js";
import { deviceParam, handler, READ_ONLY, type ToolDefinition } from "./common.js";

const TOPICS = {
  operators: async (device: Device) => device.client.call<unknown>("rules.operators"),
  rules_language: async (device: Device) =>
    htmlToText(await device.client.getText("/system/html/dat_rul.htm")),
  visualization: async (device: Device) =>
    htmlToText(await device.client.getText("/system/html/dat_vis.htm")),
  api: async (device: Device) => device.client.call<unknown>("api.describe"),
} as const;

type Topic = keyof typeof TOPICS;

/** Static device document, fetched once per process. */
export async function getDoc(device: Device, topic: Topic): Promise<unknown> {
  let content = device.docs.get(topic);
  if (content === undefined) {
    content = await TOPICS[topic](device);
    device.docs.set(topic, content);
  }
  return content;
}

export const docsGet: ToolDefinition = {
  name: "docs_get",
  profile: "read",
  register(server, app) {
    server.registerTool(
      "docs_get",
      {
        title: "Device documentation",
        description: [
          "Documentation served live by the device, matching its firmware:",
          "`operators` (machine-readable list of rules operators and their parameters),",
          "`rules_language` (rules language reference, operand ranges and examples),",
          "`visualization` (visualization pages and io.read_all fields), `api` (API methods and limits).",
          "Texts are in German as provided by the device.",
        ].join(" "),
        inputSchema: z.object({
          device: deviceParam(app),
          topic: z.enum(Object.keys(TOPICS) as [Topic, ...Topic[]]),
        }),
        annotations: READ_ONLY,
      },
      handler(async ({ device: alias, topic }) => {
        const device = app.devices.resolve(alias);
        return { device: device.alias, topic, content: await getDoc(device, topic) };
      }),
    );
  },
};
