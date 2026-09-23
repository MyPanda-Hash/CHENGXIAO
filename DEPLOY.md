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
