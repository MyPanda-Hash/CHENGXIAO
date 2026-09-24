# dsh-peer-mcp

**让两台电脑上的 DSH 互相干活、互相传文件 —— 而各自的文件始终留在本机。**

不再用截图 + 模拟键盘去驱动另一台机器。装好这个插件后，A 机的 agent 可以把 B 机当成
工具来调：B 机用**自己本地的文件、工具和模型**执行任务，只把结论和文件回传。

```
┌─ A 机 ─────────────────────┐          ┌─ B 机 ──────────────────────┐
│ DSH                        │          │ 文件/仓库都在本地，不搬家    │
│  └ MCP 客户端 ─────────────┼── HTTPS ─┼─▶ dsh-peer-mcp              │
│     mcp__<对端名>__ask      │  凭据    │     ├ ask        → 本地 DSH  │
│     mcp__<对端名>__fetch_file│         │     ├ fetch_file → 读本地    │
│     mcp__<对端名>__send_file │         │     └ send_file  → 收文件    │
└────────────────────────────┘          └─────────────────────────────┘
```

## 安装

```sh
dsh plugin --profile <你的 profile> add github:MyPanda-Hash/CHENGXIAO
```

这一条命令就够了：它会把插件装进 profile 的 `node_modules/`，**并自动注册到
`dsh.profile.bundles`**（你可以打开 profile 的 `package.json` 确认）。

装完后**安装本身不会对外暴露任何东西** —— 插件自带的 `cordis.patch.yml` 里 `listen` 默认是
`false`，必须由操作者显式开启。

## 快速开始（同一局域网）

两台机器在**同一个局域网**时，不需要 Tailscale、不需要改路由器、不需要碰防火墙：

1. 在干活端 `设置 → 设备互联`，把 `listen` 配成 `true` 并重启 DSH（见下节）。
2. 干活端在页面里确认「共享工作区」目录（默认是用户目录下的 `DSH Workspace`），
   并核对对端权限摘要（读取/写入工作区、执行任务、传输文件；系统命令和工作区外访问默认禁止）。
3. 点「生成配对码」，把显示的**短码**或**完整链接**交给发起端。
4. 发起端在同一个页面粘贴链接，点「配对」。
5. 成功后发起端多出 `mcp__<干活端机器名>__ask` / `__fetch_file` / `__send_file` 工具。

配对码一次性、15 分钟有效；同一账号的两台设备**也不自动互信**，首次连接必须在干活端人工确认。

> 跨网络的机器（不在同一局域网）可以用下方的**中继模式**，或继续用 Tailscale / 端口映射。

## 跨网络：中继模式（自托管）

两台机器**不在同一局域网**、又不想装 Tailscale 时，用中继：双方都**主动出站**连接同一台
中继服务器，不需要任何入站端口、端口映射或防火墙配置。中继只转发**端到端加密**的信封，
看不到配对码、凭据、任务内容或文件明文，也不落盘。

1. 在任一台有公网可达的机器上跑中继（自托管）：

   ```sh
   DSH_RELAY_HOST=0.0.0.0 DSH_RELAY_PORT=7332 node src/relay-server-bin.js
   ```

   生产环境建议放到反向代理（TLS）后面。

2. 两台机器的 profile 覆盖层里启用中继（改完重启 DSH）：

   ```yaml
   - id: dsh-peer-mcp
     config:
       relayEnabled: true
       relayUrl: 'https://relay.example.com'   # 或 http://<中继地址>:7332
       allowedDirs:
         - 'C:\Users\你的用户名\DSH Workspace'
   ```

3. 干活端「生成配对码」，链接形如 `dshr://relay.example.com/<设备ID>/XXXXX-XXXXX`，
   发起端照常粘贴配对。配对后的工具调用自动经中继转发，模型与使用方式完全不变。

加密方式：配对时双方做一次性 X25519 密钥交换，配对应答（含长期凭据）与后续所有消息
都用派生的会话密钥做 AES-256-GCM 加密；中继转发的永远是密文，配对码本身不经过中继。
直连和中继可以共存：同一台机器开监听时局域网内仍走直连。

运维：中继提供 `GET /health`（返回 ok、运行秒数、注册设备数，无任何身份信息）；
`DSH_RELAY_OFFLINE_TTL_MS` 可选开启**内存**离线驻留（设备未注册时信封暂存至其上线，
上限 24 小时，默认 0=关闭，即发送给缺席设备仍是明确的 404）。无数据库模式是唯一模式
——协议里所有流程都是双方在线的请求/响应，持久化存储（PostgreSQL 之类）待出现多实例
需求再议。Docker 部署见 `Dockerfile` / `docker-compose.relay.yml` 与 DEPLOY 文档。

### 配置

配置写在 **profile 的 patch 层**（`~/.dsh/profiles/<profile>/cordis.patch.yml`），
**不要改插件包里的文件** —— 那个文件属于插件，升级时会被覆盖。加一条 id 定向覆盖即可：

```yaml
- id: dsh-peer-mcp
  config:
    listen: true                                  # 本机对外监听，对端才能配对
    host: 0.0.0.0
    port: 7331
    allowedDirs:                                  # 对端被允许进入的绝对目录
      - 'C:\Users\你的用户名\DSH Workspace'
    taskTimeoutMs: 600000
```

`listen: true` 时 `allowedDirs` **必须至少给一个绝对目录** —— schema 会拒绝一个
"没边界的监听口"。改完重启 DSH 生效。

不配 `allowedDirs` 时使用**默认共享工作区** `%USERPROFILE%\DSH Workspace`
（POSIX 为 `$HOME/DSH Workspace`），不会把整个用户目录放进白名单。设置页里保存的
共享工作区立即生效并自动迁移旧配置，不需要重启。

## 配对（一次性码）

**两种方式，任选其一。**

### 用设置页（推荐）

**设置 → 设备互联**，一个页面做完三件事：

| 区域 | 能做什么 |
|---|---|
| 本机监听 | 看是否在监听、监听地址、待用配对码的到期时间（**只读** —— 开关属配置，改 profile 后重启生效） |
| 共享工作区 | 查看/修改对端可访问的目录（默认 `DSH Workspace`），并核对能力型权限摘要 |
| 发配对码 | 选权限档位 → 生成 → 大号等宽字体显示**短码**，可选中可复制，附完整 `dshp://` 链接 |
| 连接另一台机器 | 粘贴对方给的链接 → 配对；配对成功后列出「本机可调用的对端」 |
| 被允许驱动本机的机器 | 列出每台对端及其权限档位，一键**撤销** |

配对码既可以整段 `dshp://…` 链接转交，也可以只把短码（`XXXXX-XXXXX` 部分）读给操作者，
由操作者在发起端粘贴完整链接时补上（或直接转交整段链接）。短码是同一配对码的
可读形式，不产生第二个秘密；发起端真正需要的是包含地址的完整链接。

这个页面存在的原因是：把一次性码通过模型转述给人既绕又慢。它调的是插件自己的 routes
（`/plugins/dsh-peer-mcp/*`），**只服务 loopback**，且状态读取**永不返回码或凭据**。

### 用 agent 工具

1. 在 B 机让 agent 调 `peer_ticket`，或直接跑一次工具，拿到形如
   `dshp://10.60.31.127:7331/C7K2M-9QWMP` 的链接。
2. 在 A 机让 agent 调 `peer_pair`，把链接贴进去。
3. 成功后 A 机多出 `mcp__<B机名>__ask` 等工具，立即可用（无需重启）。

配对码**一次性、默认 15 分钟有效**、消费即废。它只是一次握手的通行证；握手后换发
长期凭据，磁盘上**只存它的 sha256**。

## agent 能做什么，不能做什么

| 工具 | 作用 |
|---|---|
| `peer_status` | 报告监听状态、对端地址、待配对码到期时间、双向机器列表、共享工作区和能力权限（**不含任何秘密**） |
| `peer_ticket` | 申请一次性配对码转交给人；监听未开时**拒绝**并说明要人去开启 |
| `peer_pair` | 贴入 `dshp://` 链接完成配对 |
| `peer_revoke` | 撤销某个对端的访问权（立即生效，记录留存可审计） |

**四个工具里没有任何一个能打开监听口或放宽权限。** 是否对外暴露只能改配置 ——
这一条有测试盯着（加个叫 `peer_listen` 的工具就会红）。

对端侧（被驱动的机器）提供十五个工具：同步兼容入口 `ask`、异步任务 `submit_task` /
`task_status` / `task_events` / `task_result` / `cancel_task`、整文件 `fetch_file` / `send_file`，
以及分片传输 `open_read` / `read_chunk` / `close_read` / `send_begin` / `send_chunk` /
`send_finish` / `send_cancel`。

## 异步任务

长任务推荐走异步流程：提交立即返回 `taskId`，不占住调用方当前回合：

```text
submit_task(prompt, cwd?, timeoutMs?, idempotencyKey?) → { taskId, status }
  ├─ task_status(taskId)           → queued | running | completed | failed | cancelled | expired
  ├─ task_events(taskId, cursor?)  → 生命周期事件 + nextCursor（增量读取）
  ├─ task_result(taskId)           → 终态结果（与 ask 同形状）；运行中返回 task-not-terminal
  └─ cancel_task(taskId)           → 取消排队中（跳过不执行）或运行中（击杀进程）的任务
```

要点：

- **状态在执行任务的设备上**：调用方断线重连后凭 `taskId` 继续查询；中继转发请求但不持有任务状态。
- **幂等**：同一 `idempotencyKey` 重复提交返回同一任务，网络重试不会重复执行。
- **保留期**：终态结果默认保留 24 小时，之后标记 `expired` 并释放结果内容。
- **并发**：每台 worker 默认同时运行 1 个任务（一个完整 agent 回合），后续排队。
- **兼容**：`ask` 保留原形状与超时语义——内部提交异步任务、等待终态、返回原有结果；旧调用方零迁移。

事件是生命周期事件（`submitted` / `started` / `completed` / `failed` / `cancelled` / `expired`），
不伪造百分比进度。

## 分片文件传输

`fetch_file` / `send_file`（整文件、≤5 MiB）保留不变；更大的文件走分片通道：

- **worker 侧工具**：`open_read` 打开一个读会话（返回大小、整文件 SHA-256、块几何），
  `read_chunk` 任意顺序、可重复读（这就是断点续传），`close_read` 释放；
  `send_begin` / `send_chunk` / `send_finish` / `send_cancel` 组装对端文件——
  每块带摘要校验、按块序号幂等（重发不重写）、整文件校验通过后**原子**落进 staging，
  绝不覆盖同名文件。会话按对端隔离，空闲 10 分钟自动回收；单文件上限 100 MiB；默认块 1 MiB。
- **程序化驱动**（推荐，模型不适合逐块搬运）：发起端 service 提供
  `fetchPeerFile(name, remotePath, localPath)` 与 `sendPeerFile(name, localPath)`，
  内部经对端 MCP 端点（直连地址或中继回环代理，配对时选了哪条路就走哪条）驱动分片循环，
  逐块校验、链路抖动自动重试（每块 3 次）、本地同样临时文件 + 原子落盘不覆盖。
- **直连优先**：连接选择沿用既有行为——有直连用直连，中继兜底；两条路径的传输语义完全一致。

```js
// 发起端示例（service 上）：
const landed = await service.fetchPeerFile('desk', 'D:\\shared\\dataset.bin', 'C:\\local\\copy.bin', {
  onProgress: ({ received, totalChunks }) => console.log(`${received}/${totalChunks}`),
});
```

## 安全模型

| 概念 | 含义 |
|---|---|
| 配对码 | 一次性、短时，只用于一次握手。泄露也只值一次配对 |
| 对端凭据 | 长期密钥，**磁盘只存 sha256**，明文仅在配对那一刻返回一次 |
| 信任表 | `$DSH_HOME/dsh-peer/trust.json`：对端身份、公钥、权限档位、撤销时间 |
| 目录白名单 | 对端的 `ask` / `fetch_file` 只能进入配置的绝对目录，按路径分量比较；未配置时默认是用户目录下的 `DSH Workspace` |
| 权限档位 | 每个对端一个 `workspace-write`（默认）或 `danger-full-access`，**由发码方授予，对端不能自选** |
| 能力权限 | 设置页展示的能力摘要：读取/写入工作区、执行任务、传输文件默认允许；系统命令、工作区外访问、修改 DSH 配置默认禁止 |

**关于"提权"**：插件**不能**改变权限级别 —— 它运行在 DSH 进程内。可配置的是
**每个对端的权限档位**，语义是"允许对端在你机器的什么范围内干活"。

`send_file` 收到的文件落在 `$DSH_HOME/dsh-peer/incoming/`，名称压成 basename，
**调用方无法指定落点、不会覆盖同名文件**，且写入前校验 sha256。

## 实测数据

### 直连基线（2026-09-23）

在一台 Windows 机器上用两个 DSH 实例实跑（局域网直连路径）：

| 项 | 实测 |
|---|---|
| 发码 → 配对 → 挂载 | `mounted: true`；配对前工具不存在，配对后立即可用 |
| 一次完整跨实例任务 | **10,328 ms**（含完整 agent 回合：枚举目录 + 算字节 + 推理 + 自校验） |
| 结果精确性 | 文件数 3、字节 22/75/11 全部匹配 |
| `fetch_file` → `send_file` | SHA256 双向一致，落盘逐字节相同 |
| 白名单负向测试 | 白名单外路径被拒（`path-not-allowed`），不是静默返回 |

### 全链路（中继 + 异步任务 + 分片传输，2026-09-24）

同一台 Windows 机器上的**两个完全隔离 service 实例**（独立身份与信任库）经
**Docker 容器中继**（仓库镜像，独立网络命名空间）跑通全部新链路。执行器为真实
子进程、固定 8 秒应答（与真实 agent 回合同量级），以剥离模型推理的随机性、
单独度量协议栈开销；全部数值为真实墙钟时间，字节一致性校验通过：

| 环节 | 耗时 | 备注 |
|---|---|---|
| service 启动 + 中继注册 | 71 / 11 ms | 双端各一次出站注册 |
| 生成 `dshr` 配对码 | 3 ms | |
| **经中继配对**（X25519 握手 + 密封应答） | **108 ms** | 中继全程只见密文 |
| `ask`（同步兼容入口） | 8,192 ms | 8s 任务本体 + **约 190 ms 全链路往返开销** |
| `submit_task`（异步提交） | **59 ms** | 立即返回，调用方回合不被占用 |
| `submit_task` → 轮询至结果就绪 | 8,343 ms | 任务本体占绝对大头 |
| `cancel_task`（击杀运行中子进程） | 60 ms | |
| `fetchPeerFile`（12 MiB 分片拉取） | 1,844 ms | **6.5 MiB/s**，12 块 |
| `sendPeerFile`（12 MiB 分片推送） | 1,919 ms | **6.3 MiB/s** |
| `fetch_file`（4 MiB 整文件，对照） | 400 ms | 旧通道走同一中继路径 |

> 环境与复现：win32 10.0.26340、node v20.19.5、中继 = `dsh-peer-relay` 容器。
> 本表为**同机双实例 + 容器化中继**的协议开销度量（网络跳为本机容器 NAT，不含真实
> 广域网往返）；跨真机/VPS 复现用同一脚本：
>
> ```sh
> docker compose -f docker-compose.relay.yml up -d   # 在 VPS 上
> node scripts/measure-full-chain.mjs --relay http://<VPS>:7332 --mib 12
> ```

**关于延迟**：`ask` 付的是一次完整 agent 回合的代价（独立适配器直测简单问答约 4.3 s，
第二次 3.8 s —— 固定开销，不随次数变快）。适合"让另一台机器干活并拿结论"，
不适合高频细粒度往返；长任务用 `submit_task` 异步提交（约 60 ms 返回），大文件走
分片通道（实测 6 MiB/s 量级，经中继端到端加密）。

## 限制

1. **每次 `ask` 都是冷启动**，且**无跨调用记忆**（每次 `dsh --profile headless` 都是新会话）。
   要常驻会话需改走 `--profile sdk`，尚未实现。
2. **同步入口 `ask` 仍会等到任务完成**：长任务要避免占住回合请用 `submit_task` 异步流程
   （提交立即返回 `taskId`，凭它查状态/事件/结果、随时取消）；两个入口跑的是同一套任务机制。
3. **文件走 base64 + JSON**：整文件工具默认上限 5 MiB；更大的文件用分片通道
   （见「分片文件传输」，单文件上限 100 MiB，逐块校验、断点续传）。
4. **局域网直连或自托管中继**：直连跨 NAT 不通，需部署中继（见「跨网络：中继模式」）或组网。
5. **Windows 上 `dsh` 是 `.cmd` 外壳**，Node 拒绝直接 spawn。插件会自动解析成真实可执行文件；
   若解析失败，启动日志会明确说明，`ask` 也会给出可行动的报错而不是 `ENOENT`。

## 验证

```sh
node --test test/                    # 259 个测试，不联网、不调用模型
node scripts/verify-host-load.mjs    # 用真实 Cordis 上下文跑一遍 apply()
node scripts/verify-host-load.mjs --profile desktop   # 验证已安装副本
node scripts/prepare-release.mjs     # 产出干净发布树（并断言没有 node_modules）
```

- `test/mount-contract.test.js` 用**真实 Cordis** 验证挂载契约，不是替身
- `test/plugin.test.js` 比对已安装副本与源码，防止"测试全绿、宿主加载旧代码"

## 独立适配器（可选）

不起 DSH 也能把一台机器变成"干活端"：

```powershell
.\start-peer.ps1 -AllowedDirs "D:\repos" -Host 0.0.0.0
```

或用环境变量直接跑 `node src/bin.js`（见 `src/config.js` 的配置项表）。

## License

MIT
