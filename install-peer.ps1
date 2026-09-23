<#
把 dsh-peer-mcp 装到一台**干活端**机器上，并写好配置。

干活的机器（"服务器"角色）要对外监听，好让发起端连进来配对。

用法：
  .\install-peer.ps1 -AllowedDirs "D:\repos","C:\work"

  # 先看会改什么、不落盘：
  .\install-peer.ps1 -AllowedDirs "D:\repos" -WhatIf

  # 换个 profile：
  .\install-peer.ps1 -Profile web -AllowedDirs "D:\repos"

它做三件事，每件都只做一次、可重复执行：
  1. 用 `dsh plugin add` 从发布 tarball 装插件（自动注册 bundle，可离线复制 tgz 后改路径）
  2. 往 profile 的 cordis.patch.yml 写一条 id 定向覆盖，开启监听并设置目录白名单
     （覆盖层，不是 insert —— bundle 已经注册过，再 insert 会出现两行同一个插件）
  3. 复查插件文件与 client.js 是否就位

**不会**碰你的 profile 里其它任何条目。
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string[]]$AllowedDirs,
  [string]$Profile = 'desktop',
  [int]$Port = 7331,
  # github: 是实测可用的源。release tarball URL 会被 pnpm 拒（ERR_PNPM_MISSING_TARBALL_INTEGRITY）。
  [string]$PluginSource = 'github:MyPanda-Hash/CHENGXIAO',
  [string]$PluginSpec = 'dsh-peer-mcp'
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "   !!  $text" -ForegroundColor Yellow }

# ── 前置检查 ────────────────────────────────────────────────────────────────
Write-Step '检查前提'

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  throw 'PATH 上找不到 dsh。请先装好 DSH Desktop（或把它的 dsh 加进 PATH），再运行本脚本。'
}
Write-Ok "dsh: $($dsh.Source)"

$homeDsh = Join-Path $env:USERPROFILE '.dsh'
$profileDir = Join-Path $homeDsh "profiles\$Profile"
if (-not (Test-Path $profileDir)) {
  throw "profile '$Profile' 不存在：$profileDir"
}
Write-Ok "profile: $profileDir"

if (-not $AllowedDirs -or $AllowedDirs.Count -eq 0) {
  throw '必须用 -AllowedDirs 指定至少一个绝对目录：对端只被允许在这些目录里干活。'
}
foreach ($dir in $AllowedDirs) {
  if (-not [System.IO.Path]::IsPathRooted($dir)) { throw "AllowedDirs 必须是绝对路径，收到：$dir" }
  if (-not (Test-Path $dir)) { Write-Warn2 "目录当前不存在（配置仍会写入）：$dir" }
}
Write-Ok "允许目录：$($AllowedDirs -join '; ')"

# ── 1. 装插件 ──────────────────────────────────────────────────────────────
Write-Step "装插件到 profile '$Profile'"

if (Test-Path (Join-Path $profileDir 'node_modules\dsh-peer-mcp')) {
  Write-Ok '插件已存在，跳过安装（要升级请手动运行 dsh plugin add）'
} elseif ($PSCmdlet.ShouldProcess("profile $Profile", "add $PluginSource")) {
  & dsh plugin --profile $Profile add $PluginSource
  if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败，退出码 $LASTEXITCODE" }
  Write-Ok '安装完成'
}

# ── 2. 写配置覆盖层 ────────────────────────────────────────────────────────
Write-Step '写配置（profile 的 cordis.patch.yml）'

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$existing = if (Test-Path $patchPath) { [System.IO.File]::ReadAllText($patchPath, [System.Text.UTF8Encoding]::new($false)) } else { '' }

if ($existing -match "(?m)^- id:\s*dsh-peer-mcp\s*$") {
  Write-Ok '已有 dsh-peer-mcp 配置条目，未改动'
} else {
  $lines = @('# dsh-peer-mcp：本机对外监听，好让发起端连进来配对。')
  $lines += '# listen 只能在这里改 —— agent 的四个 peer_* 工具都打不开监听口。'
  $lines += '- id: dsh-peer-mcp'
  $lines += '  config:'
  $lines += '    listen: true'
  $lines += '    host: 0.0.0.0'
  $lines += "    port: $Port"
  $lines += '    allowedDirs:'
  foreach ($dir in $AllowedDirs) { $lines += "      - '$dir'" }
  $lines += '    taskTimeoutMs: 600000'
  $block = ($lines -join "`n") + "`n"

  # A fresh profile ships this file containing just `[]` — an empty YAML array.
  # Appending after that produces `[]` followed by entries, which is not valid
  # YAML and takes the whole profile down at load. So an empty placeholder is
  # replaced, and only a file that already holds real entries is appended to.
  $body = $existing
  $placeholder = '(?m)^\s*\[\s*\]\s*$'
  $isEmptyArray = $body -match $placeholder
  if ($isEmptyArray) {
    $body = ($body -replace $placeholder, '').TrimEnd("`r", "`n")
  }

  $next = if ($body.Trim() -eq '') { $block } else { $body.TrimEnd("`r", "`n") + "`n`n" + $block }

  if ($PSCmdlet.ShouldProcess($patchPath, 'write dsh-peer-mcp config')) {
    [System.IO.File]::WriteAllText($patchPath, $next, [System.Text.UTF8Encoding]::new($false))
    if ($isEmptyArray) {
      Write-Ok "已写入（替换了占位空数组）：$patchPath"
    } else {
      Write-Ok "已追加：$patchPath"
    }
  }
}

# ── 3. 复查 ────────────────────────────────────────────────────────────────
Write-Step '复查安装结果'

$installed = Join-Path $profileDir 'node_modules\dsh-peer-mcp'
$expected = @('package.json', 'cordis.patch.yml', 'client.js', 'lib\plugin.js', 'src\service.js', 'src\task-command.js')
$missing = @()
foreach ($file in $expected) {
  if (-not (Test-Path (Join-Path $installed $file))) { $missing += $file }
}
if ($missing.Count -gt 0) {
  throw "安装不完整，缺少：$($missing -join ', ')"
}
Write-Ok '插件文件齐全（含设置页需要的 client.js）'

if (Test-Path (Join-Path $installed 'node_modules')) {
  Write-Warn2 '插件目录里出现了 node_modules —— 正常安装不该有，可能影响了宿主解析'
} else {
  Write-Ok '无多余依赖目录'
}

$bundles = (Get-Content (Join-Path $profileDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).dsh.profile.bundles
if ($bundles -contains 'dsh-peer-mcp') {
  Write-Ok 'bundle 已注册'
} else {
  throw "bundle 未注册，宿主要求 dsh.profile.bundles 里含 dsh-peer-mcp。当前：$($bundles -join ', ')"
}

# ── 后续 ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1. 重启 DSH。首次监听若弹出防火墙授权框，选「允许」（专用网络）。'
Write-Host '  2. 重启后看日志确认两行：'
Write-Host '       [dsh-peer-mcp] task command: ...'
Write-Host '       [dsh-peer-mcp] settings routes ready under /plugins/dsh-peer-mcp'
Write-Host '     日志位置：%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log'
Write-Host '  3. 在 设置 → 设备互联 里生成配对码，交给发起端。'
Write-Host ''
Write-Host '如果 task command 那行报错（例如 shim 无法解析），手动指定命令：' -ForegroundColor Yellow
Write-Host '  在 profile 的 cordis.patch.yml 里给 dsh-peer-mcp 的 config 加上：'
Write-Host '    command: ["C:\\Path\\to\\DSH Desktop.exe", "--expose-internals", "C:\\Path\\to\\resources\\app\\lib\\desktop-cli.js", "--profile", "headless"]'
Write-Host '  （Windows 上 dsh 是 .cmd 外壳，Node 不能直接启动它；插件会自动解析，解析失败时用这条兜底）'

exit 0
