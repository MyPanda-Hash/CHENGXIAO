# dsh-peer-mcp

让**两台电脑上的 DSH 互相提问、互相传文件**，而各自的文件始终留在本地。

这是"截图 + 模拟键盘"之外的另一条路：不再让一个 agent 用眼睛看屏幕、用手指点按钮，
而是让两边通过协议直接说话。A 机的 DSH 把 B 机当成一个工具来调，B 机在自己的机器上
用**自己本地的文件、工具和模型**干活，只把结论和文件回传。

同一个包有两种用法：

| 用法 | 入口 | 场景 |
|---|---|---|
| **DSH 插件**（推荐） | `lib/plugin.js` | 装进 profile，agent 直接用四个 `peer_*` 工具；设置页/命令行驱动配对 |
| 独立适配器 | `src/bin.js` | 不起 DSH 也能当干活端；`start-peer.ps1` 一键启动 |

## 作为插件安装（侧载）

1. 把 `lib/`、`src/`、`package.json`、`cordis.patch.yml` 复制到
   `~/.dsh/profiles/<profile>/node_modules/@local/dsh-peer-mcp/`。
   **不要**复制开发目录里的 `node_modules`（那是我调试用的 junction，会把宿主解析影子化）。
2. 在该 profile 的 `cordis.patch.yml` 里追加一行 `insert`（见本仓库 `cordis.patch.yml` 的注释）。
3. 重启 DSH。

**插件不需要自带依赖**：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-mcp-client`、
`@modelcontextprotocol/sdk`、`@hono/node-server` 由 DSH Desktop 铺在
`~/.dsh/profiles/node_modules/`（其中部分是 junction，指向应用目录），插件从中解析。
实测：安装副本在纯 Node 下 `import` 这四个包全部成功。

### agent 能做什么，不能做什么

给模型四个工具：

| 工具 | 作用 |
|---|---|
| `peer_status` | 报告监听状态、对端地址、待配对码到期时间、两个方向的机器列表（**不含任何秘密**） |
| `peer_ticket` | 申请一个一次性配对码转交给人；监听未开时**拒绝**并说明要人去设置里打开 |
| `peer_pair` | 贴入别人给的 `dshp://` 链接完成配对 |
| `peer_revoke` | 撤销某个对端的访问权 |

**四个工具里没有任何一个能打开监听口或放宽权限** —— "是否对外暴露"只能改配置，
模型的职责是把配对码转达给人。有一条测试专门盯着这条边界（加个叫 `peer_listen` 的工具就会红）。

### 改完代码后必须重新同步

宿主加载的是 profile 里的**安装副本**，不是这个仓库。改完 `lib/` 或 `src/` 之后：

```powershell
$dest = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-peer-mcp"
Copy-Item .\lib, .\src -Destination $dest -Recurse -Force
Copy-Item .\package.json, .\cordis.patch.yml, .\README.md -Destination $dest -Force
```

忘了同步的后果是**测试全绿、宿主启动崩溃** —— 这正是本插件第一次上线时的故障。现在有两道防线：

```powershell
node --test test/            # 其中一条测试比对安装副本与源码，过期就红并指名文件
node .\verify-host-load.mjs  # 用最小 Cordis 上下文真的跑一遍 apply()，逐个报出四个工具
```

`verify-host-load.mjs` 做的事和宿主一样：导入入口 → 用插件的 `Config` schema 校验配置 →
构造最小 `ctx`（`tools.register` / `effect` / `provide` / `logger`）→ 调 `apply()` →
报告注册了哪些工具、拆卸是否干净。任何一步失败都会**指名道姓**，而不是丢一个 `render` undefined 给你。

## 安全模型（配对码 ≠ 密码）


v2 起，认证不再是"一个共享密钥"，而是**配对 + 每对端凭据**：

| 概念 | 含义 |
|---|---|
| **配对码** | 短时（默认 15 分钟）、**一次性**、只用于一次握手。泄露了也只值一次配对。 |
| **对端凭据** | 握手后发给对方的长期密钥。**磁盘上只存它的 sha256**，明文只在配对那一刻返回一次。 |
| **信任表** | `$DSH_HOME/dsh-peer/trust.json`，记录对端身份、公钥、权限档位、撤销时间。 |
| **撤销** | 撤销后凭据立即失效，但记录保留可审计。 |

**关于"提权"的重要澄清**：插件**不能**提升权限级别——它运行在 DSH 进程里。真正可配置的是
**每个对端的权限档位**（`workspace-write` / `danger-full-access`），由 DSH 的权限预设机制生效。
界面上写的是"允许对端在你机器的什么范围内干活"，不是"管理员权限"。

```
┌─ A 机（你正在用的）─────────┐        ┌─ B 机（服务器）──────────────┐
│ DSH Desktop                │        │ 文件/仓库都在本地，不搬家     │
│  └ mcp-client ─────────────┼── HTTP ┼─▶ dsh-peer-mcp（本包）      │
│     工具名 mcp__peerB__*    │  凭据  │     ├ ask        → dsh    │
│                            │        │     ├ fetch_file → 读本地  │
│                            │        │     └ send_file  → 收文件  │
└────────────────────────────┘        └──────────────────────────────┘
```

## 它暴露什么

三个工具，边界刻意做窄：

| 工具 | 作用 | 风险面 |
|---|---|---|
| `ask` | 在 B 机跑一个完整任务（`dsh --profile headless "<任务>"`），返回答案 | 相当于把 B 机的执行权交给 A 机的模型 |
| `fetch_file` | 把 B 机的一个文件读成 base64 + sha256 | 只读，受目录白名单与大小上限限制 |
| `send_file` | 把 A 机的文件落到 B 机的 **staging 目录** | 只写 staging，**不能指定路径、不会覆盖同名文件** |

安全设计（都有测试盯着）：

- **无共享密钥拒绝启动**，密钥至少 32 字符，比较用 `timingSafeEqual`，前缀/大小写/尾随空格都不放行。
- 默认**只监听 `127.0.0.1`**，要对外必须显式设 `DSH_PEER_HOST`。
- `ask` 的工作目录受**目录白名单**限制，且按路径分量比较（`C:\work-evil` 不会因为是 `C:\work` 的前缀而放行）。
- `send_file` 的文件名会被压成 basename，`..\..\x`、`C:\Windows\x` 都只能落到 staging。
- 传入文件先校验 sha256 再落盘；校验失败什么都不留。
- 任务失败和超时**不会伪装成空成功**：分别回 `task-failed` / `task-timeout`。

## 安装

不需要 `npm install`。依赖直接从 DSH Desktop 自带的应用目录联接过来：

```powershell
$proj = "<本包路径>"
$app  = "D:\DEEPSEEKHARNESS\DSH Desktop\resources\app\node_modules"
New-Item -ItemType Directory -Force -Path "$proj\node_modules" | Out-Null
foreach ($p in '@modelcontextprotocol','zod','@hono') {
  New-Item -ItemType Junction -Path "$proj\node_modules\$p" -Target "$app\$p"
}
```

## 跑起来（B 机）

```powershell
$env:DSH_PEER_KEY       = "<32 字符以上的随机串>"
$env:DSH_PEER_ALLOWED_DIRS = "D:\repos;D:\work"   # 允许 ask 进入的目录，分号分隔
$env:DSH_PEER_HOST      = "0.0.0.0"               # 要让 A 机连才需要
$env:DSH_PEER_PORT      = "7331"
node .\src\bin.js
```

启动时会打印监听地址、允许目录、staging 目录和实际使用的任务命令 —— 先看这四行对不对。

### 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_PEER_KEY` | 无（**必填**） | 共享密钥，≥32 字符 |
| `DSH_PEER_HOST` | `127.0.0.1` | 监听地址 |
| `DSH_PEER_PORT` | `7331` | 监听端口，`0` 表示让系统分配 |
| `DSH_PEER_ALLOWED_DIRS` | 启动目录 | `ask` 可进入的目录，分号分隔 |
| `DSH_PEER_COMMAND` | `dsh --profile headless` | 任务命令模板，支持双引号包路径（`"C:\Program Files\...\dsh.cmd" --profile headless`） |
| `DSH_PEER_TIMEOUT_MS` | `600000` | 单任务上限 |
| `DSH_PEER_MAX_BYTES` | `5 MiB` | 单文件上限 |
| `DSH_HOME` | `~/.dsh` | staging 落在 `$DSH_HOME/dsh-peer/incoming` |
| `DSH_PEER_INSECURE` | 关 | `1` = 不要密钥。**只在 loopback 实验时用** |

## 接到 A 机的 DSH（连入侧）

在 A 机 profile 的 `cordis.patch.yml` 里加一条（和你现有 `insert` 写法一致）：

```yaml
- insert:
    - id: mcp-client-peerB
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: peerB
        url: 'http://<B机IP>:7331/mcp'
        headers:
          authorization: 'Bearer <同一个共享密钥>'
        toolCallTimeoutMs: 600000      # 必须 ≥ B 机的 DSH_PEER_TIMEOUT_MS
```

重启 profile 后，A 机的模型会看到 `mcp__peerB__ask`、`mcp__peerB__fetch_file`、
`mcp__peerB__send_file` 三个工具。

## Windows 上的任务入口（重要）

**不要**把 `DSH_PEER_COMMAND` 指向 `dsh.cmd`。原因不是洁癖，是两个真实的坑：

1. Node 出于 CVE-2024-27980 的修复，**拒绝在 `shell:false` 下启动 `.cmd`/`.bat`**（直接 `spawn EINVAL`）。
2. 改成经过 `cmd.exe` 又会把任务文本当成命令语法 —— 实测任务里含 `&`/`|` 会被拆成两条命令执行。

所以本包在 Windows 上会**自己发现真实可执行文件**：读 PATH 上 `dsh.cmd` 的内容 → 取出它引用的
`DSH Desktop.exe` → 找 `resources\app\lib\desktop-cli.js`（兼容打包成 `app.asar` 的安装）→
用 `ELECTRON_RUN_AS_NODE=1` 直接跑它。参数走真正的 argv，任务文本永远不进 shell。

启动时打印的 `task command` 会显示最终用了什么。默认就是这条；要手写就照这个形状：

```
DSH_PEER_COMMAND = "D:\...\DSH Desktop.exe" --expose-internals "D:\...\resources\app\lib\desktop-cli.js" --profile headless
```

手写这条时必须自己设 `ELECTRON_RUN_AS_NODE=1`（包里的自动发现会代你设）。

## 实测数据（本机 Windows / DSH Desktop 2.0.13）

**端到端真实跑通（2026-09-23，跨两个 DSH 实例）**：

| 项 | 实测 |
|---|---|
| 发码 → 配对 → 挂载 | ✅ `peer_pair` 返回 `mounted: true`；配对前 `mcp__PANDA__ask` 不存在，配对后出现 |
| 一次完整跨实例任务 | **10,328 ms**（`ask` 内含完整 agent 回合：列目录 + 算字节 + 推理 + 自校验） |
| 结果精确性 | ✅ 文件数 `3`、字节 `22/75/11` 全部匹配，对端还自行做了 22+75+11=108 的一致性校验 |
| `fetch_file` → `send_file` | ✅ SHA256 双向一致（`92cef647…d0295`），落盘内容逐字节相同 |
| 白名单负向测试 | ✅ 白名单外路径被拒（`path-not-allowed`），不是静默返回内容 |
| staging 边界 | ✅ 落在 `$DSH_HOME/dsh-peer/incoming/`，名称压成 basename，**调用方无法指定路径** |

**"冷启动"的构成**（用独立适配器直接测 `ask` 得到，排除网络与 UI）：

| 项 | 实测 |
|---|---|
| 一次简单问答 | **约 4.3 s**，第二次 3.8 s —— **固定开销，不随次数变快** |
| 跨调用记忆 | **无**：每次 `dsh --profile headless` 都是新进程新会话 |
| 超时行为 | 上限 8 s 时 8055 ms 杀掉并回 `task-timeout`；上限 10 s 时 10067 ms |
| 超时后子进程 | **无孤儿**（定向验证：杀前/杀后 node 模式进程数一致） |

结论：**每次 `ask` 付的是一次完整 agent 回合的代价**，适合"让另一台机器干活并拿结论"，
不适合高频细粒度往返。要消除这段固定开销就得走常驻会话（见下方限制 2）。

## 验证

```powershell
node --test test/            # 161 个测试，全部不需要联网、不调用模型
node .\verify-host-load.mjs  # 用真实 Cordis 上下文跑一遍 apply()，逐个报出四个工具
```

- `test/e2e.test.js`：起真实入口进程、真实 HTTP、真实 MCP 客户端、真实子进程
- `test/mount-contract.test.js`：用**真实 Cordis**验证挂载契约（不是替身）
- `test/plugin.test.js`：比对安装副本与源码，防止"测试全绿、宿主加载旧代码"

## 已知限制（都是有意为之的取舍）

1. **`dsh` 的路径随 Desktop 升级而变**。本机 PATH 上的 `dsh` 指向
   `...\host-commands\desktop\generations\<哈希>\bin\`（实测 3 个 generation）。
   本包每次启动都重新发现，所以升级后通常自动跟上；发现失败时启动阶段就会说明，
   不会等到 peer 调用才炸。
2. **每次 `ask` 都是冷启动，实测约 4 秒固定开销**（见上方实测表），
   且**没有跨调用的对话记忆**。要"会话常驻 + 多轮"应改走 `--profile sdk`
   （stdio JSON-RPC，但需自己实现客户端并处理会话生命周期），那是下一步而不是这一版。
3. **一个任务跑完才返回**：MCP 工具调用是同步等待，长任务会占住 A 机那一轮。
   上限由两边超时配置决定，取小者生效；超时会被杀且不留孤儿（已实测）。
4. **文件走 base64 + JSON**：体积会膨胀约 33%，所以默认上限 5 MiB。
   大文件请用别的通道（Git、共享盘、rsync）。
5. **staging 不是工作区**：收到的文件不会自动进入任何项目目录，需要 B 机自己搬。
   这是刻意的 —— 让"接收"和"放到哪里"分成两步，避免远端决定本地布局。
6. **只做了 `ask` / 文件通道**：没有"共享会话历史"、"互相看到对方的 todo"、
   "任务进度流式回传"这类能力。`ask` 是一次性问答，不是共同编辑。

## 安全提醒

`ask` 的语义是"让 A 机的模型在 B 机上执行任务"。因此：

- 只在你控制的网络里开 `DSH_PEER_HOST=0.0.0.0`；跨公网请先套 Tailscale/ZeroTier 之类的组网，或放在 HTTPS 反代后。
- 共享密钥等于 B 机的执行权限，别写进会同步的仓库或截图里。
- 目录白名单尽量窄；`DSH_PEER_ALLOWED_DIRS` 指的是"可进入"，不是"可写" ——
  `ask` 跑起来的 DSH 是否可写取决于那台机器自己的权限配置（本机当前是 `danger-full-access`，请自行收紧）。
