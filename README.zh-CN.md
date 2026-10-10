# Realtime TeX Live Preview

[English](README.md) | 简体中文

一个能跟上你打字速度的 VS Code LaTeX 实时预览插件。它基于
[realtime-tex (rtex)](https://github.com/HenryXiaoYang/realtime-tex)：rtex 让 LuaTeX 常驻运行，
只重新排版你正在编辑的段落，大约只需一毫秒。分页、交叉引用和参考文献则由后台的完整编译负责更新。

![在编辑器中输入，预览随每次按键更新](docs/demo.gif)

## 快速开始

1. 打开一个 LaTeX 项目文件夹。支持 Linux、macOS 和 Windows。
2. 打开一个 `.tex` 文件，点击编辑器标题栏上的**预览图标**，或按 **Ctrl+Alt+V**（Mac 上为 **Cmd+Alt+V**）。
3. 开始输入。

首次使用时，预览会引导你补齐缺少的部分：

- **未安装 rtex。** 点击 **Install rtex**。插件会为你的平台下载最新 [realtime-tex 发布版](https://github.com/HenryXiaoYang/realtime-tex/releases)中预编译好的引擎（几 MB），并校验其 SHA-256。想自己构建？**Build from Source** 会克隆 realtime-tex 的 `main` 分支并用 Rust 的 `cargo` 构建（需要几分钟；在 Windows 上还需要 [Git for Windows](https://git-scm.com/download/win)，以及 [rustup](https://rustup.rs) 安装时要求的 Visual Studio C++ 生成工具）。**Install rtex** 采用哪种方式由 `realtimeTex.installFrom` 设置决定。
- **找不到 LuaLaTeX。** 选择你的 TeX Live `bin` 文件夹，或让插件安装一个精简版 TeX Live 2026。

在命令面板中运行 **Realtime TeX: Check Setup** 会检查所有环境，并为每个问题提供修复方式。

插件会按安装时的方式让 rtex 保持最新：下载的版本会更新到最新发布版，从源码构建的版本会拉取 realtime-tex 的 `main`
并重新构建。插件每天检查一次，有新版本时提供 **Update Now**；也可以随时运行 **Realtime TeX: Update rtex Engine**
更新并重启引擎。此行为由 `realtimeTex.updateCheck` 设置控制。

## 使用预览

| | |
|---|---|
| **工具栏** | 状态标签 · 缩放 − / + · **Fit width**（适合宽度）· **Follow cursor**（跟随光标）· **Recompile**（重新编译）· **Export PDF**（导出 PDF） |
| **状态标签** | **Live · 0.8 ms** 表示该段落用这么短的时间完成了重新排版。**Updating layout…** 表示完整编译正在排定页面、引用和浮动体。**Up to date** 表示一切都已同步。**N errors** 点击后打开“问题”面板。 |
| **实时标记** | 行号旁的竖条显示源码各部分的更新方式：**绿色实线**表示随输入实时更新，**琥珀色虚线**表示要等完整编译（导言区、TikZ 等）。把鼠标悬停在被转交给完整编译的部分上，可以看到原因。 |
| **跟随光标** | 预览会滚动到你正在编辑的段落。按 **Ctrl+Alt+J** 可随时跳转过去。 |
| **跳转到源码** | 在预览中双击（或 Ctrl/Cmd+单击）某个段落。 |
| **缩放** | Ctrl + 鼠标滚轮，Ctrl + = / − / 0 |
| **导出 PDF** | **Ctrl+Alt+E**。在主文件旁写出 `main.pdf`，结果与一次干净的 LuaLaTeX 编译一致。 |
| **错误** | LaTeX 的错误和警告会显示在“问题”面板中，并在源码中以波浪线标出。 |

**主文件**会被自动找到。插件按以下顺序查找：

1. `% !TEX root = main.tex` 注释；
2. 包含 `\documentclass` 的文件；
3. 通过 `\input` 或 `\include` 引入当前文件的那个文件。

如果无法确定，预览会请你选择，选择结果保存在 `realtimeTex.mainFile` 中。

### 哪些内容会即时更新

正文、行内与行间公式、`\ref`/`\eqref`/`\cite`（编号取自上一次完整编译）、列表、定理、图表（内容）以及标题，
都会随每次按键即时更新。其余内容会在下一次完整编译后更新，通常在一两秒之后：

- 导言区的修改；
- TikZ；
- 浮动体位置的变化；
- 页面底部的脚注文本；
- 新的分页。

发生这种情况时，状态标签会提示你。详情请见 rtex 的
[实时编辑说明](https://github.com/HenryXiaoYang/realtime-tex/blob/main/docs/live-editing.md)。

想要最快的更新速度，请使用 TFM 字体（默认字体、`lmodern` 等），或以 `Renderer=Basic` 加载的 OpenType 字体。
fontspec 默认的 node 模式也能用，但每次按键会更慢一些。

### 页面如何绘制

预览自己绘制 rtex 输出的显示列表（display list），因此一次按键只需重绘一个段落，不必重新生成 PDF。支持：

- OpenType/TrueType 字体（按字形索引绘制）；
- Type1 字体，例如 Computer Modern 数学字体和 `lmodern`，通过 TeX 的 `pdftex.map` 查找；
- 颜色、标尺线、PNG/JPEG/PDF 图片以及 graphicx 缩放。

有些页面无法这样绘制，例如 TikZ 图形或 `\special`。这些页面会显示后台编译出的 PDF，并带有一个小小的
**from PDF** 标记；在这些页面上的编辑仍会实时叠加显示。

## 设置

| 设置 | 默认值 | |
|---|---|---|
| `realtimeTex.serverPath` | *（自动）* | rtex 可执行文件。留空时依次使用 **Install rtex** 安装的版本、`PATH` 中的 `rtex`。 |
| `realtimeTex.texliveBin` | *（PATH）* | 包含 `lualatex` 的文件夹。 |
| `realtimeTex.texDir` | *（自动）* | rtex 的 `tex/` 支持文件。只有把可执行文件移离这些文件时才需要设置。 |
| `realtimeTex.installFrom` | `release` | **Install rtex** 的方式：`release` 下载预编译引擎，`source` 用 `cargo` 构建 realtime-tex 的 `main` 分支。 |
| `realtimeTex.updateCheck` | `notify` | 每天检查一次是否有更新的引擎（新的发布版；从源码构建时则为 `main` 上的新提交）：`notify` 提示更新，`auto` 自动更新，`off` 从不检查。该设置带有 **Update rtex now** 链接。 |
| `realtimeTex.engine.eligibility` | `probe` | rtex 如何挑选可实时更新的部分：`probe`（将实时结果与上一次完整编译比对）或 `allowlist`（只接受已知安全的命令）。 |
| `realtimeTex.engine.fastBudgetMs` | `50` | 实时重排一个部分的时间预算；连续三次超时的部分会改为等待完整编译。 |
| `realtimeTex.engine.pictureCache` | `true` | 复用上一次完整编译中未改动的 TikZ 图形。 |
| `realtimeTex.debug.enabled` | `false` | 每当实时引擎卡住或崩溃时，rtex 会保存一个调试包（源码、上下文、跟踪、TeX 日志），并把每次实时编译记录到 `requests.log`。用 **Open Debug Folder** 查看。 |
| `realtimeTex.debug.directory` | *（插件存储）* | 调试包的保存位置。 |
| `realtimeTex.mainFile` | *（自动）* | 主文件，相对于工作区文件夹。 |
| `realtimeTex.buildDir` | *（插件存储）* | rtex 存放构建文件的位置。留空可避免污染你的项目目录。 |
| `realtimeTex.exportPath` | `${mainDir}/${mainName}.pdf` | **Export PDF** 的输出位置。 |
| `realtimeTex.syncCursor` | `true` | 预览跟随光标。 |
| `realtimeTex.editor.liveMarkers` | `true` | 在行号旁显示实时/完整编译标记。 |
| `realtimeTex.autoStart` | `false` | 打开 LaTeX 文件时即启动引擎，不必等打开预览。 |
| `realtimeTex.stopWhenPreviewCloses` | `true` | 关闭预览时停止引擎。 |
| `realtimeTex.preview.zoom` | `fitWidth` | 初始缩放。 |
| `realtimeTex.preview.invertInDarkTheme` | `false` | 在深色主题下以深色显示页面。 |

## 命令

所有命令都在命令面板的 **Realtime TeX:** 下：

- **Open Live Preview to the Side**：在侧边打开实时预览
- **Export PDF**：导出 PDF
- **Recompile Whole Document**：重新编译整个文档
- **Show Cursor Position in Preview**：在预览中显示光标位置
- **Restart Engine**：重启引擎
- **Stop Engine**：停止引擎
- **Show Log**：显示日志
- **Open Debug Folder**：打开调试文件夹
- **Check Setup**：检查环境
- **Install rtex**：安装 rtex（下载预编译版）
- **Install rtex (Build from Source)**：安装 rtex（从源码构建）
- **Update rtex Engine**：更新 rtex 引擎
- **Locate rtex Binary…**：指定 rtex 可执行文件…
- **Choose Main File…**：选择主文件…
- **Get Started**：入门引导

## 开发

```bash
npm install
npm run build        # dist/extension.js, dist/webview.js
npm test             # 单元测试 (node:test)
npm run typecheck
npm run package      # .vsix
```

在 VS Code 中按 F5 启动扩展开发宿主（Extension Development Host）。

集成测试会用真实的引擎驱动一个真实的 VS Code，需要已构建的 rtex 和 TeX Live：

```bash
RTEX_E2E_SERVER=/path/to/realtime-tex/target/release/rtex \
RTEX_E2E_TEXLIVE_BIN=/path/to/texlive/2026/bin/x86_64-linux \
xvfb-run -a npm run test:e2e
```

在 macOS 和 Windows 上直接运行 `npm run test:e2e`，不需要 `xvfb-run`。**E2E** 工作流会在 Linux、macOS 和 Windows 上
针对最新的 realtime-tex 运行这套测试。

### 代码结构

| 路径 | |
|---|---|
| `src/extension.ts` | 激活、命令、主文件解析、编辑器事件 |
| `src/session.ts` | 一个 `rtex serve` 会话：缓冲区同步、事件 → 诊断/状态/预览、导出、源码 ↔ 预览映射 |
| `src/rtexProcess.ts` | `rtex serve` JSON-lines 子进程 |
| `src/edits.ts` | VS Code 修改（UTF-16）→ rtex 字节编辑（UTF-8） |
| `src/resources.ts`, `src/type1.ts` | 字体和图片加载；Type1 字体与 `pdftex.map` → 字形轮廓 |
| `src/gutter.ts`, `src/liveMarks.ts` | 行号旁的实时/完整编译标记 |
| `src/preview/panel.ts` | Webview 面板及其消息协议 |
| `src/setup.ts`, `src/config.ts` | 环境检查、rtex/TeX Live 安装、设置 |
| `webview/` | 预览：页面/叠加层模型、canvas 渲染器、pdf.js 回退、工具栏 |

## 许可证

MIT
