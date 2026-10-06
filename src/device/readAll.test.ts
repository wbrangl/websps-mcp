import { describe, expect, it } from "vitest";
import { VARIABLE_TABLE_HTML } from "../testing/fakeDevice.js";
import { channelName, parseVariableTable, unpackReadAll } from "./readAll.js";

describe("parseVariableTable", () => {
  it("reads field layouts from the ID tab only", () => {
    expect(parseVariableTable(VARIABLE_TABLE_HTML)).toEqual([
      {
        field: "HB",
        prefix: "H",
        naming: "bit",
        packed: true,
        description: "Melder",
        valueType: "VKE",
      },
      {
        field: "CV",
        prefix: "CV",
        naming: "bit",
        packed: false,
        description: "Counter",
        valueType: "Zählwert",
      },
      {
        field: "WAE",
        prefix: "AE",
        naming: "index",
        packed: false,
        description: "Analog Eingang",
        valueType: "Wert",
      },
      {
        field: "P",
        prefix: "PM",
        naming: "bit",
        packed: false,
        description: "Mbox",
        valueType: "Text",
      },
      {
        field: "SB",
        prefix: "S",
        naming: "bit",
        packed: true,
        description: "Schalter",
        valueType: "OP",
      },
    ]);
  });

  it("returns nothing for pages without the table", () => {
    expect(parseVariableTable("<html></html>")).toEqual([]);
  });
});

describe("unpackReadAll", () => {
  const layouts = parseVariableTable(VARIABLE_TABLE_HTML);

  it("unpacks bytes with bit 0 as the least significant bit", () => {
    const { groups } = unpackReadAll({ HB: [17, 4] }, layouts);
    const hb = groups[0];
    expect(hb?.channels.filter((_, i) => hb.values[i] === 1)).toEqual(["H0.0", "H0.4", "H1.2"]);
    expect(hb?.channels).toHaveLength(16);
  });

  it("names value fields by the table's naming style", () => {
    const { groups } = unpackReadAll(
      { CV: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5], WAE: [1.5, 2] },
      layouts,
    );
    expect(groups[0]?.channels[9]).toBe("CV1.1");
    expect(groups[0]?.values[9]).toBe(5);
    expect(groups[1]?.channels).toEqual(["AE0", "AE1"]);
    expect(groups[1]?.values).toEqual([1.5, 2]);
  });

  it("unpacks <Op>B fields missing from the table and passes the rest through", () => {
    const { groups, extra } = unpackReadAll(
      { WB: [2], ZZ: [1, 2], cycle: 14, timestamp: "t", XB: [300] },
      layouts,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ field: "WB", prefix: "W", packed: true });
    expect(groups[0]?.values.slice(0, 2)).toEqual([0, 1]);
    expect(extra).toEqual({ ZZ: [1, 2], cycle: 14, timestamp: "t", XB: [300] });
  });

  it("works without any table (generic rule only)", () => {
    const { groups, extra } = unpackReadAll({ SB: [1], CV: [3] }, []);
    expect(groups.map((g) => g.prefix)).toEqual(["S"]);
    expect(extra).toEqual({ CV: [3] });
  });
});

describe("channelName", () => {
  it("formats byte.bit and index names", () => {
    expect(channelName("M", "bit", 13)).toBe("M1.5");
    expect(channelName("SW", "index", 3)).toBe("SW3");
  });
});
