import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasSubmittingEditor, hasUncommittedEditorDraft, resetEditorSessionRegistry, useEditorSession,
} from "./useEditorSession";

afterEach(() => resetEditorSessionRegistry());

/** 最小宿主：把 hook 暴露成按钮，方便用键盘与点击驱动状态转换。 */
function Harness({ sessionKey, onSave, onClose, initial = "初始" }: {
  sessionKey: string;
  onSave: (draft: string) => Promise<void>;
  onClose: (reason: "cancel" | "escape" | "saved") => void;
  initial?: string;
}) {
  const session = useEditorSession<string>({ key: sessionKey, initial, onSave, onClose });
  const saves = useRef(0);
  if (session.phase === "submitting") saves.current += 1;
  return (
    <div>
      <input aria-label="草稿" value={session.draft} onChange={(event) => session.setDraft(event.target.value)} />
      <button onClick={() => void session.save()}>保存</button>
      <button onClick={session.cancel}>取消</button>
      <output data-testid="phase">{session.phase}</output>
      <output data-testid="busy">{String(session.busy)}</output>
      <output data-testid="error">{session.error ?? ""}</output>
    </div>
  );
}

describe("useEditorSession", () => {
  it("提交期间同步锁 submitting，重复保存只发一次请求", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<Harness sessionKey="a" onSave={onSave} onClose={() => undefined} />);

    const save = screen.getByRole("button", { name: "保存" });
    await user.click(save);
    await user.click(save);
    await user.click(save);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("phase")).toHaveTextContent("submitting");
    expect(screen.getByTestId("busy")).toHaveTextContent("true");

    await act(async () => release());
    expect(screen.getByTestId("phase")).toHaveTextContent("editing");
  });

  it("提交期间取消无效，不会关闭", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let release!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<Harness sessionKey="a" onSave={onSave} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => release());
    expect(onClose).toHaveBeenCalledWith("saved");
  });

  it("失败时保留草稿并进入 error，可再次重试", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("写入失败"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    render(<Harness sessionKey="a" onSave={onSave} onClose={onClose} />);

    await user.clear(screen.getByLabelText("草稿"));
    await user.type(screen.getByLabelText("草稿"), "未保存的修改");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByTestId("phase")).toHaveTextContent("error");
    expect(screen.getByTestId("error")).toHaveTextContent("写入失败");
    expect(screen.getByLabelText("草稿")).toHaveValue("未保存的修改");   // 草稿原样保留
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledWith("saved");
  });

  it("会话换成另一个对象后，旧请求的结果被丢弃，不关闭也不覆盖", async () => {
    const user = userEvent.setup();
    let releaseA!: () => void;
    const onSaveA = vi.fn(() => new Promise<void>((resolve) => { releaseA = resolve; }));
    const onCloseA = vi.fn();
    const { rerender } = render(<Harness sessionKey="a" onSave={onSaveA} onClose={onCloseA} initial="对象 A" />);

    await user.click(screen.getByRole("button", { name: "保存" }));   // 对象 A 开始提交
    expect(screen.getByTestId("phase")).toHaveTextContent("submitting");

    // 切到对象 B：即便 A 的请求随后成功，也不得关闭 B 的编辑器。
    const onSaveB = vi.fn(() => Promise.resolve());
    const onCloseB = vi.fn();
    rerender(<Harness sessionKey="b" onSave={onSaveB} onClose={onCloseB} initial="对象 B" />);
    expect(screen.getByLabelText("草稿")).toHaveValue("对象 B");

    await act(async () => releaseA());
    expect(onCloseA).not.toHaveBeenCalledWith("saved");
    expect(onCloseB).not.toHaveBeenCalled();
    expect(screen.getByLabelText("草稿")).toHaveValue("对象 B");       // 未被 A 的结果覆盖
  });

  it("取消走「明确放弃」路径，不写库", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(<Harness sessionKey="a" onSave={onSave} onClose={onClose} />);

    await user.clear(screen.getByLabelText("草稿"));
    await user.type(screen.getByLabelText("草稿"), "改了但不保存");
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("cancel");
  });

  it("canSave 为 false 时不发请求", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    function BlankHarness() {
      const session = useEditorSession<string>({ key: "a", initial: "", onSave, onClose, canSave: (draft) => draft.trim().length > 0 });
      return <button onClick={() => void session.save()}>保存</button>;
    }
    render(<BlankHarness />);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("上报 phase 变化，供外层在提交期间拦住 Esc", async () => {
    const user = userEvent.setup();
    const phases: string[] = [];
    let release!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    function PhaseHarness() {
      const [busy, setBusy] = useState(false);
      const session = useEditorSession<string>({
        key: "a", initial: "x", onSave, onClose: () => undefined,
        onPhaseChange: (phase) => { phases.push(phase); setBusy(phase === "submitting"); },
      });
      return <div><button onClick={() => void session.save()}>保存</button><output data-testid="outer-busy">{String(busy)}</output></div>;
    }
    render(<PhaseHarness />);
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByTestId("outer-busy")).toHaveTextContent("true");
    await act(async () => release());
    expect(phases).toContain("submitting");
    expect(phases.at(-1)).toBe("editing");
  });
});

describe("活动会话注册表（B4：破坏性动作前的检查）", () => {
  it("没有会话时既无草稿也无提交", () => {
    expect(hasUncommittedEditorDraft()).toBe(false);
    expect(hasSubmittingEditor()).toBe(false);
  });

  it("有改动的会话会被登记为未提交草稿", async () => {
    const user = userEvent.setup();
    render(<Harness sessionKey="a" onSave={() => Promise.resolve()} onClose={() => undefined} />);
    expect(hasUncommittedEditorDraft()).toBe(false);

    await user.type(screen.getByLabelText("草稿"), "改了点东西");
    expect(hasUncommittedEditorDraft()).toBe(true);
  });

  it("提交中的会话会被登记为 busy，破坏性动作应等待", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    render(<Harness sessionKey="a" onSave={onSave} onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(hasSubmittingEditor()).toBe(true);

    await act(async () => release());
    expect(hasSubmittingEditor()).toBe(false);
  });

  it("会话卸载后从注册表移除，不会残留脏状态", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness sessionKey="a" onSave={() => Promise.resolve()} onClose={() => undefined} />);
    await user.type(screen.getByLabelText("草稿"), "临时改动");
    expect(hasUncommittedEditorDraft()).toBe(true);

    unmount();
    expect(hasUncommittedEditorDraft()).toBe(false);
  });
});
