# 覆盖率扫描（after）：下拉列表 + 展开区 + 属性 — 2026-10-30

环境：box 上的 Cursor 3.27.22（Linux deb），`--remote-debugging-port=9333`，
`node scripts/coverage-scan.mjs --json … --md …`（默认严格口径：中英混排算英文）。
before 见 [2026-10-30-dropdowns-before.md](2026-10-30-dropdowns-before.md)。

## before → after

| 区域 | before 中文/英文 | before 覆盖率 | after 中文/英文 | after 覆盖率 |
|---|---|---|---|---|
| classic-dropdowns（经典窗口：设置各页展开折叠区 + 逐个打开下拉 + 聊天框模式/模型下拉） | 317 / 187 | 62.9% | 429 / 19 | 95.8% |
| agents-dropdowns（Agents 窗口：同上 + 侧边栏/工作区/环境/项目/对话操作等弹出菜单） | 549 / 283 | 66.0% | 727 / 19 | 97.5% |
| agents-settings / classic-settings | 624 / 0 | 100% | 622 / 1 | 99.8% |
| 菜单 / 右键 / 窗口外框 | 88 / 0 | 100% | 88 / 0 | 100% |
| 命令面板（759 条） | 758 / 1 | 99.9% | 758 / 1 | 99.9% |
| **合计** | **2336 / 471** | **83.2%** | **2624 / 40** | **98.5%** |

（after 把语音名、主题名、字体预览、`+ 命令` 白名单条目等不该翻的专名计入“保留”，所以部分页中文数略有变化。）

静态补丁（9 棵官方安装树 verify-platform-trees）：整串 2122 → 3078 处，模板片段 91 → 189 处，NLS 1529 条，未命中 0。

after 扫描之后又补了 13 条 Agents 窗口标题栏/浏览器面板的 aria-label（更多选项、进入全屏、打开新建标签页菜单、调整侧边栏大小等；扫描脚本不统计标题栏），另补设置侧栏搜索框占位符（搜索设置 Ctrl+F）与聊天框模型按钮提示（切换模型 (Ctrl+/) · 切换 Effort …；参数名来自服务端保留），最终静态整串 3078 处、片段 189 处。

## 剩余 40 条都是什么

严格口径下“中英混排”也算英文。剩下的全是**已翻译、但句子里本来就带品牌/模型名/代码标记**的：

- 模型名 + “已启用”（`Claude Opus 5.5 已启用` 等 8 条 × 2 窗口）——模型名不翻。
- `配置 Azure OpenAI…`、`配置 AWS Bedrock…`、`你的 Google AI Studio 密钥`、`…按成本价使用 Claude…`、`…访问 Bedrock`——品牌名不翻。
- 占位符示例 `例如 gpt-35-turbo / my-resource.openai.azure.com / anthropic.claude-3-…`——示例值本身是代码。
- 允许列表 `添加 server:tool`、MCP 工具格式说明（`'server:tool'`、`*:*`）——格式语法不翻。
- `Model Context Protocol（MCP）… Linear、Figma、Notion …`（品牌）。
- 命令面板 `开发人员: GC Agent KV Blobs`——内部调试命令名。

刻意不覆盖：VS Code 原生设置编辑器里 `<select>` 的枚举值（off / on / afterDelay …）是设置项的原始取值，官方中文语言包也不翻。

## after 明细

| 区域 | 页面 | 中文 | 英文 | 保留 | 覆盖率 |
|---|---|---|---|---|---|
| agents-settings | 常规 | 36 | 0 | 0 | 100% |
| agents-settings | 外观 | 47 | 0 | 4 | 100% |
| agents-settings | 套餐与用量 | 5 | 0 | 3 | 100% |
| agents-settings | 智能体 | 58 | 0 | 0 | 100% |
| agents-settings | 模型 | 7 | 0 | 0 | 100% |
| agents-settings | 语音 | 13 | 0 | 2 | 100% |
| agents-settings | 源代码管理 | 23 | 0 | 1 | 100% |
| agents-settings | 浏览器与网络 | 22 | 0 | 1 | 100% |
| agents-settings | 代码智能 | 29 | 0 | 3 | 100% |
| agents-settings | 测试版 | 5 | 0 | 0 | 100% |
| agents-menus | 文件 | 6 | 0 | 5 | 100% |
| agents-menus | 编辑 | 6 | 0 | 6 | 100% |
| agents-menus | 查看 | 10 | 0 | 8 | 100% |
| agents-menus | 帮助 | 3 | 0 | 2 | 100% |
| classic-context | 资源管理器部分: demo | 5 | 0 | 0 | 100% |
| classic-context | a.py | 14 | 0 | 6 | 100% |
| classic-context | 大纲部分 | 5 | 0 | 0 | 100% |
| classic-context | 时间线部分 | 5 | 0 | 0 | 100% |
| classic-chrome | 标题栏 | 1 | 0 | 1 | 100% |
| classic-chrome | 侧边栏 | 2 | 0 | 2 | 100% |
| classic-chrome | 状态栏 | 3 | 0 | 2 | 100% |
| classic-chrome | 辅助侧边栏 | 3 | 0 | 0 | 100% |
| agents-chrome | 主界面 | 25 | 0 | 5 | 100% |
| classic-settings | 常规 | 61 | 0 | 0 | 100% |
| classic-settings | 套餐与用量 | 5 | 0 | 3 | 100% |
| classic-settings | 智能体 | 70 | 0 | 0 | 100% |
| classic-settings | 模型 | 7 | 0 | 0 | 100% |
| classic-settings | 语音 | 13 | 0 | 2 | 100% |
| classic-settings | 源代码管理 | 33 | 0 | 1 | 100% |
| classic-settings | 自定义 | 17 | 0 | 1 | 100% |
| classic-settings | 自定义 / 插件 | 17 | 0 | 1 | 100% |
| classic-settings | 自定义 / MCP | 16 | 1 | 1 | 94.1% |
| classic-settings | 自定义 / 技能 | 17 | 0 | 1 | 100% |
| classic-settings | 自定义 / 子智能体 | 17 | 0 | 1 | 100% |
| classic-settings | 自定义 / 规则 | 17 | 0 | 1 | 100% |
| classic-settings | 自定义 / 命令 | 17 | 0 | 1 | 100% |
| classic-settings | 自定义 / 钩子 | 20 | 0 | 1 | 100% |
| classic-settings | 浏览器与网络 | 20 | 0 | 1 | 100% |
| classic-settings | 代码智能 | 25 | 0 | 2 | 100% |
| classic-settings | 测试版 | 5 | 0 | 0 | 100% |
| classic-dropdowns | 常规（展开 0 个折叠区 + 属性） | 70 | 0 | 0 | 100% |
| classic-dropdowns | 常规 / 下拉列表（5 个） | 8 | 0 | 0 | 100% |
| classic-dropdowns | 套餐与用量（展开 0 个折叠区 + 属性） | 6 | 0 | 3 | 100% |
| classic-dropdowns | 智能体（展开 1 个折叠区 + 属性） | 88 | 3 | 39 | 96.7% |
| classic-dropdowns | 智能体 / 下拉列表（7 个） | 14 | 0 | 0 | 100% |
| classic-dropdowns | 模型（展开 1 个折叠区 + 属性） | 45 | 16 | 4 | 73.8% |
| classic-dropdowns | 模型 / 下拉列表（1 个） | 4 | 0 | 0 | 100% |
| classic-dropdowns | 语音（展开 0 个折叠区 + 属性） | 16 | 0 | 2 | 100% |
| classic-dropdowns | 语音 / 下拉列表（4 个） | 31 | 0 | 29 | 100% |
| classic-dropdowns | 源代码管理（展开 0 个折叠区 + 属性） | 41 | 0 | 2 | 100% |
| classic-dropdowns | 源代码管理 / 下拉列表（3 个） | 7 | 0 | 3 | 100% |
| classic-dropdowns | 自定义（展开 0 个折叠区 + 属性） | 26 | 0 | 1 | 100% |
| classic-dropdowns | 自定义 / 下拉列表（1 个） | 2 | 0 | 2 | 100% |
| classic-dropdowns | 浏览器与网络（展开 0 个折叠区 + 属性） | 22 | 0 | 1 | 100% |
| classic-dropdowns | 浏览器与网络 / 下拉列表（2 个） | 4 | 0 | 3 | 100% |
| classic-dropdowns | 代码智能（展开 0 个折叠区 + 属性） | 28 | 0 | 2 | 100% |
| classic-dropdowns | 测试版（展开 0 个折叠区 + 属性） | 6 | 0 | 0 | 100% |
| classic-dropdowns | 测试版 / 下拉列表（1 个） | 3 | 0 | 0 | 100% |
| classic-dropdowns | 下拉：智能体 | 5 | 0 | 0 | 100% |
| classic-dropdowns | 下拉：Cursor Grok 4.6 Medium | 3 | 0 | 0 | 100% |
| agents-dropdowns | 常规（展开 0 个折叠区 + 属性） | 42 | 0 | 0 | 100% |
| agents-dropdowns | 常规 / 下拉列表（2 个） | 28 | 0 | 1 | 100% |
| agents-dropdowns | 外观（展开 0 个折叠区 + 属性） | 58 | 0 | 4 | 100% |
| agents-dropdowns | 外观 / 下拉列表（4 个） | 28 | 0 | 5 | 100% |
| agents-dropdowns | 套餐与用量（展开 0 个折叠区 + 属性） | 6 | 0 | 3 | 100% |
| agents-dropdowns | 智能体（展开 1 个折叠区 + 属性） | 76 | 3 | 39 | 96.2% |
| agents-dropdowns | 智能体 / 下拉列表（7 个） | 44 | 0 | 1 | 100% |
| agents-dropdowns | 模型（展开 1 个折叠区 + 属性） | 45 | 16 | 4 | 73.8% |
| agents-dropdowns | 模型 / 下拉列表（1 个） | 10 | 0 | 1 | 100% |
| agents-dropdowns | 语音（展开 0 个折叠区 + 属性） | 16 | 0 | 2 | 100% |
| agents-dropdowns | 语音 / 下拉列表（4 个） | 51 | 0 | 30 | 100% |
| agents-dropdowns | 源代码管理（展开 0 个折叠区 + 属性） | 30 | 0 | 2 | 100% |
| agents-dropdowns | 源代码管理 / 下拉列表（2 个） | 24 | 0 | 4 | 100% |
| agents-dropdowns | 浏览器与网络（展开 0 个折叠区 + 属性） | 24 | 0 | 1 | 100% |
| agents-dropdowns | 浏览器与网络 / 下拉列表（2 个） | 24 | 0 | 4 | 100% |
| agents-dropdowns | 代码智能（展开 0 个折叠区 + 属性） | 34 | 0 | 3 | 100% |
| agents-dropdowns | 测试版（展开 0 个折叠区 + 属性） | 6 | 0 | 0 | 100% |
| agents-dropdowns | 测试版 / 下拉列表（1 个） | 23 | 0 | 1 | 100% |
| agents-dropdowns | 下拉：自定义侧边栏 | 26 | 0 | 4 | 100% |
| agents-dropdowns | 下拉：打开工作区 | 25 | 0 | 5 | 100% |
| agents-dropdowns | 下拉：你的名字 | 23 | 0 | 4 | 100% |
| agents-dropdowns | 下拉：对话操作 | 18 | 0 | 3 | 100% |
| agents-dropdowns | 下拉：从零开始，选择项目 | 15 | 0 | 3 | 100% |
| agents-dropdowns | 下拉：本机，选择环境 | 15 | 0 | 3 | 100% |
| agents-dropdowns | 下拉：添加智能体、上下文、工具 | 18 | 0 | 3 | 100% |
| agents-dropdowns | 下拉：Cursor Grok 4.6 Medium | 18 | 0 | 3 | 100% |
| palette | 命令面板（全部 759 条） | 758 | 1 | 0 | 99.9% |

合计：中文 2624，英文 40，覆盖率 98.5%

### classic-settings / 自定义 / MCP
- Model Context Protocol（MCP）服务器可将 Cursor 连接到 Linear、Figma、Notion 等外部工具和数据源。

### classic-dropdowns / 智能体（展开 1 个折叠区 + 属性）
- 可自动运行的 MCP 工具。格式：'server:tool'；'server:*' 表示某服务器的全部工具；'*:tool' 表示任意服务器上的某个工具；*:* 表示所有服务器的全部工具
- 添加 server:tool
- 添加路径或 glob（例如 /tmp/*）

### classic-dropdowns / 模型（展开 1 个折叠区 + 属性）
- ，按成本价使用 Claude。启用后，所有以 "claude-" 开头的模型都会使用此密钥。
- 你的 Google AI Studio 密钥
- 配置 Azure OpenAI，通过你的 Azure 账户使用 OpenAI 模型。
- 配置 AWS Bedrock，通过你的 AWS 账户使用 Anthropic Claude 模型。
- Cursor 企业版团队可以配置 IAM 角色，无需任何访问密钥即可访问 Bedrock。
- Claude Opus 5.5 已启用
- Gemini 4 Argon 已启用
- Muse Wonder 已启用
- GPT-5.6 Sol 已启用
- Claude Fable 5.1 已启用
- Claude Sonnet 5.5 已启用
- Claude Opus 5 已启用
- Claude Opus 4.8 已启用
- 例如 my-resource.openai.azure.com
- 例如 gpt-35-turbo
- 例如 anthropic.claude-3-sonnet-20240229-v1:0

### agents-dropdowns / 智能体（展开 1 个折叠区 + 属性）
- 可自动运行的 MCP 工具。格式：'server:tool'；'server:*' 表示某服务器的全部工具；'*:tool' 表示任意服务器上的某个工具；*:* 表示所有服务器的全部工具
- 添加 server:tool
- 添加路径或 glob（例如 /tmp/*）

### agents-dropdowns / 模型（展开 1 个折叠区 + 属性）
- ，按成本价使用 Claude。启用后，所有以 "claude-" 开头的模型都会使用此密钥。
- 你的 Google AI Studio 密钥
- 配置 Azure OpenAI，通过你的 Azure 账户使用 OpenAI 模型。
- 配置 AWS Bedrock，通过你的 AWS 账户使用 Anthropic Claude 模型。
- Cursor 企业版团队可以配置 IAM 角色，无需任何访问密钥即可访问 Bedrock。
- Claude Opus 5.5 已启用
- Gemini 4 Argon 已启用
- Muse Wonder 已启用
- GPT-5.6 Sol 已启用
- Claude Fable 5.1 已启用
- Claude Sonnet 5.5 已启用
- Claude Opus 5 已启用
- Claude Opus 4.8 已启用
- 例如 my-resource.openai.azure.com
- 例如 gpt-35-turbo
- 例如 anthropic.claude-3-sonnet-20240229-v1:0

### palette / 命令面板（全部 759 条）
- 开发人员: GC Agent KV Blobs
