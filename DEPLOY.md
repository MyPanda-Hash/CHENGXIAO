# 部署到其他机器（测试用）

目标：**空闲的电脑当"干活端"**，你的主力机当发起端。干活端对外监听、发配对码；
主力机贴码配对，之后就能用 `mcp__<机器名>__ask` 驱动它。

## 每台机器需要什么

| 要求 | 说明 |
|---|---|
| **DSH Desktop** | 插件跑在 DSH 进程里，干活端也需要装它（不是只装 node） |
| Node ≥ 20.19 | DSH 自带运行时即可 |
| 能访问 `codeload.github.com` | 装插件时 pnpm 从这里下载（**不需要 git CLI** —— pnpm 不用 `git clone`） |
| 同一局域网 | 跨 NAT 不通，本版不做中继 |

## 一、装插件

> ⚠️ **先确认那台机器在跑哪个 profile。** 下面的命令默认 `desktop`。
> 若那台机器用的是 **web 端**，把每一处的 `desktop` 换成 `web`；用 headless 就换 `headless`。
> 装错 profile 的表现是"照着做完了、完全没反应"——插件不会被加载，也不会报错。
> 详见第五节"装错 profile"。

把 `install-peer.ps1` 拷到目标机器，用**管理员或普通 PowerShell 均可**：

```powershell
.\install-peer.ps1 -AllowedDirs "D:\repos","C:\work"
```

先看不改：

```powershell
.\install-peer.ps1 -AllowedDirs "D:\repos" -WhatIf
```

它做三件事，且**可重复运行**（第二次是 no-op）：

1. `dsh plugin --profile desktop add github:MyPanda-Hash/CHENGXIAO`
   （自动注册 bundle；实测 2.5–3.8 秒）
2. 往 profile 的 `cordis.patch.yml` 写一条**覆盖层**，开启监听并设置目录白名单。
   全新 profile 的这个文件内容是占位空数组 `[]`，脚本会**替换**它而不是追加 ——
   直接追在 `[]` 后面会产出非法 YAML、让整个 profile 加载失败。
3. 复查：插件文件齐全（含设置页要的 `client.js`）、无多余 `node_modules`、bundle 已注册

### 如果那台机器连不上 GitHub

pnpm 装 `github:` 源要访问 `codeload.github.com`。若被阻断，两条出路：

- **配代理**（如果那台机器有）：`set HTTPS_PROXY=http://127.0.0.1:<port>` 后再跑脚本
- **离线复制**：把本机 `C:\Users\x1787\MY PAPER\dsh-peer-mcp\dist\release\` 整个目录拷过去，
  放到 `<目标机>\.dsh\profiles\desktop\node_modules\dsh-peer-mcp\`，然后在 profile 的
  `package.json` 里手动加两处：

  ```json
  "dependencies": { "dsh-peer-mcp": "file:./node_modules/dsh-peer-mcp" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-peer-mcp", "..."] } }
  ```

  ⚠️ release **目录**可用；release 的 **tarball URL 不行** —— pnpm 11 会以
  `ERR_PNPM_MISSING_TARBALL_INTEGRITY` 拒绝（lockfile 里没有 integrity 字段可校验）。
  这是实测结论，不是猜测。

## 二、重启并确认

重启 DSH。**首次监听若弹出防火墙授权框，选"允许"（专用网络）。**

重启后在目标机看日志 `%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`，
应当出现这两行：

```
[dsh-peer-mcp] task command: <解析出的真实可执行文件路径> --expose-internals ... --profile headless
[dsh-peer-mcp] settings routes ready under /plugins/dsh-peer-mcp
```

第二行出现 = 设置页已就绪。第一行**必须**指向真实 exe：Windows 上 `dsh` 是 `.cmd`
外壳，Node 拒绝直接启动，插件会自动解析成真实可执行文件（`task-command.js`）。
若这行报错或缺失，在 profile 的 `cordis.patch.yml` 里给 `dsh-peer-mcp` 的 `config` 补：

```yaml
    command: ["C:\\Path\\to\\DSH Desktop.exe", "--expose-internals", "C:\\Path\\to\\resources\\app\\lib\\desktop-cli.js", "--profile", "headless"]
```

## 三、配对

1. **干活端**：`设置 → 设备互联` → 选权限档位 → **生成配对码** → 复制那段 `dshp://…` 链接
2. **主力机**：同一个页面 → 粘贴链接 → **配对**
3. 成功后主力机的工具列表里出现 `mcp__<干活端机器名>__ask` / `__fetch_file` / `__send_file`

配对码**一次性、15 分钟有效**、用完即废。要换权限档位需重新发码。

## 四、验证它真的在干活

在主力机让 agent 调：

```
mcp__<机器名>__ask  prompt="列出当前工作目录下所有文件及大小，并给出文件总数"  cwd="<该机白名单内的目录>"
```

期望：`exitCode: 0`、答案与真实文件一致。实测参考：本机自测一次完整任务约 **10.3 秒**
（含完整 agent 回合：列目录 + 算大小 + 推理），简单问答约 4 秒。

## 安全边界（务必知道）

- **`ask` 等于把该机器的执行权交给你这台机器的模型**，范围受 `allowedDirs` 限制，
  但一旦进入白名单目录，里面的读写由那台机器自己的 DSH 权限决定
- 默认权限档位是 `workspace-write`；`danger-full-access` 要发码方显式选
- 撤销：设置页里点"撤销"，凭据立即失效（记录留存可审计）
- 不用的机器把配置里 `listen` 改回 `false` 并重启即可关闭监听

## 已知限制

| 限制 | 说明 |
|---|---|
| 每次 `ask` 无记忆 | 每次都是新进程新会话，付一次完整 agent 回合的代价 |
| 局域网直连 | 跨 NAT 不通 |
| 文件走 base64+JSON | 默认上限 5 MiB，大文件请用 Git/共享盘 |
| 设置页需重启才出现 | 客户端是启动期加载的 |

## 五、连不上对端时怎么查

配对报 `worker-unreachable`（连不上）或 `pairing-timeout`（一直没回应）时，
**先记住一件事：在 Windows 上，"没有人在监听" 和 "防火墙把包丢了" 从外面看完全一样
——都不是拒绝，而是一片沉默。** 所以凭现象分不出原因，必须到那台机器上查。

从发起端能确定的只有"那台机器是否还活着"：

```powershell
Get-NetNeighbor -IPAddress 192.168.0.235 | Select-Object IPAddress, LinkLayerAddress, State
```

`State = Reachable` 说明机器开着机、在同一个网段（二层通）。**但端口通不通它证明不了。**

剩下的必须到那台机器上跑桌面上的 `诊断配对问题.ps1`。三种常见原因：

| 现象（在那台机器上） | 原因 | 处理 |
|---|---|---|
| 没有 DSH 进程 | DSH 没启动 | 先启动 DSH |
| 有 DSH，但 7331 没在监听 | 插件没装/没启用，或 `listen` 还是 `false` | 见本文第一节、第二节；改完**必须重启** DSH |
| 只绑在 `127.0.0.1` | `host` 写成了回环地址 | 本机连自己是通的，所以极易误判成"我这边没问题"。改成 `0.0.0.0` 再重启 |
| 在监听，但对端仍连不上 | 防火墙 | 见下 |

### 装错 profile（用 web 端 / headless 端时最常踩）

DSH 每个 profile 有**各自独立**的 `node_modules` 和 `cordis.patch.yml`：

```
~/.dsh/profiles/desktop/    ← DSH Desktop 用这个
~/.dsh/profiles/web/        ← web 端用这个
~/.dsh/profiles/headless/   ← ask 派生的子任务用这个
```

**跑哪个 profile，就得往哪个 profile 装。** 用 web 端跑却把插件装在 `desktop`，
插件根本不会被加载，自然也不会监听——但 `dsh plugin add` 不会提醒你这件事。

判断当前在跑哪个：看 `~/.dsh/profiles/*/cordis.patch.yml` 里哪个提到了 `dsh-peer-mcp`，
再和进程实际用的 profile 对上。

日志里最直接的证据（`诊断配对问题.ps1` 第 6 步会自动找）：

```
[dsh-peer-mcp] peer service ready (listening=true)     ← 插件加载了，且在监听
```

这行**完全没有** = 插件没加载（大概率装错 profile 了）。

### 链接里的地址在你这边根本不存在

先做这个判断，它一眼就能把问题分成两类：

```powershell
# 在「发起端」执行，把地址换成对端的地址
Get-NetNeighbor -IPAddress 192.168.0.2 | Select-Object IPAddress, LinkLayerAddress, State
```

| State | 含义 |
|---|---|
| `Reachable` | **刚被确认过**，同网段。问题在端口（看防火墙那节） |
| `Stale` | ⚠️ **没被近期确认过**，可能只是旧缓存，**不能当作"对方在"的证据** |
| `Incomplete` / `Unreachable`，MAC 是 `00-00-00-00-00-00` | **同网段里没有这台机器**。连 ARP 都没人应答，端口更不可能通 |

> **`Probe` / `Delay` 不是结论**，是"Windows 还在问"。刚发完包就读状态，常常正好读到
> `Probe`，此时下结论会把一台**明明在同一个局域网**的机器误判成不在。
> 必须轮询到它落到 `Reachable`（有真实 MAC）或 `Incomplete`/`Unreachable` 再判断——
> 这个坑是实测踩出来的。桌面上的 `是否同一局域网.ps1` 已经按这个逻辑写好。
>
> **MAC 本身也要看**。实测遇到过 `FE-FF-FF-FF-FF-FF`：它不是任何一台机器网卡的地址，
> 却带着 `Stale` 状态出现在表里。只看"有 MAC 就算在"会把跨网段的机器误判成同网段。

第二种情况**不是防火墙问题**，而是这三者之一：

1. **两台机器不在同一个网络**。两个不同的路由器都可以用 `192.168.x.x`，
   地址长得像不代表在同一个局域网。
2. **无线 AP 隔离（client isolation）**。同一个 Wi-Fi、同一个网段，但路由器禁止
   客户端之间互相通信 —— 现象和「不在同一网络」一模一样。
3. **插件广播了一个错误的地址**（虚拟网卡）。`chooseAdvertisedAddress` 会尽量跳过
   WSL / VMware / Hyper-V / vEthernet 这类网卡，但名字不在名单里的虚拟网卡
   （某些 VPN、网卡厂商工具）仍可能被选中，于是配对码里写的是一个对端永远连不上的地址。

**一次就能分清的办法** —— 在对端机器上反向测发起端（发起端是确定在监听的）：

```powershell
Test-NetConnection 192.168.0.238 -Port 7331
```

- 通 → 两台机器能互通，那就是**第 3 种**：链接里的地址不是它的局域网地址。
  在该机器的 profile 配置里锁定真实地址，然后重启 DSH：

  ```yaml
        addresses:
          - '192.168.0.15'   # 换成那台机器真正的局域网 IPv4（用第 1 步查）
  ```

- 不通 → **第 1 或第 2 种**：先把两台机器接到同一个网络；若是同一个 Wi-Fi，
  就去路由器关掉「AP 隔离 / 客户端隔离」，或改用同一台路由器的有线口。

### 防火墙的两个坑

1. **网络类别是"公用"（Public）**。Windows 弹授权框时点"允许"，生成的规则默认只覆盖
   若干配置文件；若当前 Wi-Fi 被判为"公用"，而规则只对"专用"生效，就照样丢包。
   查：`Get-NetConnectionProfile | Select-Object Name, NetworkCategory`
   改：`Set-NetConnectionProfile -InterfaceAlias "WLAN" -NetworkCategory Private`（需管理员）
2. **规则是按程序放的，不是按端口**。授权框点"允许"生成的是 `DSH Desktop` 这条
   程序规则，**不带端口号**。所以查防火墙时要看程序规则，只按端口 7331 查会漏报，
   得出"没放行"的错误结论。

验证一条规则是否真的覆盖当前网络：

```powershell
Get-NetFirewallRule -DisplayName 'DSH Desktop' |
  Select-Object DisplayName, Enabled, Direction, Action, Profile
```

`Profile` 必须包含当前网络类别（例如网络是 Public，规则也含 Public）。
