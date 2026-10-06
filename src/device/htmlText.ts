const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  deg: "°",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  micro: "µ",
};

/** Converts a device help page to plain text: block elements become lines, cells are separated. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/table|\/pre|hr)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d?);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
      return NAMED_ENTITIES[entity] ?? match;
    });
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t\r\f\v]+/g, " ")
        .replace(/(\s*\|\s*)+$/, "")
        .trim(),
    )
    .filter((line) => line !== "" && line !== "|")
    .join("\n");
}
