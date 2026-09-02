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

  it("pairs a title line with the time on the following line", () => {
    expect(parseCourseText("使用说明\n23:19\n视频配套书籍在哪？\n00:16\nUnit1 Lesson 1\n58:39")).toEqual([
      { title: "使用说明", estimatedMinutes: 24, selected: true },
      { title: "视频配套书籍在哪？", estimatedMinutes: 1, selected: true },
      { title: "Unit1 Lesson 1", estimatedMinutes: 59, selected: true },
    ]);
  });

  it("pairs a time line that comes before its title", () => {
    expect(parseCourseText("23:19\n使用说明\n58:39\nUnit1 Lesson 1")).toEqual([
      { title: "使用说明", estimatedMinutes: 24, selected: true },
      { title: "Unit1 Lesson 1", estimatedMinutes: 59, selected: true },
    ]);
  });

  it("drops ellipsis and separator noise lines instead of creating fake tasks", () => {
    const drafts = parseCourseText("使用说明\n23:19\n...\nUnit1 Lesson 1\n58:39\n----\nUnit1 Lesson 2\n41:30");
    expect(drafts.map((item) => item.title)).toEqual(["使用说明", "Unit1 Lesson 1", "Unit1 Lesson 2"]);
    expect(drafts.map((item) => item.estimatedMinutes)).toEqual([24, 59, 42]);
  });

  it("lets a trailing same-line time win and still pairs later title-time lines", () => {
    expect(parseCourseText("Unit1 Lesson3-1 32:30\nUnit1 Lesson3-2\n43:49")).toEqual([
      { title: "Unit1 Lesson3-1", estimatedMinutes: 33, selected: true },
      { title: "Unit1 Lesson3-2", estimatedMinutes: 44, selected: true },
    ]);
  });
});
