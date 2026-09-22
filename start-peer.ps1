<#
启动 B 机的 dsh-peer-mcp。

用法：
  .\start-peer.ps1 -Key <共享密钥> [-AllowedDirs "D:\repos;D:\work"] [-Host 0.0.0.0] [-Port 7331]

不带参数运行时会生成一个随机密钥并打印出来 —— 把它复制到 A 机的
cordis.patch.yml 里。密钥不会写进任何文件。
#>
[CmdletBinding()]
param(
  [string]$Key,
  [string]$AllowedDirs,
  [string]$BindHost = '127.0.0.1',
  [int]$Port = 7331
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Key) {
  # RandomNumberGenerator.Create() works on both Windows PowerShell 5.1 and
  # PowerShell 7; the static RandomNumberGenerator.Fill() does not exist on 5.1.
  $bytes = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $Key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  Write-Host ''
  Write-Host '已生成共享密钥（只显示这一次，请复制到 A 机）：' -ForegroundColor Yellow
  Write-Host "  $Key" -ForegroundColor Cyan
  Write-Host ''
}

$env:DSH_PEER_KEY = $Key
$env:DSH_PEER_HOST = $BindHost
$env:DSH_PEER_PORT = [string]$Port
if ($AllowedDirs) { $env:DSH_PEER_ALLOWED_DIRS = $AllowedDirs }

Write-Host "启动 dsh-peer-mcp：$BindHost`:$Port" -ForegroundColor Green
if ($BindHost -ne '127.0.0.1') {
  Write-Host '注意：正在监听非 loopback 地址，持密钥者可在这台机器上执行任务。' -ForegroundColor Yellow
}

node (Join-Path $here 'src\bin.js')
