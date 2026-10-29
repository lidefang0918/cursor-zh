# 术语表（zh-cn）

`dicts/zh-cn.json` 的统一用词。新增词条前先查这里。

## 统一译名

| English | 中文 | 说明 |
|---|---|---|
| Agent / Agents | 智能体 | 所有位置统一；"New Agent"/"New Chat" 都是 **新建智能体** |
| Agents Window | 智能体窗口 | |
| Cloud Agents | 云端智能体 | |
| Subagents | 子智能体 | |
| Automations | 自动化 | |
| Skills | 技能 | |
| Rules | 规则 | |
| Plan（模式） | 规划 | 计费里的 "Plan"（套餐）不在本条，按上下文 |
| Ask（模式） | 问答 | |
| Debug（模式） | 调试 | |
| Multitask | 多任务 | |
| Worktree / Worktrees | 工作树 | |
| Repositories | 仓库 | |
| This Computer / This Mac / This PC | 本机 | 环境选择器 |
| Marketplace | 插件市场 | Cursor Marketplace → Cursor 插件市场 |
| Projects / New Project | 项目 / 新建项目 | "New Project" 只走 DOM（bundle 里拿它当默认项目名存盘并比较） |
| MCPs | MCP | 复数不加"s" |
| Menu Bar（macOS） | 菜单栏 | 系统设置路径按 macOS 中文界面：系统设置 > 菜单栏 > 允许在菜单栏中显示 |
| Settings | 设置 | |
| Undo / Redo | 撤销 / 重做 | VS Code 语言包里是"撤消"，我们自己的词条用"撤销" |
| 菜单助记键 &&File | 文件(&&F) | NLS 层沿用 VS Code 中文惯例 |

## 保持英文（不翻）

- 产品/品牌：Cursor、Cursor Tab、Grok Bot、GitHub、GitLab、Slack、Linear、MCP、LSP、Composer、IDE（智能体窗口右上角“IDE ↗”入口，中文界面也通称 IDE）
- 模型名：GPT-*、Claude *、Gemini *、Grok *、Auto 等
- 用户名、邮箱、文件路径、仓库名
- 快捷键（Ctrl+K、Alt+T…）：属性里 "文案 (快捷键)" 只翻前半段
- 斜杠命令与 @ 提及：/goal、/skills、@file 等，句子翻译时原样保留
- 命令面板：`{value, original}` 只翻 value，original 保留英文以便英文搜索
