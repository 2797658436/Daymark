import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { FloatingPanel } from "./floating-panel";
import { OverlayHostProvider } from "./overlay-host";

/** 复现真实调用形状：宿主在顶层，`.app-shell` 是背景容器，气泡是它的兄弟。 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <OverlayHostProvider>
      <div className="app-shell">
        <button>背景按钮</button>
      </div>
      {children}
    </OverlayHostProvider>
  );
}

function EditorHarness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Shell>
      <button onClick={() => setOpen(true)}>打开编辑器</button>
      {open && (
        <FloatingPanel label="编辑示例" busy={busy} onClose={() => setOpen(false)}>
          <label>标题<input /></label>
          <button>确定</button>
        </FloatingPanel>
      )}
    </Shell>
  );
}

function FormHarness() {
  const [open, setOpen] = useState(false);
  return (
    <Shell>
      <button onClick={() => setOpen(true)}>打开表单</button>
      {open && (
        <FloatingPanel label="编辑表单" onClose={() => setOpen(false)}>
          <form onSubmit={(event) => event.preventDefault()}>
            <label>标题<input /></label>
            <button type="submit">保存</button>
          </form>
        </FloatingPanel>
      )}
    </Shell>
  );
}

describe("浮层与编辑气泡语义（M8）", () => {
  it("编辑气泡是模态：背景 inert、带 aria-modal、可访问名沿用 label", async () => {
    const user = userEvent.setup();
    render(<EditorHarness />);
    await user.click(screen.getByRole("button", { name: "打开编辑器" }));

    const dialog = screen.getByRole("dialog", { name: "编辑示例" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.querySelector(".app-shell")).toHaveAttribute("inert");
  });

  it("背景在浮层打开时不可聚焦（Tab 不落到背景）", async () => {
    const user = userEvent.setup();
    render(<EditorHarness />);
    await user.click(screen.getByRole("button", { name: "打开编辑器" }));

    const dialog = screen.getByRole("dialog", { name: "编辑示例" });
    // 注意：jsdom 不实现 inert 的聚焦屏蔽，背景是否真的不可聚焦由 E2E 覆盖
    // （e2e/gui-optimization.spec.ts 与 B3 探针均已在真实浏览器验证）。
    // 这里只断言 Tab 循环把焦点留在气泡内。
    for (let index = 0; index < 8; index += 1) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.querySelector(".app-shell")).toHaveAttribute("inert");
  });

  it("Esc 关闭后焦点回到触发元素", async () => {
    const user = userEvent.setup();
    render(<EditorHarness />);
    const trigger = screen.getByRole("button", { name: "打开编辑器" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "编辑示例" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "编辑示例" })).not.toBeInTheDocument();
    // 焦点归还走 requestAnimationFrame
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    expect(trigger).toHaveFocus();
  });

  it("busy 期间 Esc 不关闭气泡", async () => {
    const user = userEvent.setup();
    render(<EditorHarness busy />);
    await user.click(screen.getByRole("button", { name: "打开编辑器" }));

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "编辑示例" })).toBeInTheDocument();
  });

  it("两个浮层叠开时，关掉内层不会解除外层的背景保护", async () => {
    const user = userEvent.setup();
    function Stacked() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return (
        <Shell>
          <button onClick={() => setOuter(true)}>开外层</button>
          {outer && (
            <FloatingPanel label="外层编辑" onClose={() => setOuter(false)}>
              <button onClick={() => setInner(true)}>开内层</button>
            </FloatingPanel>
          )}
          {inner && (
            <FloatingPanel label="内层确认" onClose={() => setInner(false)}>
              <button>内层动作</button>
            </FloatingPanel>
          )}
        </Shell>
      );
    }
    render(<Stacked />);
    await user.click(screen.getByRole("button", { name: "开外层" }));
    await user.click(within(screen.getByRole("dialog", { name: "外层编辑" })).getByRole("button", { name: "开内层" }));
    expect(screen.getByRole("dialog", { name: "内层确认" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "内层确认" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "外层编辑" })).toBeInTheDocument();
    // 关键：栈非空，背景必须仍然 inert（原 useModalBehavior 会无条件解除）
    expect(document.querySelector(".app-shell")).toHaveAttribute("inert");
  });

  it("动作气泡不设 aria-modal，也不锁背景", async () => {
    const user = userEvent.setup();
    function Action() {
      const [open, setOpen] = useState(false);
      return (
        <Shell>
          <button onClick={() => setOpen(true)}>开动作气泡</button>
          {open && <FloatingPanel label="空白时段操作" kind="action" onClose={() => setOpen(false)}><button>添加时间块</button></FloatingPanel>}
        </Shell>
      );
    }
    render(<Action />);
    await user.click(screen.getByRole("button", { name: "开动作气泡" }));

    const bubble = screen.getByRole("dialog", { name: "空白时段操作" });
    expect(bubble).not.toHaveAttribute("aria-modal");
    expect(document.querySelector(".app-shell")).not.toHaveAttribute("inert");
  });

  it("输入法组合期间 Enter 不提交、Escape 不关闭编辑器（规格 §4.3）", async () => {
    const user = userEvent.setup();
    render(<FormHarness />);
    await user.click(screen.getByRole("button", { name: "打开表单" }));
    const dialog = screen.getByRole("dialog", { name: "编辑表单" });
    const input = within(dialog).getByLabelText("标题");

    // 组合中的 Enter 只用于确认候选：默认动作必须被拦下，否则会走浏览器的隐式表单提交。
    const composingEnter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(composingEnter);
    expect(composingEnter.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "编辑表单" })).toBeInTheDocument();

    // 组合中的 Escape 属于输入法（取消候选），不能连编辑器一起关掉。
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
    expect(screen.getByRole("dialog", { name: "编辑表单" })).toBeInTheDocument();

    // 组合结束后恢复原语义：Enter 不再被拦，Escape 依旧关闭。
    const plainEnter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(plainEnter);
    expect(plainEnter.defaultPrevented).toBe(false);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "编辑表单" })).not.toBeInTheDocument();
  });
});
