import { describe, expect, it } from "vitest";
import type { DeviceClient } from "./client.js";
import { ConfigSchemaCache } from "./configSchema.js";
import { decodeText, isInternalRulesFile, parseFilePath } from "./files.js";
import { htmlToText } from "./htmlText.js";

describe("parseFilePath", () => {
  it("accepts <directory>/<file>", () => {
    expect(parseFilePath("RULES/Test.txt")).toEqual({ directory: "rules", name: "Test.txt" });
  });

  it.each(["rules", "rules/", "rules/a/b.txt", "rules/..", "rules/..x", "etc/passwd", "rules\\x"])(
    "rejects %s",
    (path) => {
      expect(() => parseFilePath(path)).toThrow();
    },
  );
});

describe("isInternalRulesFile", () => {
  it("hides the label file and backups", () => {
    expect(isInternalRulesFile("symbolik.ini")).toBe(true);
    expect(isInternalRulesFile("ANALOG.BAK")).toBe(true);
    expect(isInternalRulesFile("ANALOG.TXT")).toBe(false);
  });
});

describe("decodeText", () => {
  it("falls back to Latin-1 for non-UTF-8 bytes", () => {
    expect(decodeText(new TextEncoder().encode("Grüße"))).toEqual({
      text: "Grüße",
      encoding: "utf-8",
    });
    expect(decodeText(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toEqual({
      text: "Grüße",
      encoding: "latin1",
    });
  });
});

describe("ConfigSchemaCache.mask", () => {
  const client = (fields: unknown[] | Error) =>
    ({
      call: async () => {
        if (fields instanceof Error) throw fields;
        return { page: 0, page_size: 10, total: fields.length, fields };
      },
    }) as unknown as DeviceClient;

  it("masks fields flagged as secret and secret-looking names", async () => {
    const cache = new ConfigSchemaCache(
      client([
        { name: "mail_login", secret: true },
        { name: "device_name", secret: false },
      ]),
    );
    expect(
      await cache.mask({
        mail_login: "x",
        device_name: "Pool",
        user1_password: "y",
        api_token: "",
      }),
    ).toEqual({ mail_login: "***", device_name: "Pool", user1_password: "***", api_token: "" });
  });

  it("still masks by name when the schema is unavailable", async () => {
    const cache = new ConfigSchemaCache(client(new Error("down")));
    expect(await cache.mask({ admin_password: "x", device_name: "Pool" })).toEqual({
      admin_password: "***",
      device_name: "Pool",
    });
  });
});

describe("htmlToText", () => {
  it("keeps lines and table cells readable", () => {
    expect(
      htmlToText(
        "<head><title>x</title></head><h1>Titel</h1><p>A&nbsp;&amp;&#38; B<br>C</p><table><tr><td>1</td><td>2</td></tr></table><script>no()</script>",
      ),
    ).toBe("Titel\nA && B\nC\n1 | 2");
  });
});
