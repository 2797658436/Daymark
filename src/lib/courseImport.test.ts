import { describe, expect, it } from "vitest";

import { parseCourseText } from "./courseImport";

describe("parseCourseText", () => {
  it("turns common episode lines into editable ordered task drafts", () => {
    expect(parseCourseText("P1 起步 12:30\n2. 数据建模 | 01:05:00\n- 收尾")).toEqual([
      { title: "起步", estimatedMinutes: 13, selected: true },
      { title: "数据建模", estimatedMinutes: 65, selected: true },
      { title: "收尾", estimatedMinutes: null, selected: true },
    ]);
  });

  it("ignores blank lines but keeps legitimate same-title episodes for preview", () => {
    expect(parseCourseText("第一节\n\n 第一节 \n第二节").map((item) => item.title)).toEqual(["第一节", "第一节", "第二节"]);
  });
});
