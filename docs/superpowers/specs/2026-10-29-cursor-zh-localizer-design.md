# Cursor 一键汉化工具 — 设计规格

日期：2026-10-29  
状态：待用户审阅

## 1. 目标

做一款 **Electron 桌面工具**，让用户 **一键** 把 Cursor 全界面（含 Agent / Chat / Cursor Settings 等专有面板）切到简体中文，并支持 **一键还原**。

成功标准（Linux 先验证）：

- 一键汉化后重启 Cursor：VS Code 继承菜单为中文；Agent / Chat / Cursor Settings 关键文案为中文。
- 一键还原后恢复英文，且不出现「安装已损坏」类无法启动问题。
- 无匹配版本锚点时拒绝硬灌，并明确提示。

## 2. 范围

### 做

- 平台：第一版在 **Linux** 打通验证；引擎抽象后扩展 **Windows / macOS**（三端都要）。
- 技术：Electron GUI + Node `localize-engine`。
- 引擎组合：**微软官方简体语言包** + **静态资源补丁** + **DOM 运行时补漏扩展**。
- 只跟 Cursor **Stable**；按版本维护锚点清单。
- L1 必过：菜单/命令面板、Agent、Chat、Cursor Settings 关键文案。
- 强制备份与失败自动回滚。

### 不做（第一版）

- 不跟 Nightly / 任意未登记版本硬灌。
- 不做账号体系、不做在线付费。
- 不做 AI 对话内容翻译（服务端文案不在范围）。
- 不做完整术语众包平台（可后续加「提交失败日志」）。
- 第一版词典与锚点随应用打包，不做在线热更新（预留接口即可）。

## 3. 架构

```
apps/desktop          Electron GUI（一键汉化 / 还原 / 日志）
packages/engine       纯 Node 引擎（可单测、可被 GUI 调用）
  detect              安装路径与版本
  langpack            MS 简体语言包安装与 locale 切换
  patch               备份、静态替换、校验字段处理
  inject              DOM 补漏扩展安装/启用/禁用
  restore             按清单还原
  anchors             按 Cursor 版本加载锚点与词典切片
packages/dom-extension  注入到 Cursor 的补漏扩展源码
anchors/              各 Cursor 版本的锚点 JSON
dicts/                中英词典
```

数据流（一键汉化）：

1. 探测 Cursor 根目录与 version  
2. 加载对应 anchors；无则中止并提示  
3. 若 Cursor 正在运行 → 提示先退出（或提供检测）  
4. 备份将修改的文件（path → sha256）  
5. 安装/启用 MS 语言包，写入 `zh-cn` locale  
6. 按锚点做静态字符串补丁；必要时更新校验相关字段  
7. 安装并启用 DOM 补漏扩展  
8. 写状态文件（已汉化、版本、时间）  
9. 提示用户重启 Cursor  

任一步失败 → 自动还原已修改部分 → GUI 标红原因。

## 4. 模块细节

### 4.1 探测

- Linux 候选路径：`/usr/share/cursor`、`/opt/Cursor`、`/opt/cursor`、用户本地安装目录、`PATH` 中 `cursor` 解析出的安装根。
- 读取 `product.json` / `package.json` 获取 `version`（及可用的 commit/quality）。
- Win/macOS 路径表在引擎内按 platform 分支，第一版实现 Linux，接口预留。

### 4.2 语言包

- 扩展 ID：`MS-CEINTL.vscode-language-pack-zh-hans`。
- 若不存在：从 Open VSX 或 VS Marketplace 下载 VSIX，解压到用户 extensions 目录。
- 写入用户 locale 配置为 `zh-cn`（具体文件以实测 Cursor 为准，常见为 `argv.json` / locale 相关配置）。
- 与社区语言包（如 `polang233.cursor-language-pack`）互斥：检测到则提示用户先禁用/卸载，避免冲突；第一版可选择自动禁用冲突扩展并记入日志。

### 4.3 静态补丁

- 仅修改锚点清单列出的文件。
- 替换规则：英文原文 + 上下文特征匹配；禁止依赖行号或字节偏移。
- 修改后若存在完整性校验字段（如 `product.json` 相关），按该版本锚点更新；无法安全更新则中止并还原。
- 补丁目标优先 L1 面板相关资源；L2 边角文案允许覆盖不全。

### 4.4 DOM 补漏扩展

- 由工具安装到 Cursor 的 extensions 目录。
- 对静态层未覆盖的节点，用词典做整段文本替换；MutationObserver 处理晚加载。
- 还原时可禁用或卸载该扩展。

### 4.5 备份与还原

- 备份目录：工具应用数据目录下按 Cursor version 分桶。
- 清单：每个文件相对安装根的路径 + 备份前 sha256。
- 无备份不得改文件。
- 一键还原：按清单覆盖 → 处理 DOM 扩展 → 清除「已汉化」状态。

### 4.6 Electron GUI

- 展示：Cursor 路径、版本、汉化状态。
- 操作：一键汉化、一键还原。
- 日志区：步骤流；失败说明是否已回滚。
- 无登录、第一版无在线更新 UI。

## 5. 版本兼容策略（低成本）

- 词典与锚点分离：词典相对稳定；每版本只维护锚点（路径、特征串、校验字段说明）。
- CI（后续）：拉 Stable → 干净安装 → 跑汉化 → 冒烟关键文案；失败只报丢失锚点。
- 分层：L0 MS 包；L1 关键面板；L2 可降级。
- 明确支持最近若干 Stable；未适配版本拒绝执行。

## 6. 错误处理

| 情况 | 行为 |
|------|------|
| 未找到 Cursor | 提示并允许手动选目录（第二版可做；第一版 Linux 自动探测为主） |
| 版本无锚点 | 拒绝汉化，说明原因 |
| 语言包下载失败 | 中止，还原已做步骤 |
| 静态补丁/校验失败 | 中止并自动还原 |
| Cursor 正在运行 | 提示退出后再点 |

## 7. 测试计划（本机）

1. 在 box 安装 Cursor Stable。  
2. 开发模式运行 Electron + engine。  
3. 执行汉化 → 启动 Cursor → 人工/截图确认 L1。  
4. 执行还原 → 确认恢复且可启动。  
5. 记录问题清单，按优先级修。

## 8. 风险

- 第三方修改安装文件；需界面声明与 Cursor 官方无关，并强调备份/还原。
- Cursor 发版频繁，锚点维护是持续成本（用 CI + 分层降低）。
- macOS 签名/公证、Windows 权限在后续三端扩展时单独处理。

## 9. 仓库布局

```
/workspace/cursor-zh-localizer/
  apps/desktop/
  packages/engine/
  packages/dom-extension/
  anchors/
  dicts/
  docs/superpowers/specs/
```

## 10. 已拍板决策

- 三端都要；Linux 先打通验证。
- 简单 GUI；技术选 Electron。
- 引擎：MS 语言包 + 静态补丁 + DOM 补漏。
- 方案 A：Electron 壳内嵌 Node 引擎（不做独立 CLI 双入口）。
