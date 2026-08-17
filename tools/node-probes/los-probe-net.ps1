# los-probe-net.ps1 — read-only network probe (Windows).
#
# Pinned read-only diagnostic for los executor nodes. Performs network
# reachability checks (TCP connect / ping / HTTP) and reports local service
# presence. Writes NOTHING to disk: the only output is a single JSON document
# on stdout. Intended to run exclusively through los-probe-runner.exe, the
# hash-pinned supervisor (los agent tool `run_node_probe`, probe='net').
#
# This file is hash-pinned at build/deploy time: editing it invalidates the
# pin and the runner refuses to execute it (fail-closed).
#
# Env knobs (all optional):
#   LOS_PROBE_TARGETS  semicolon-separated host:port TCP targets (defaults below)
#   LOS_PROBE_PING     semicolon-separated hosts to ping (defaults: loopback + gateway)
#   LOS_PROBE_HTTP     semicolon-separated URLs for HTTP checks (defaults: gateway health)
#   LOS_PROBE_PROCESS  semicolon-separated process names to look for (defaults: sing-box/vivaldi)
#   LOS_PROBE_PORTS    semicolon-separated local TCP listeners to check (defaults: none)

param()

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$DefaultTargets = @('1.1.1.1:443', '8.8.8.8:53', '100.112.77.123:8080')
$DefaultPing = @('127.0.0.1')
$DefaultHttp = @('http://100.112.77.123:8080/health')
$DefaultProcess = @('sing-box', 'vivaldi')

function Split-List([string]$raw, [string[]]$fallback) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return $fallback }
  return @($raw.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Test-TcpPort([string]$hostPort) {
  $parts = $hostPort.Split(':', 2)
  if ($parts.Count -ne 2) {
    return @{ target = $hostPort; kind = 'tcp'; ok = $false; detail = 'bad target format' }
  }
  $h = $parts[0].Trim(); $p = 0
  if (-not [int]::TryParse($parts[1], [ref]$p) -or $p -lt 1 -or $p -gt 65535) {
    return @{ target = $hostPort; kind = 'tcp'; ok = $false; detail = 'bad port' }
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect($h, $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(3000)) {
      $client.Close(); $sw.Stop()
      return @{ target = $hostPort; kind = 'tcp'; ok = $false; ms = $sw.ElapsedMilliseconds; detail = 'timeout' }
    }
    $client.EndConnect($iar)
    $client.Close(); $sw.Stop()
    return @{ target = $hostPort; kind = 'tcp'; ok = $true; ms = $sw.ElapsedMilliseconds }
  } catch {
    $sw.Stop()
    if ($client) { try { $client.Close() } catch { } }
    return @{ target = $hostPort; kind = 'tcp'; ok = $false; ms = $sw.ElapsedMilliseconds; detail = ($_.Exception.Message -replace '\s+', ' ') }
  }
}

function Test-PingHost([string]$hostName) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $reply = Test-Connection -ComputerName $hostName -Count 1 -Quiet
    $sw.Stop()
    return @{ target = $hostName; kind = 'ping'; ok = [bool]$reply; ms = $sw.ElapsedMilliseconds }
  } catch {
    $sw.Stop()
    return @{ target = $hostName; kind = 'ping'; ok = $false; ms = $sw.ElapsedMilliseconds; detail = 'unreachable' }
  }
}

function Test-HttpUrl([string]$url) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $code = $null
  try {
    $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 5 $url 2>$null
    $sw.Stop()
    if ($null -eq $code -or $code -eq '') { return @{ target = $url; kind = 'http'; ok = $false; ms = $sw.ElapsedMilliseconds; detail = 'no response' } }
    return @{ target = $url; kind = 'http'; ok = ($code -match '^[24]'); code = $code; ms = $sw.ElapsedMilliseconds }
  } catch {
    $sw.Stop()
    return @{ target = $url; kind = 'http'; ok = $false; ms = $sw.ElapsedMilliseconds; detail = ($_.Exception.Message -replace '\s+', ' ') }
  }
}

function Test-LocalPort([int]$port) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $sw.Stop()
    return @{ target = "127.0.0.1:$port"; kind = 'listen'; ok = ($null -ne $conn); ms = $sw.ElapsedMilliseconds }
  } catch {
    $sw.Stop()
    return @{ target = "127.0.0.1:$port"; kind = 'listen'; ok = $false; ms = $sw.ElapsedMilliseconds; detail = 'check failed' }
  }
}

$targets = Split-List $env:LOS_PROBE_TARGETS $DefaultTargets
$pings = Split-List $env:LOS_PROBE_PING $DefaultPing
$urls = Split-List $env:LOS_PROBE_HTTP $DefaultHttp
$procs = Split-List $env:LOS_PROBE_PROCESS $DefaultProcess
$ports = Split-List $env:LOS_PROBE_PORTS @() | ForEach-Object { [int]$_ }

$probes = @()
foreach ($t in $targets) { $probes += Test-TcpPort $t }
foreach ($h in $pings) { $probes += Test-PingHost $h }
foreach ($u in $urls) { $probes += Test-HttpUrl $u }
foreach ($p in $ports) { $probes += Test-LocalPort $p }

$services = @()
foreach ($name in $procs) {
  $found = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
  $services += @{ name = $name; running = ($null -ne $found); pid = if ($found) { $found.Id } else { $null } }
}

$result = @{
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  host = $env:COMPUTERNAME
  probe = 'net'
  probes = $probes
  services = $services
}
$result | ConvertTo-Json -Depth 5 -Compress
