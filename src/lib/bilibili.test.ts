import { describe, expect, it } from "vitest";

import { extractBvid } from "./bilibili";

describe("Bilibili Beta links", () => {
  it("extracts a BV id from a plain id or video link", () => {
    expect(extractBvid("BV1xx411c7mD")).toBe("BV1xx411c7mD");
    expect(extractBvid("https://www.bilibili.com/video/BV1xx411c7mD?p=2")).toBe("BV1xx411c7mD");
  });

  it("rejects links without a BV id", () => {
    expect(() => extractBvid("https://www.bilibili.com/video/av123")).toThrow("BV");
  });
});
