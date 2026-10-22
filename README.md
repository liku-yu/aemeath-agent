# 爱弥斯 · Aemeath Agent

**一个只为爱弥斯做的桌面 agent。**

不是通用 harness，也不是「接入任意角色」的框架。人设、语气、说话节奏、以及
「先有用再有性格」的工程习惯，是围绕同一个人一起设计的。所以她不是一层
可以换掉的外观，而是这个 agent 的起因。

TypeScript 写的，Windows 原生可用（无需 WSL2），架构上同时兼容 Linux / macOS。
工程实现参考了 GitHub 上优秀开源 agent 的做法（AemeathCode 的双进程/ReAct、
Claude Code 的 skills、aider 的精确替换编辑），但**完全自研、无 agent 框架依赖**。

> 爱弥斯（Aemeath）是《鸣潮》的角色。本项目是粉丝向的工程实践，非官方项目。

---

## 能做什么

- 🧠 **ReAct 循环**：规划 → 调用工具 → 观察结果 → 继续，直到完成
- 🎛 **多供应商 / 多接口**：供应商卡片列表 + 模板选择器（带图标、状态点、拿 Key 直达链接）；内置 10 个预设（DeepSeek / OpenAI / Anthropic / Moonshot /
  百炼 / 智谱 / 硅基流动 / OpenRouter / Ollama / 自定义），可切换
  **Chat Completions / Responses API / Messages API** 三种接口模式
- 🌊 **流式混排**：思考（Reasoning）、正文、工具调用可按**任意顺序**穿插输出
- 🗑 **会话管理**：侧栏一键删除、设置页批量删除全部会话
- 🧩 **标准 Skill 目录**：读取 `<项目>/.aemeath/skills`、`<项目>/skills`、
  `~/.claude/skills`、`~/.aemeath/skills`，支持含 `SKILL.md` 的目录与单文件
- 📋 **计划模式**：只读调研、输出方案，**harness 层面强制禁止**改动工作区；模型可用 `enter_plan_mode` / `exit_plan_mode` 主动进出（降权免批准、升权需批准）
- ↶ **检查点 / 撤销**：每次写文件前自动快照，一键回滚（含删除agent新建的文件）
- 🛠 **内置 14 个工具**：读/写/编辑文件、列目录、glob、grep、执行命令、**网页抓取**、长期笔记、任务清单、子 agent、计划模式进出
- 🔐 **权限审批**：写文件/执行命令前弹窗确认，支持"本次 / 允许这一类 / 永远 / 拒绝"，通配规则记住一整类；危险命令不提供放宽选项（fail-closed）
- 💾 **三层记忆**：单轮内 / 会话内（可恢复）/ 跨会话（note + `AEMEATH.md`）
- 📦 **上下文自动压缩**：逼近预算时用辅助 LLM 摘要早期轮次（磁盘原文不动）
- 🎭 **爱弥斯人格**：明亮的偶像系语气 + 温柔的守护者内核。人设分两层：常驻
  system prompt 只放身份、语言规范与红线；完整的身份、性格、说话方式、记忆与
  人物关系按需加载，不一次性塞进上下文
- ✨ **有情绪的桌面伙伴**：**真实 Q 版像素爱弥斯**（社区 MIT 授权的 9 种动画：待机/工作/
  检查/等待/跳跃/挥手/失败/左右移动），随 agent 状态实时切换
- 🐾 **内嵌桌宠**：桌宠就在**主窗口内右下角**（不是单独窗口），可拖动、点击互动，
  常驻显示**当前模型**与**账户余额**（支持 DeepSeek；余额不足会主动提醒）
- 🧩 **Skills**：markdown 技能默认只加载简介，按需 `use_skill` 展开
- 🔌 **MCP 客户端**：stdio JSON-RPC，外部 MCP server 的工具与内置工具无差别
- 🖥 **桌面端**：Electron UI（会话列表、流式输出、工具卡片、权限弹窗、开箱即用的引导）
- ⌨️ **CLI**：终端 REPL / 一次性 `-p` 模式
- ⚡ **秒开**：esbuild 构建约 60ms，且启动时先显示窗口、后台初始化 agent

---

## 架构

```
aemeath/                          npm workspaces
├── packages/core/                @aemeath/core —— 平台无关的 agent 内核
│   └── src/
│       ├── agent/loop.ts         ReAct 循环 + 上下文压缩
│       ├── llm/                  多 provider（Anthropic / OpenAI 兼容）
│       ├── tools/                工具注册表 + 内置工具
│       ├── memory/session.ts     会话（NDJSON 增量journal）+ 笔记
│       ├── permissions/          allow-once/always/deny 策略
│       ├── skills/               按需加载的技能
│       ├── mcp/client.ts         MCP stdio 客户端
│       ├── persona/              爱弥斯人设 + system prompt
│       └── cli.ts                终端界面
├── packages/desktop/             @aemeath/desktop —— Electron 桌面端
│   └── src/
│       ├── main/main.ts          主进程：托管 core、IPC、权限弹窗
│       ├── main/preload.ts       安全的 contextBridge 暴露面
│       └── renderer/             界面（HTML/CSS/JS，无构建步骤）
└── docs/
    ├── config.reference.json     配置文件字段参考
    └── AEMEATH.md                项目记忆模板（放进被操作项目的根目录）
```

**关键设计**
- **内核与界面解耦**：`core` 不依赖 Electron，可在 CLI / 桌面 / 未来服务端复用。
- **事件驱动**：内核只发 `AgentEvent`（流式文本、工具开始/结束、权限请求…），界面订阅渲染。
- **安全边界**：renderer 无 Node 权限、开启 OS 沙箱、CSP 禁止外连；一切能力经 preload 白名单 IPC。
- **路径安全**：所有文件操作强制限制在工作目录内，越界直接报错。

---

## 快速开始

### 环境要求
- **Node.js ≥ 22.12** 和 npm（`node -v` 自查；Electron 45 自带这个下限）
- 约 1 GB 磁盘空间（`node_modules` 里 Electron 本体约 200 MB）
- 一个 OpenAI 兼容或 Anthropic 兼容的 API（DeepSeek、Moonshot、OpenAI、Anthropic、自建网关…）
- Windows / Linux / macOS 均可；Windows 无需 WSL2

### 安装

```bash
cd aemeath
npm install          # 如 Electron 下载慢，见下方"国内镜像"
npm run build        # 构建 core + desktop
```

#### 国内镜像加速 Electron 下载（可选）
```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
# bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install
```

### 运行桌面端 🖥
```bash
npm run desktop
```
启动很快：esbuild 增量构建（未改动时直接跳过）+ 窗口即时显示，agent 内核在后台初始化。
首次启动会自动弹出**设置**窗口：填写 Base URL / API Key / 模型即可。

会打开主窗口，其中包含：
1. **对话区** —— 流式输出、工具卡片、欢迎引导
2. **侧栏** —— 像素爱弥斯头像、模型/余额、会话列表、设置
3. **内嵌桌宠** —— 主窗口右下角的真实像素爱弥斯，显示模型 + 余额，
   可拖动、可点击互动、可随时隐藏（侧栏「桌宠」开关或桌宠上的 ✕）

> 想改回"每次强制重新构建"：`npm run desktop:build && electron packages/desktop`。

### 运行 CLI ⌨️
```bash
npm run cli                 # 交互式 REPL
npm run cli -- -p "列出当前目录的文件"   # 一次性执行
npm run cli -- --yolo       # 自动允许写入/命令（谨慎）
```

---

## 配置

优先级：**真实环境变量 > 项目 `.aemeath/.env` > `~/.aemeath/config.json` > 默认值**

### 首次运行：没有配置文件，用默认值

刚 clone 下来时 `~/.aemeath/config.json` **不存在**，程序用内置默认值跑：

| 项 | 默认值 |
|---|---|
| 供应商 / 协议 | `deepseek` / `chat`（Chat Completions） |
| 模型 | `deepseek-chat` |
| Base URL | `https://api.deepseek.com` |
| 权限 | 写文件 `ask` / 执行命令 `ask`（每次都问） |

按默认值你只需要一个 **DeepSeek 的 Key** 就能开始：在桌面端「设置 → 模型与接口」
粘上 Key 点保存，这时才会生成 `~/.aemeath/config.json`。

想用别的供应商，在同一个页面点左侧的供应商卡片切换即可 —— 每个供应商的地址、协议
和 Key 都各自独立保存。

`config.json` 长这样（**`apiKey` 永远不在这里**，见下一节）：

```json
{
  "provider": "deepseek",
  "apiMode": "chat",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com",
  "permissions": { "writeFile": "ask", "runCommand": "ask" },
  "persona": { "enabled": true, "file": "" }
}
```

- 想让多个项目共用同一套设置 → 改这个全局文件
- 只想给某个项目特殊设置 → 用下面的项目级覆盖
- 想清空重来 → 删掉这个文件，下次启动就回到默认值

### 通过桌面端设置
点左下角 ⚙ 设置 →「模型与接口」，填好后保存（写入 `~/.aemeath/config.json`）。

#### 模型列表管理

设置页会列出当前供应商可用的模型：

- **⟳ 自动检测模型** —— 向供应商查询可用模型（支持 OpenAI 兼容的 `/v1/models`
  与 Ollama 的 `/api/tags`，结果会缓存到 `detectedModels`）
- **＋ 添加** —— 手动加一个模型名，存入 `savedModels`
- **点模型名** —— 设为当前使用的模型
- **⚡ 每个模型后面的小按钮** —— 单独测试该模型是否可用
- **×** —— 从列表移除

> 自动检测失败时会给出可操作提示（Key 无效 / JWT 已过期 / Base URL 多了或少了 `/v1` / 网络不通）。
> 该供应商若不提供模型列表接口，就手动添加。

#### API Key 不落盘（重要）

**`config.json` 里没有、也不会有 API Key。** 参照 ZCode 的凭据方案：

- Key 存在独立的 `credentials.json`，**AES-256-GCM 加密**（前缀 `enc:v1:`）
- 桌面端在可用时优先用 **Electron `safeStorage`（系统钥匙串）** 加密
- 文件以 `0600` 权限写入，且用「临时文件 + rename」原子替换
- 凭据**损坏时拒绝覆盖**，改为改名隔离（`*.corrupt-<时间>`），避免清空其他 Key
- 换过加密方式后，旧密文仍能解密（自动回退到机器绑定的 cipher）
- 按**端点作用域**隔离：`provider@baseUrl`，换 Key/换地址互不影响

**兜底保护**：写入配置前会校验，一旦发现疑似密钥字段就**拒绝写入**并报错，
防止以后改代码时不小心把 Key 又写回配置文件。

**保存后显示脱敏预览**，而不是留一个空框。预览**一直在**，不会因为你点一下
输入框就消失 —— 你可以一边看着「这个供应商用的是哪个 Key」一边改它的模型列表：

```
保存前  [ 你粘的 Key            ]   👁 保存  清除
保存后  [ 前4位••••••••后4位     ]   ✎ 更换  清除     ← 只读，首尾可见
点「更换」[                        ]   👁 保存  清除     ← 清空，可填新的
按 Esc   [ 前4位••••••••后4位     ]   ✎ 更换  清除     ← 取消，还原预览
```

- 掩码**固定 8 位**，不泄露 Key 的真实长度
- **太短的 Key 一个字符都不显示**（首尾都露出来就等于全露了）
- 真实 Key **从不离开主进程**：`maskSecret()` 在主进程算好，只把掩码发给界面
- 掩码框是**只读**的，并且有 `keyFieldMasked` 标志兜底 —— 预览永远不会被当成
  Key 存回磁盘
- 替换 Key 是**显式动作**（点「更换」），不会被误点触发；「保存」按钮在掩码状态
  下隐藏，避免把预览当成 Key 存进去
- 编辑到一半失焦或按 Esc 都会**还原预览**，不会留下一个看起来空的框

**Key 跟着「选中的供应商」走，不是「正在使用的」。** 在左边点哪个供应商，下面的 Key
就是哪个的 —— 没配过的显示**空、可直接输入**（不用先点「更换」）：
```
点 Moonshot（没配过）  [ 粘贴 Key（不会写入配置文件） ]  👁 保存  清除
点 OpenAI（配过）      [ sk-a••••••••9f2c            ]  ✎ 更换  清除
```
- **保存 Key 不会跳供应商**。设置表单只在真正需要时（打开设置 / 保存设置 / 顶栏切模型）
  才从配置回填；一次普通的状态刷新不会覆盖你正在编辑的内容
- **每个供应商的状态点都是它自己的**：🟢 已配好 · 🟡 缺 Key · 本地服务（Ollama）天然可用
- Key 按 `provider@baseUrl` 作用域隔离，**切换端点会自动重新载入对应的 Key** ——
  否则 A 的 Key 会被写到 B 的作用域上，下一次请求就用错的凭据去鉴权了
- **检测模型只认这个端点自己的 Key**：不用把 Key 重新填一遍，保存过就能直接检测。
  掩码是给人看的，**永远不会被当成 Key 发出去**

**两个「保存」按钮都会存 Key。** 设置页底部有个全局「保存」，API Key 那一行也有个「保存」——
**你输入了 Key，按哪一个都会存下来**，不存在"按错按钮就白填"的情况。

> 迁移：如果你之前把 Key 存在 `config.json` 里，第一次保存时会自动搬进加密存储。

#### 模型列表按「Key」隔离（重要）

同一个供应商配不同的 API Key，可能是**不同的分组/套餐，能看到不同的模型**。
因此模型缓存不是按供应商 id 存的，而是按**端点作用域**：

```
provider @ baseURL # key指纹
例如: custom@https://gw.example.com/v1#ac798528:67
```

- 换一个 Key（或换 Base URL）→ 是**另一个作用域**，模型列表互不干扰
- 缓存里**只存哈希指纹**，不含 Key 明文
- 旧的按供应商 id 存的缓存不再匹配，会自动失效（不会串到新 Key）

#### 检测不到就说检测不到

**不会替你猜模型。** 检测失败时明确告诉你原因，并给出下一步：

| 情况 | 提示 |
|---|---|
| 401 / 403 | Key 不能列出模型；可能过期，或该分组不开放此接口 |
| 404 | 地址没有模型列表接口；可能多了/少了 `/v1` |
| 网络错误 | 地址、代理或服务未启动 |
| 返回空列表 | 接口没给可解析的列表，请手动填 |

模型列表里，**手动添加的会标注「手动」徽章**，与你检测到的区分开。
供应商预设的 `defaultModel` **不会**被当作"已检测到的模型"塞进列表。

#### 两个「防手滑」按钮

| 按钮 | 位置 | 作用 |
|---|---|---|
| **↺ 恢复默认** | Base URL 右侧 | 只在你把地址改得和默认值不一样时出现。一键恢复该供应商的默认地址**和协议**，并给出提示告诉你默认值是什么 |
| **🧹 只留检测到的** | 模型区 | 只在列表里存在「当前 Key 检测不到」的条目时出现。点它把那些清掉，**检测结果本身不动** |

**为什么需要恢复默认**：手改 endpoint 是毁掉一个能用配置最快的方式 —— 多一个斜杠、
少一个 `/v1`、host 打错一个字母，症状却是很久之后一个看不懂的 404。
把回去的路做成一次点击，比事后 debug 便宜。

**为什么需要「只留检测到的」**：检测结果缓存在 `detectedModels`（按 Key 作用域），
手动添加的存在 `savedModels`（同样按作用域）。两个桶**分开放**，所以：

- 检测**只替换** `detectedModels`，永远不会覆盖你手填的模型
- 检测**只显示当前 Key 能看到的东西** —— 以前会把界面上的旧列表并进来再存回去，
  于是 A Key 的模型会渗进 B Key 的列表并且永久留下
- 万一已经渗进去了，用这个按钮手动清

#### 供应商管理

设置页「模型与接口」左侧是**供应商卡片列表**（左列表 + 右详情），参照 ZCode 的
Model Provider 设置页设计：

```
┌──────────────┬──────────────────────────────────────┐
│ 供应商    ＋  │ 🐋 DeepSeek              ●           │
│              │ 接口类型  [Chat Completions ▾]       │
│ 内置          │ Base URL  [https://api.deepseek.com] │
│  🐋 DeepSeek │ API Key   [······] 👁 保存 清除      │
│  ⬢ OpenAI    │ 还没有 Key？去 DeepSeek 获取         │
│  🅐 Anthropic │ 模型 …                               │
│  …           │                                      │
│ 自定义        │                                      │
│  ✨ 我的网关  │                                      │
└──────────────┴──────────────────────────────────────┘
```

**添加供应商**（`＋`）打开**模板卡片网格**：

- 每个模板已经带好了**接口地址**和**协议**，选完只需粘贴 Key —— 不用先搞懂
  chat-completions 和 anthropic-messages 的区别
- 模板还带 `keyUrl`，会显示「去 XXX 获取」的直达链接
- 最后一格是「新建自定义供应商」，自己填地址和协议

| 操作 | 说明 |
|---|---|
| **＋ 添加** | 从模板网格选一个；或选「新建自定义供应商」——**只问名称**，地址和 Key 在右边填 |
| **离开表单** | 点别的供应商卡片 · 按 Esc · 点「取消」——三条路都能出去 |
| **✎ 编辑 / ⧉ 复制 / 🗑 删除** | 仅自定义供应商可用；内置模板是只读定义 |
| **状态圆点** | ● 绿=可用 · ● 黄=缺 Key · ● 灰=未在使用 |

- **协议按供应商记忆**：每个供应商存自己的 `apiMode`，来回切换会恢复对应的 wire protocol
  而不是沿用上一个的
- 复制会派生一个变体（同一网关的不同分组），自动命名 `xxx-2`
- 删除走**主题化确认弹窗**，并清理该供应商缓存的模型列表
- **图标自动推导，不用手填**：认识的服务商复用它的标记（`api.deepseek.com` → 🐋），本地地址给 🖥️，其他按域名取首字母（`api.mygateway.com` → **M**）。改地址时图标实时跟着变
- 新建时**只问名字**（参考 ZCode）：创建完直接落到详情页，在那里填地址、协议、Key，并且**保存前就能测试**
- 草稿状态（还没填地址）**不会被当成活动供应商保存** —— 保存时会明确拦下并告诉你缺什么
- **表单会占满整个右侧面板**（而不是盖在当前供应商的设置上面），所以屏幕上不会同时出现
  两组 Base URL
- 表单里**改过东西**再想走，会先问一句；**没填过**就直接关，不拦你
- 内置预设（DeepSeek / OpenAI / Anthropic …）**只读**，要改就复制一份

> 说明：状态圆点只对**当前活动供应商**给出真实状态（我们只知道它的 Key 情况）；
> 其余一律显示灰色「未在使用」，而不是编一个查不到的状态。

#### 自定义供应商

设置页「供应商」旁边有 **＋ 新增**，可以声明自己的网关 / 代理：

- **名称**（显示用）、**ID**（英文标识）
- **Base URL**（例如 `https://gateway.example.com/v1`）
- **默认模型**（可选）、**余额接口路径**（可选，如 `/user/balance`）

自定义供应商会出现在供应商下拉与主页切换器里，和内置预设一样使用。
删除时只移除这条定义，不影响其他配置。

#### 在主页切换供应商 / 模型

顶栏有一个 `供应商 / 模型` 选择器：

- 点开后可**先选供应商、再选模型**（两列布局）
- 支持**搜索**过滤（供应商名或模型名都能搜）
- **↑↓ 选择 · Enter 应用 · Esc 关闭**
- 切换后立即生效，不需要进设置页；若换了供应商，会自动带上它的 Base URL 与接口模式

#### 测试连通性

每次测试都是一次**极小的真实请求**，因此会先弹窗确认（遵守 API Key 使用规则）：

- 成功 → 显示 HTTP 状态、耗时、实际请求的 URL、模型回复样例、token 用量
- 失败 → 显示错误原因 + 建议（401 检查 Key、404 检查 `/v1`、429 限流、超时等）

测试会使用**输入框里刚填但还未保存**的 Base URL / Key / 模型，方便先验证再保存。

### 通过环境变量
```bash
# 通用
export AEMEATH_BASE_URL="https://api.deepseek.com"
export AEMEATH_MODEL="deepseek-chat"
export AEMEATH_API_KEY="sk-..."

# 也可以复用各家常规变量名（自动识别）
export DEEPSEEK_API_KEY=...
export ANTHROPIC_API_KEY=...
```

> ⚠️ **自动读取环境变量是可选的**。如果你不希望程序自动取用某个已有变量，
> 就不要把 Key 放在这些变量名里，改在桌面端「设置」里手填即可。

### 项目级覆盖
在项目根目录建 `.aemeath/.env`：
```ini
AEMEATH_MODEL=deepseek-chat
AEMEATH_API_KEY=sk-...
```

### 常用服务商示例
| 服务商 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn` | `moonshot-v1-8k` |
| OpenAI | `https://api.openai.com` | `gpt-4o` |
| Anthropic | `https://api.anthropic.com` | `claude-sonnet-4-5-20250929` |
| Ollama（本地） | `http://localhost:11434` | `qwen2.5:14b` |

> 协议自动识别：`anthropic.com` 走 Messages API，其余走 OpenAI Chat Completions。

---

## Skills（技能）

**爱弥斯人设已安装到全局**，所以在任何项目目录下都带着完整人设。

查找顺序（先匹配者生效）：

| 位置 | 作用域 |
|---|---|
| `<项目>/.aemeath/skills/` | 项目专属 |
| `<项目>/.claude/skills/` | 项目专属（兼容 Claude 约定） |
| **`<项目>/skills/`** | **项目专属 —— 爱弥斯人设就在这里（本仓库的 `skills/aemeath/`）** |
| `~/.aemeath/skills/` | 全局（其他技能可放这里） |
| `~/.claude/skills/` | 全局（兼容） |
| `~/.config/agent/skills/` | 全局（兼容） |

### 爱弥斯人设的结构

人设随仓库一起版本管理，**仓库里的这份是唯一来源**（本机不再另存一份，
避免两份改动不同步）。

```
skills/aemeath/
├── SKILL.md          # 入口 + 按需查阅表（frontmatter: name/description）
├── profile.md        # 身份、外观、属性、世界观
├── personality.md    # 性格与价值观
├── interaction.md    # 说话方式、口头禅、去 AI 味对照
├── memory.md         # 经历与关键剧情
├── relations.md      # 人物关系
└── conflicts.md      # 设定冲突与更正记录
```

它不走「可选技能」那套语义：`aemeath` 决定她是谁，其余技能才是给她加能力。

只有 `SKILL.md` 的 `name` + `description` 会进 system prompt；
正文在人设被用到时才通过 `use_skill` 加载，节省上下文。

### 自己加技能
把含 `SKILL.md`（或单个 `.md`）放进上面任一目录即可。

（本项目自带的人设技能是 `aemeath`，不属于「可选技能」：它决定她是谁，
而不是给她加一项能力。）

### 头像与桌宠的裁剪

精灵图里角色是**头 + 身体 + 大翅膀**，直接用整格会连翅膀一起缩放，脸只剩一点点。
所以渲染时用两个裁剪区域：

| 区域 | 用途 | 计算方式 |
|---|---|---|
| `full` | 桌宠（完整形象） | 所有动画行的并集包围盒 |
| `bust` | 头像（脸占满） | **单帧**内的头肩区域，取正方形 |

`bust` 的取法有三条约束，任一不满足头像就会失真：

1. **只在单帧内测宽度** —— 跨帧取并集会把别的帧的翅膀算进来
2. **按最大跳变找边界** —— 头发是渐变的（每列 +20~24px），翅膀是突变的（+55~87px）；
   用比例阈值会被正常发型的增长误触发
3. **取宽、高的较大值做正方形** —— 按格高的比例裁剪会把下巴切掉

如果你换了角色图，这三个参数在 `packages/desktop/src/renderer/aemeath-sprite.js`
里可以调。

### 余额与用量

顶栏的余额徽章按三级策略显示，**不会假装知道**：

1. **供应商有余额接口** → 显示余额（`¥12.34`），余额不足会变红并由桌宠提醒
   - 内置适配：DeepSeek `/user/balance`、OpenRouter `/credits`、
     Moonshot `/users/me/balance`、SiliconFlow `/user/info`
   - 自定义供应商：优先用你填的 `余额接口路径`
2. **没有余额接口（常见于自建网关）** → 自动尝试一批通用路径
   （`/dashboard/billing/subscription`、`/dashboard/billing/credit_grants`、
   `/api/user/self`、`/user/balance`、`/user/info`、`/api/usage/credits` …）
3. **都查不到** → 显示**本地统计的 token 用量**（近 30 天，按模型分组），
   而不是留一个看不懂的「—」

> 本地用量记录在 `<dataDir>/usage.json`，每次模型调用后写入，与供应商无关。

## 项目记忆（AEMEATH.md）

在被操作的**项目根目录**放一个 `AEMEATH.md`，内容会自动注入 system prompt，
让 agent 记住这个项目的技术栈和约定：

```markdown
# 项目记忆
- 技术栈：Node 22 + TypeScript，npm workspaces
- 测试命令：npm test
- 约定：不要直接改 dist/，用 npm run build
```

完整模板见 [`docs/AEMEATH.md`](docs/AEMEATH.md)，复制过去改名即可。

## MCP 服务器

在 `~/.aemeath/config.json` 里：
```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  }
}
```

---

## 故障排查：桌面端起不来，但命令行正常

如果 `npm run desktop` 立刻退出（退出码 3、无任何输出），而 `npm run cli` 正常，
**先查工作目录的完整性标签**：

```powershell
icacls "C:\Users\<你>\Desktop\agent\aemeath"
```

如果输出里出现 `Mandatory Label\Low Mandatory Level`，就是它：

- Chromium 的沙箱子进程本身就是**低完整性**，写不进带低 IL 标签的目录
- Electron 因此在创建缓存时被拒绝访问，GPU / 网络服务跟着崩，启动即退出
- 命令行版本用纯 Node，不走那套沙箱，所以完全正常 —— 看起来像构建问题，其实不是
- **沙箱化的 agent 工具（某些 AI agent）会给自己的工作区打上这个标签**，
  在其中创建的对象都会继承它

修复（不改文件内容，只恢复默认完整性级别）：

```powershell
icacls "<项目目录>" /remove:d Everyone
icacls "<项目目录>" /setintegritylevel (OI)(CI)M
```

`scripts/launch.mjs` 会在拉起 Electron **之前**做这项检查，命中时直接打印上面这段提示，
不会让你对着一个静默退出的进程猜。

---

## 测试

```bash
npm test                              # 单元测试（100 条，纯离线）
npm run desktop -- --selftest        # 界面自检（离线，自动起本地假服务器）
npm run desktop -- --smoke           # 冒烟：启动 + 装配检查
npm run desktop -- --selftest --screenshot   # 顺便截图，停在供应商页
```

**为什么要两套。** 单元测试看不到渲染进程。这个项目踩过的坑 —— CSS 类 `hidden`
其实没有对应规则、保存后被表单覆盖、掩码被当成 Key 发出去 —— **单元测试全绿，问题照样
存在**。只有把真实界面驱动起来才会暴露，所以 `--selftest` 用注入的 DOM 探针跑真实 UI
并断言。

自检完全离线：它会起一个**本地假 `/v1/models`**（随机端口，校验 `authorization`），
并在探测前确认表单确实指向本地 —— 否则直接判定失败，避免误发真实请求。

端到端（**会真实调用**，需要你自己决定）：

```bash
AEMEATH_BASE_URL=https://api.deepseek.com \
AEMEATH_MODEL=deepseek-chat \
AEMEATH_API_KEY=sk-... \
node --import tsx packages/core/src/test/e2e.ts "创建 hello.txt 再读回来"
```

---

## 安全边界

| 措施 | 说明 |
|---|---|
| `sandbox: true` | 渲染进程跑在 OS 沙箱里（preload 因此编成 CommonJS） |
| `contextIsolation: true` / `nodeIntegration: false` | 渲染进程拿不到 Node |
| CSP | `default-src 'self'` + **`connect-src 'none'`** —— 界面本来就不联网，一切走 IPC，所以直接堵死外连 |
| 外链白名单 | 只有 `http`/`https` 能交给系统浏览器；`setWindowOpenHandler` 和 IPC **共用同一道校验** |
| 输出转义 | 模型输出 / 工具结果 / 网页内容全部走 `textContent`，或先 `escapeHtml` 再解析 markdown |
| 凭据隔离 | Key 只进加密凭据库；`config.json` 写入前校验，且校验器不会因作用域名带 `key` 而误报 |

---

## 打包

```bash
npm run desktop:build       # 生成 Windows NSIS/portable（在 release/）
```
Linux/macOS 打包配置已写在 `packages/desktop/package.json` 的 `build` 字段里
（`AppImage`/`deb`/`dmg`），在对应平台执行即可。

---

## 安全说明

### 关于 API Key（重要）

**Key 不会写进 `config.json`，也不该往里写。** 它存在独立的 `~/.aemeath/credentials.json`，
用 AES-256-GCM 加密（桌面端优先用系统钥匙串）。`config.json` 写入前会校验，
一旦发现疑似密钥字段就**直接拒绝写入并报错**，防止以后改代码时不小心把 Key 写回配置文件。

**读取 Key 的顺序**（先命中先用）：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `AEMEATH_API_KEY` | 显式、与供应商无关 |
| 2 | `ANTHROPIC_API_KEY` | 历史默认名 |
| 3 | 厂商变量（`DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `OPENROUTER_API_KEY` …） | **只在厂商跟当前 Base URL 对得上时才用** |
| 4 | `AEMEATH_ANTHROPIC_API_KEY` | 旧名兼容 |
| 5 | `credentials.json` 里保存的 Key | 你在设置面板里填的那个 |

> ⚠️ **注意第 5 条排在最后。** 如果你的 shell 里正好设着 `DEEPSEEK_API_KEY`，
> 它会**盖过**你在设置里保存的 Key，哪怕你用的是别的供应商。想让设置面板里的
> Key 生效，先把环境变量清掉（`unset DEEPSEEK_API_KEY`）。
> 项目内的 `.aemeath/.env` 也属于“环境变量”这一层。

没有 Key 时它只提示你去配置，不会去别处翻。

### 其他
- Agent 会**真实读写文件、真实执行命令**。请在可信目录使用。
- 写文件与执行命令默认需要人工批准；危险命令（`rm -rf /`、fork 炸弹、`curl|sh`…）直接拒绝。
- `--yolo` / 设置里允许后不再询问，请谨慎。
- 数据目录 `~/.aemeath/` 是**全机共用**的（会话、凭据、用量都在里面）；
  想给某个项目单独配置，用项目根目录的 `.aemeath/.env` 覆盖，不要改全局配置。

## 素材与致谢

### 像素形象的来源

内嵌桌宠使用的 Q 版像素爱弥斯精灵图来自开源项目：

- **`cuNuo/aemeath-mini-codex-pet`** —— **MIT License**
  - 图集规格：`1536×1872`，8 列 × 9 行，每格 `192×208`
  - 9 种动画：`idle` / `running-right` / `running-left` / `waving` / `jumping` /
    `failed` / `waiting` / `running` / `review`
  - 上游来源：`gitee.com/lzy-buaa-jdi/ameath`（同为 MIT）

素材文件位于 `packages/desktop/assets/pet/`，并**保留了上游的 `LICENSE` 与 `NOTICE.md`**
以满足 MIT 的署名要求。

本仓库自研的部分（不与上述素材混淆）：
- `aemeath-sprite.js` —— 精灵引擎（自适应裁剪、变速帧、双区域渲染）
- `aemeath-pet.js` —— 桌宠行为状态机（随 agent 状态切换 + 自主小动作）
- `aemeath-pixel.js` —— 精灵图加载失败时的内置回退画风

### 角色说明

爱弥斯（Aemeath）出自《鸣潮》，角色与美术素材权利归 **Kuro Games** 及其权利方所有。
本项目为**非官方、非商业的同人作品**，仅供个人学习与使用；
角色设定整理自公开资料（萌娘百科等），若要商用请先取得相应授权。

## 路线图

- [x] core + CLI + 桌面端；Windows 优先
- [x] 权限、记忆、压缩、skills、MCP
- [x] 计划模式、检查点撤销、网页抓取、多供应商/多接口
- [x] 内嵌像素桌宠（自适应裁剪 + 变帧动画 + 行为状态机）
- [ ] 子 agent 并行执行
- [ ] Linux 打包与 CI（架构已就绪）
- [ ] Live2D 形象（可选，替换像素精灵）
