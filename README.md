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

装完后在 profile 的 `cordis.patch.yml` 里加一行（本仓库的 `cordis.patch.yml` 有逐项注释）：

```yaml
- insert:
    - id: dsh-peer-mcp
      name: 'dsh-peer-mcp'
      config:
        listen: true                                  # 本机对外监听，对端才能配对
        host: 0.0.0.0
        port: 7331
        allowedDirs:                                  # 对端被允许进入的绝对目录
          - 'C:\work'
        taskTimeoutMs: 600000
```

重启 DSH 生效。**安装本身不会对外暴露任何东西** —— `listen` 默认是 `false`，
必须由操作者显式开启。

## 配对（一次性码）

1. 在 B 机让 agent 调 `peer_ticket`，或直接跑一次工具，拿到形如
   `dshp://10.60.31.127:7331/C7K2M-9QWMP` 的链接。
2. 在 A 机让 agent 调 `peer_pair`，把链接贴进去。
3. 成功后 A 机多出 `mcp__<B机名>__ask` 等工具，立即可用（无需重启）。

配对码**一次性、默认 15 分钟有效**、消费即废。它只是一次握手的通行证；握手后换发
长期凭据，磁盘上**只存它的 sha256**。

## agent 能做什么，不能做什么

| 工具 | 作用 |
|---|---|
| `peer_status` | 报告监听状态、对端地址、待配对码到期时间、双向机器列表（**不含任何秘密**） |
| `peer_ticket` | 申请一次性配对码转交给人；监听未开时**拒绝**并说明要人去开启 |
| `peer_pair` | 贴入 `dshp://` 链接完成配对 |
| `peer_revoke` | 撤销某个对端的访问权（立即生效，记录留存可审计） |

**四个工具里没有任何一个能打开监听口或放宽权限。** 是否对外暴露只能改配置 ——
这一条有测试盯着（加个叫 `peer_listen` 的工具就会红）。

对端侧另有三条受策略约束的工具：`ask`（跑一个任务）、`fetch_file`、`send_file`。

## 安全模型

| 概念 | 含义 |
|---|---|
| 配对码 | 一次性、短时，只用于一次握手。泄露也只值一次配对 |
| 对端凭据 | 长期密钥，**磁盘只存 sha256**，明文仅在配对那一刻返回一次 |
| 信任表 | `$DSH_HOME/dsh-peer/trust.json`：对端身份、公钥、权限档位、撤销时间 |
| 目录白名单 | 对端的 `ask` / `fetch_file` 只能进入配置的绝对目录，按路径分量比较 |
| 权限档位 | 每个对端一个 `workspace-write`（默认）或 `danger-full-access`，**由发码方授予，对端不能自选** |

**关于"提权"**：插件**不能**改变权限级别 —— 它运行在 DSH 进程内。可配置的是
**每个对端的权限档位**，语义是"允许对端在你机器的什么范围内干活"。

`send_file` 收到的文件落在 `$DSH_HOME/dsh-peer/incoming/`，名称压成 basename，
**调用方无法指定落点、不会覆盖同名文件**，且写入前校验 sha256。

## 实测数据

在一台 Windows 机器上用两个 DSH 实例实跑（2026-09-23）：

| 项 | 实测 |
|---|---|
| 发码 → 配对 → 挂载 | `mounted: true`；配对前工具不存在，配对后立即可用 |
| 一次完整跨实例任务 | **10,328 ms**（含完整 agent 回合：枚举目录 + 算字节 + 推理 + 自校验） |
| 结果精确性 | 文件数 3、字节 22/75/11 全部匹配 |
| `fetch_file` → `send_file` | SHA256 双向一致，落盘逐字节相同 |
| 白名单负向测试 | 白名单外路径被拒（`path-not-allowed`），不是静默返回 |

**关于延迟**：`ask` 付的是一次完整 agent 回合的代价（独立适配器直测简单问答约 4.3 s，
第二次 3.8 s —— 固定开销，不随次数变快）。适合"让另一台机器干活并拿结论"，
不适合高频细粒度往返。

## 限制

1. **每次 `ask` 都是冷启动**，且**无跨调用记忆**（每次 `dsh --profile headless` 都是新会话）。
   要常驻会话需改走 `--profile sdk`，尚未实现。
2. **一个任务跑完才返回**：MCP 工具调用是同步等待，长任务会占住调用方那一轮。
   超时会被杀掉且不留孤儿进程（已实测）。
3. **文件走 base64 + JSON**，体积膨胀约 33%，默认上限 5 MiB。大文件请用 Git / 共享盘。
4. **局域网直连**：跨 NAT 不通，需要中继或组网（Tailscale 之类），本版不做。
5. **Windows 上 `dsh` 是 `.cmd` 外壳**，Node 拒绝直接 spawn。插件会自动解析成真实可执行文件；
   若解析失败，启动日志会明确说明，`ask` 也会给出可行动的报错而不是 `ENOENT`。

## 验证

```sh
node --test test/                    # 162 个测试，不联网、不调用模型
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
