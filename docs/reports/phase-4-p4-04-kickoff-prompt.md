# 阶段 4 P4-04 开工提示词

用途：把下面代码块整段复制给新的 agent 会话，即可在 Daymark 仓库开工 P4-04（日历滚动仲裁与逻辑浏览位置，内存版）。
编制日期：2026-10-13。依据：`docs/specs/0005-phase-4-daily-workflow-and-reliability.md` §5／§10／§11，`docs/reports/phase-4-p4-01-baseline.md`，以及 HEAD 处实际代码。

---

```
你在 Daymark 仓库（F:\PythonProject\Daymark）继续阶段 4 的实施。本次工作包是 P4-04：日历滚动仲裁与逻辑浏览位置（先做内存版）。

## 先读（按顺序，不要跳过）
1. AGENTS.md —— 工作规则
2. CONTEXT.md —— 领域语言与产品原则
3. docs/PROJECT-GUIDE.md —— 当前真实实现；重点读 §4 运行时数据流、§5 代码地图、§8 设置持久化、§11 测试体系、§12 常见修改入口，以及末尾的「文档同步协议」
4. docs/specs/0005-phase-4-daily-workflow-and-reliability.md —— 本工作包的验收依据。逐字读 §5（M9 全部）、§10 的 P4-04 行、§11 的 AC05／AC06／AC07、§13
5. docs/reports/phase-4-p4-01-baseline.md —— 基线事实。重点 §3（M3/M4 红灯的两个根因）与 §3.5（2026-09-20 已修复）、§4.2（缩放配置源）、§7（环境注意事项）
6. docs/reports/gui-fixes-2026-09-20.md —— 最近一轮 GUI 修复，避免重复改动

## 交付范围（只做这些）
1. 新增 src/hooks/useCalendarViewport.ts：日／周共用的单一滚动仲裁入口，实现规格 §5.2 的优先级 1–6，且每次视图／日期变更递增 generation，过期的 requestAnimationFrame 与 ResizeObserver 回调一律 no-op。
2. 新增 CalendarPosition 逻辑坐标（{date, minute, viewportRatio}）与日／周各自的内存记忆；月视图不存时间轴坐标，沿用日期锚点并在进入时置顶。
3. 采样与恢复：取视口中心对应的日期／分钟；中心命中折叠条时取该条时间区间中点，不因恢复而展开整段非默认时间；用 src/lib/calendarTimeline.ts 现有的分钟／像素映射重新计算像素，不要另写一套换算。布局尚未测量时等待轨道可测量再恢复，不得用固定延时猜 DOM 完成。
4. 程序性滚动不立即写偏好；用户滚动停止 300ms 后采样；切页时刷新最后一次内存值。本工作包只做内存版，不写 Store（持久化是 P4-05）。

## 明确不做（越界即停并回报）
- 不写 Tauri Store、不新增偏好字段（P4-05）。
- 不新增 SQLite 迁移（schema 保持 v7）、不新增 Tauri Command、不新增依赖。
- 不改任何排程事实、不改拖拽／插入后移／撤销的写入语义。
- 不动 M10 截止事项页、M11 回顾（P4-06～P4-08）。
- 不重新引入全局 overflow: clip，不关闭浏览器滚动锚定。

## 当前代码事实（起点，已在 HEAD 确认）
滚动相关逻辑目前散在 src/App.tsx 的 CalendarPage 与 ContinuousDayView：
- zoomAnchorRef（约 589）＋缩放锚点恢复 useLayoutEffect（约 657–678）：分支为「折叠段比例 → 整轨比例 → scrollHeight 比例」，是规格 §5.2 优先级 3 的现有实现。
- zoomWithWheel（约 692–731）＋原生非 passive wheel 监听（约 685–691，2026-09-20 为修 108px 位移引入）。
- didAutoScrollToNow 首次定位到「现在」（约 629–656）：已带「任何先发生的 scroll 事件即自行作废」的守卫（2026-09-20 加），对应优先级 6 的前半部分。
- returnToNow（约 624–627）与 focusedSession 的 scrollIntoView（约 836）：优先级 2。
- 月视图进入置顶 useLayoutEffect（约 628）：保留。
- ContinuousDayView 三日缓冲重定位与 onScroll 平移补偿（约 763–779）＋ continuousPanelStarts（约 789–795）：优先级 4。
- 拖拽期间 onDragOver 内的边缘自动滚动（约 1002）：优先级 1。
- 周视图键盘焦点定位（约 607–611）：是焦点而非滚动，保持。

已经做完、不要重做：
- 缩放配置源已统一为 src/lib/settings.ts 的 CALENDAR_SCALE_RANGE（day/week [28,192]，month [52,160]，上界已容纳 detailed 预设 160）；CALENDAR_SCALE_PRESET／calendarScaleForZoom 同源；App.tsx:695 的滚轮钳制已读同一处。P4-01 §4.2 记录的「月 detailed 160 > 上界 132、且回退路径同样越界」已解决，AC07 的该阻塞已消除 —— 只需保证不回退。
- E2E 侧已有 waitForScrollSettled（缩放前确认滚动稳定）。

## 必须保持（回归红线）
拖拽／拉伸与其自动滚动；Ctrl+滚轮以指针时间为锚点缩放；折叠条临时展开；插入后移与整体撤销；连续日跨午夜三日缓冲；跨页目标显露（今日页→日历时段、提醒恢复）；「回到现在」；月视图进入置顶。缩放前后所有计划对象的序列化结果必须完全一致。

## 验收（依据规格 §5.3 与 §11）
- AC05：日↔周连续切换 10 次不累计漂移；月视图进入置顶。（「退出重开各自恢复」依赖 Store，属 P4-05，本包只保证内存态与仲裁正确，并在报告中写明该依赖。）
- AC06：指针缩放、连续跨午夜、折叠展开、拖拽后移与撤销全部保持（现有 E2E ＋新增组合用例）。
- AC07：所有缩放预设经规范化、保存、重载恒等；非法偏好安全回退。不得回退。
- 阈值：固定窗口与布局下恢复逻辑时间误差 ≤1 分钟或 2 CSS px（取较宽松的可测量者）；重复日↔周切换 10 次无累计漂移；窗口尺寸变化以时间保持为准。

## 验证
按变更先跑纯函数／组件或对应 E2E；完成后串行：
npm test
npm run test:e2e
npm run build
npm run test:native
npm run check
E2E 建议 --workers=1（仓库报告均如此跑）。注意（P4-01 §7）：本机跨调用不保持后台进程，需 Vite 的验证要在同一次调用内完成；存在 HTTP_PROXY，curl 探测用 --noproxy '*'；Playwright 冷启动首个用例承担整段冷编译（30–37s，超时已设 60s），偶发超时属环境抖动。

## 完成定义
1. 新增／修改的代码与测试；新增 src/hooks/useCalendarViewport.test.tsx 与必要的 App 组件测试、E2E 用例（对每个关键行为做反向验证：去掉修复即失败）。
2. 写 docs/reports/phase-4-p4-04-implementation.md（范围、交付清单、契约、刻意行为变化、验证实测数字、未做与边界）。
3. 按 PROJECT-GUIDE「文档同步协议」更新 PROJECT-GUIDE 的代码地图、测试数量、已知边界；顺带订正 §11 的测试数量滞后（现写 Vitest 147／Rust 37／Playwright 25，2026-09-20 GUI 修复后实测为 163／38／29 —— 以你本次实测为准）。
4. 不改动用户的未提交内容；未经明确要求不要自动 git commit。
5. 汇报：改了哪些文件、验证实测结果、是否发现代码／规格／文档不一致、仍需用户决定的事项。
```
