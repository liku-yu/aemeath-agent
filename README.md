# 爱弥斯 · Aemeath Agent

**一个只为爱弥斯做的桌面 agent。**

不是通用 harness，也不是「接入任意角色」的框架。人设、语气、说话节奏、以及
「先有用再有性格」的工程习惯，是围绕同一个人一起设计的。所以她不是一层
可以换掉的外观，而是这个 agent 的起因。

TypeScript 编写，Windows 原生可用（无需 WSL2），架构同时兼容 Linux / macOS。
工程实现参考了开源 agent 的做法（AemeathCode 的 ReAct 循环、Claude Code 的
skills、aider 的精确替换编辑），**完全自研、无 agent 框架依赖**。

> 爱弥斯（Aemeath）是《鸣潮》的角色。本项目是粉丝向的工程实践，非官方项目。

---

## 能做什么

**Agent 内核**
- ReAct 循环：规划 → 调工具 → 看结果 → 继续
- 流式混排：思考、正文、工具调用可按任意顺序穿插输出
- 计划模式：只读调研、输出方案，**harness 层强制禁止改文件**；模型可用
  `enter_plan_mode` / `exit_plan_mode` 主动进出（降权免批准、升权需批准）
- 检查点 / 撤销：每次写文件前自动快照，一键回滚
- 上下文自动压缩：逼近预算时摘要早期轮次（磁盘原文不动）
- 14 个内置工具：读写编辑文件、glob、grep、执行命令、网页抓取、笔记、
  任务清单、子 agent、计划模式进出

**模型与供应商**
- 10 个内置预设 + 自定义供应商，3 种协议（Chat Completions / Responses /
  Messages）
- 模型列表按 `provider@baseURL#key指纹` 隔离 —— 换 Key 不会串到别人的列表
- 余额三级策略：供应商接口 → 通用探测 → 本地用量统计，**查不到就说查不到**

**人格与界面**
- 爱弥斯人设分两层：常驻 prompt 只放身份、语言规范与红线；完整人设按需加载
- 内嵌像素桌宠（主窗口右下角，非独立窗口）：9 种动画随状态切换，可拖动、可隐藏
- CLI：交互 REPL 与一次性 `-p` 模式

---

## 快速开始

**环境**：Node.js ≥ 22.12（Electron 45 的下限）、约 1 GB 磁盘、一个
OpenAI 或 Anthropic 兼容的 API。

**已经装了 exe 的话**：双击「爱弥斯」→ 设置里粘 API Key → 保存 → 开始。
首次启动会自动生成 `~/.aemeath/config.json`。

**从源码跑**

```bash
npm install          # Electron 下载慢可用镜像，见下
npm run build
npm run desktop      # 桌面端
npm run cli          # 终端
```

```bash
# 国内镜像加速（可选）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install   # PowerShell
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install # bash
```

---

## 配置

优先级：**真实环境变量 > 项目 `.aemeath/.env` > `~/.aemeath/config.json` > 默认值**

### 首次运行

`~/.aemeath/config.json` 会自动生成，默认值：

| 项 | 默认值 |
|---|---|
| 供应商 / 协议 | `deepseek` / `chat` |
| 模型 | `deepseek-chat` |
| Base URL | `https://api.deepseek.com` |
| 权限 | 写文件 `ask` / 执行命令 `ask` |

只需要一个 DeepSeek 的 Key 就能开始。想用别的供应商，在设置里点左侧卡片切换 ——
每个供应商的地址、协议和 Key 各自独立保存。

想清空重来：删掉这个文件，下次启动回到默认值。

### 桌面端设置

点左下角 ⚙ →「模型与接口」。这一页做四件事：

| 区域 | 作用 |
|---|---|
| **供应商**（左栏） | 卡片列表，点选即切换；`＋` 从模板添加（只问名字，地址和 Key 在右边填） |
| **接口类型 / Base URL / API Key** | 当前供应商的端点与凭据，改动后点右侧「保存」 |
| **模型** | `⟳ 检测可用模型` 向端点查询；`＋ 手动` 添加；点名字设为当前；`⚡` 单独测试；`×` 移除 |
| **🔌 测试当前配置** | 发一次极小真实请求，显示状态码 / 耗时 / 实际 URL |

顶栏还有一个 `供应商 / 模型` 切换器（两列、可搜索、`↑↓` 选择 `Enter` 应用），
不进设置页也能换。

检测失败时会给出可操作提示（Key 无效 / JWT 过期 / `/v1` 多了少了 / 网络不通），
**不会替你猜一个模型列表**。

### API Key 不落盘

`config.json` 里**没有、也不会有** Key。它存在独立的 `~/.aemeath/credentials.json`：

- AES-256-GCM 加密（`enc:v1:` 前缀）；桌面端优先用系统钥匙串（`safeStorage`）
- `0600` 权限 + 临时文件 rename 原子替换
- 文件损坏时**改名隔离**（`*.corrupt-<时间>`），不清空其他 Key
- 按端点作用域隔离：`provider@baseUrl`
- 写入配置前会校验，发现疑似密钥字段**直接拒绝写入**

保存后显示脱敏预览，点一下不会丢：

```
保存前  [ 你粘的 Key            ]   👁 保存  清除
保存后  [ 前4位••••••••后4位     ]   ✎ 更换  清除     ← 只读，首尾可见
点「更换」[                        ]   👁 保存  清除     ← 清空，可填新的
按 Esc   [ 前4位••••••••后4位     ]   ✎ 更换  清除     ← 取消，还原预览
```

### 环境变量

```bash
export AEMEATH_BASE_URL="https://api.deepseek.com"
export AEMEATH_MODEL="deepseek-chat"
export AEMEATH_API_KEY="sk-..."

# 也可复用各家变量名（按 Base URL 自动匹配）
export DEEPSEEK_API_KEY=...  ANTHROPIC_API_KEY=...  MOONSHOT_API_KEY=...
```

> 不想让程序自动取用某个已有变量，就别把 Key 放在这些名字里，改在设置里手填。

### 项目级覆盖

项目根目录建 `.aemeath/.env`：

```ini
AEMEATH_MODEL=deepseek-chat
AEMEATH_API_KEY=sk-...
```

### 常用服务商

| 服务商 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn` | `moonshot-v1-8k` |
| OpenAI | `https://api.openai.com` | `gpt-4o` |
| Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-5-20250929` |
| Ollama（本地） | `http://localhost:11434` | `qwen2.5:14b` |

协议自动识别：`anthropic.com` 走 Messages API，其余走 Chat Completions。

---

## Skills 与人设

技能搜索顺序（先匹配者生效）：

```
<项目>/.aemeath/skills → <项目>/.claude/skills → <项目>/skills
→ <数据目录>/skills → 安装包内 resources/skills → ~/.aemeath/skills → ~/.claude/skills
```

只有 `SKILL.md` 的 `name` + `description` 进 system prompt，正文在用到时才通过
`use_skill` 加载。

### 爱弥斯人设的结构

人设在 `skills/aemeath/`，**随仓库版本管理，是唯一来源**：

```
skills/aemeath/
├── SKILL.md          入口 + 按需查阅表
├── profile.md        身份、外观、属性、世界观
├── personality.md    性格与价值观
├── interaction.md    说话方式、口头禅、去 AI 味对照
├── memory.md         经历与关键剧情
├── relations.md      人物关系
├── conflicts.md      设定冲突与更正记录
└── voice.md          官方语音原文（说话的权威依据）
```

它不走「可选技能」那套语义：`aemeath` 决定她是谁，其余技能才是给她加能力。
自己的工作目录或 `~/.aemeath/skills` 里的同名技能会覆盖包内版本。

**加技能**：把含 `SKILL.md`（或单个 `.md`）的目录放进上面任一位置即可。

### 余额与用量

顶栏余额徽章按三级策略，**不会假装知道**：

1. 供应商有余额接口 → 显示余额（DeepSeek `/user/balance`、OpenRouter `/credits`、
   Moonshot、SiliconFlow 已内置；自定义供应商用你填的路径）
2. 没有接口 → 尝试一批通用路径（`/dashboard/billing/*`、`/user/balance` …）
3. 都查不到 → 显示**本地 30 天 token 用量**，而不是一个看不懂的「—」

---

## 项目记忆（AEMEATH.md）

在被操作的项目根目录放 `AEMEATH.md`，内容自动注入 system prompt：

```markdown
# 项目记忆
- 技术栈：Node 22 + TypeScript，npm workspaces
- 测试命令：npm test
- 约定：不要直接改 dist/，用 npm run build
```

完整模板见 [`docs/AEMEATH.md`](docs/AEMEATH.md)。

## MCP 服务器

在 `~/.aemeath/config.json` 里声明，stdio JSON-RPC。MCP 工具注册进同一个
工具表，与内置工具无差别：

```json
{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "some-mcp-server"] } } }
```

---

## 故障排查

### 桌面端起不来，但命令行正常

先查工作目录的完整性标签：

```powershell
icacls "<项目目录>"
```

输出里出现 `Mandatory Label\Low Mandatory Level` 就是它 —— Chromium 的沙箱
子进程本身是低完整性，写不进这种目录，Electron 在创建缓存时被拒绝访问，
**退出码 3、无任何输出**；CLI 用纯 Node 不走沙箱，所以完全正常。

```powershell
icacls "<项目目录>" /remove:d Everyone
icacls "<项目目录>" /setintegritylevel (OI)(CI)M
```

沙箱化的 agent 工具会给自己的工作区打上这个标签。`scripts/launch.mjs` 会在
拉起 Electron 之前做这项检查，命中时直接打印修复命令。

### 其他

- **模型列表是空的** → 点 `⟳ 检测可用模型`；端点不提供列表接口就 `＋ 手动`
- **检测不到** → 看提示里的状态码：401 检查 Key、404 检查 `/v1`、429 限流
- **Key 不生效** → 环境变量优先于设置里保存的 Key，`unset DEEPSEEK_API_KEY` 再试

---

## 测试

```bash
npm test                                      # 109 个单元测试（纯离线）
npm run desktop -- --selftest                 # 界面自检（离线，起本地假服务器）
npm run desktop -- --smoke                    # 冒烟：启动 + 装配检查
npm run desktop -- --selftest --screenshot    # 顺便截图
```

**为什么两套**：单元测试看不到渲染进程。CSS 类没生效、保存后被表单覆盖、掩码
被当成 Key 发出去 —— 这些**单元测试全绿、问题照样存在**。只有把真实界面驱动
起来才会暴露，所以 `--selftest` 用注入的 DOM 探针跑真实 UI 并断言。

自检完全离线：起一个**本地假 `/v1/models`**（校验 `authorization`），探测前
确认表单确实指向本地，否则直接判定失败，避免误发真实请求。

---

## 安全

| 措施 | 说明 |
|---|---|
| `sandbox: true` | 渲染进程跑在 OS 沙箱里（preload 因此编成 CommonJS） |
| `contextIsolation` / `nodeIntegration: false` | 渲染进程拿不到 Node |
| CSP | `default-src 'self'` + **`connect-src 'none'`**，界面本身不联网，一切走 IPC |
| 外链白名单 | 只有 `http`/`https` 能交给系统浏览器，`setWindowOpenHandler` 与 IPC 共用同一道校验 |
| 输出转义 | 模型输出 / 工具结果 / 网页内容全部走 `textContent`，或先 `escapeHtml` 再解析 markdown |
| 路径限制 | 所有文件操作强制限制在工作目录内，越界报错 |
| 凭据隔离 | Key 只进加密库；`config.json` 写入前校验 |

**Key 读取顺序**（先命中先用）：

| # | 来源 |
|---|---|
| 1 | `AEMEATH_API_KEY`（显式覆盖） |
| 2 | 设置里保存的 Key（`credentials.json`） |
| 3 | `config.json` 里残留的明文（旧版本遗留，下次保存时迁移） |
| 4 | 厂商变量（`DEEPSEEK_API_KEY` …），**只在与 Base URL 匹配时** |
| 5 | `AEMEATH_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` |

> 设置里保存的 Key **优先于**厂商环境变量 —— 否则 shell 里恰好导出的
> `DEEPSEEK_API_KEY` 会静默盖掉你亲手配的那把。只有 `AEMEATH_API_KEY`
> 能盖过它，那是你主动指定的临时覆盖。

**Agent 会真实读写文件、真实执行命令**，请在可信目录使用。写文件和执行命令
默认需要人工批准，危险命令（`rm -rf /`、fork 炸弹、`curl|sh`）直接拒绝。

---

## 打包成 .exe

```bash
npm install
npm run desktop:dist       # 产物在 packages/desktop/release/
```

`release/` 里只留安装包：electron-builder 中间的 `win-unpacked/` 解包目录、
`.blockmap`（差分更新用，没有更新器就没用）和 `builder-debug.yml` 在打包成功后
会被删掉。想留住解包目录做测试，加 `AEMEATH_KEEP_UNPACKED=1`。

产出 `Aemeath Setup 0.1.0.exe`（约 90 MB）：双击一键装好并自动启动，
装到当前用户目录（`%LOCALAPPDATA%\Programs\Aemeath`），**不需要管理员权限**，
「应用和功能」里可正常卸载。装后占盘 312 MB，启动约 0.3 秒。
卸载**保留** `~/.aemeath`（会话和 Key 不丢）。

**为什么不用绿色版**：portable 每次启动要把 312 MB 解压到临时目录，实测
**4.9 秒**，是安装后的 16 倍。想要的话把 `build.win.target` 改成 `["portable"]`。

**为什么这么大**：90 MB 里 2.7 MB 是项目代码，其余是 Electron 运行时（与
VS Code ~100 MB 同量级）。构建做了三项裁剪：`electronLanguages` 只留
zh-CN / en-US（默认 55 个语言包解压 49 MB）、`compression: maximum`、
关掉 `differentialPackage`（没有更新器，`.blockmap` 白占 10 MB，关掉后
NSIS 还能用 solid 压缩）。
再想小只能换 Tauri（5–10 MB），但主进程要用 Rust 重写。

**人设随包走**：`skills/` 打进 `resources/skills`，不依赖工作目录。
诊断页应显示 `Skills 1 个：aemeath`。

**图标**：`assets/icon-source.svg` 是唯一来源（底块 + Lucide 的 sparkle，
ISC 协议见 `assets/ICON-LICENSE.txt`）。改完跑 `npm run icon` 重新生成
七档 `icon.ico` —— 它会用项目自带的 Electron 光栅化，逐档渲染而不是缩放。

**这个包没有代码签名**，Windows SmartScreen 会提示未知发布者；分发给别人
需要代码签名证书。

---

## 换主题

颜色、圆角、字体全在 `packages/desktop/src/renderer/styles/tokens.css`，
改这一个文件即可。样式表按层加载，顺序有意义：

```
tokens → base → app → settings → provider → utilities
```

`utilities.css` 必须最后 —— 它的 `.hidden` 要能盖住组件的 `display`。

---

## 架构

```
packages/core/       @aemeath/core —— 平台无关内核（不依赖 Electron）
packages/desktop/    Electron 桌面端（main / preload / renderer）
skills/aemeath/      爱弥斯人设（随仓库版本化）
docs/                配置字段参考、项目记忆模板
```

- **内核与界面解耦**：core 可在 CLI / 桌面 / 未来服务端复用
- **事件驱动**：内核只发 `AgentEvent`，界面订阅渲染
- **零运行时依赖**：全局 fetch、readline、自实现 MCP JSON-RPC

---

## 素材与致谢

内嵌桌宠的 Q 版像素爱弥斯精灵图来自 **`cuNuo/aemeath-mini-codex-pet`**（MIT，
上游 `gitee.com/lzy-buaa-jdi/ameath`），规格 `1536×1872`，8 列 × 9 行，
每格 `192×208`，9 种动画。素材在 `packages/desktop/assets/pet/`，已保留上游
`LICENSE` 与 `NOTICE.md` 以满足署名要求。

本仓库自研（不混淆）：`aemeath-sprite.js`（精灵引擎：自适应裁剪、变速帧、
双区域渲染）、`aemeath-pet.js`（行为状态机）、`aemeath-pixel.js`（回退画风）。

爱弥斯出自《鸣潮》，角色与美术权利归 **Kuro Games** 及权利方所有。本项目为
**非官方、非商业**同人作品，仅供个人学习使用；设定整理自公开资料，商用需授权。

## 路线图

- [x] core + CLI + 桌面端；Windows 优先
- [x] 权限、记忆、压缩、skills、MCP、计划模式、检查点撤销
- [x] 内嵌像素桌宠、液态玻璃界面、Windows 安装包
- [ ] 子 agent 并行执行
- [ ] Linux 打包与 CI
- [ ] Live2D 形象（可选，替换像素精灵）
