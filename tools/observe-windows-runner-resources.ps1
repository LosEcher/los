[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$JobName = 'gate-test',
  [ValidateRange(5, 300)]
  [int]$SampleIntervalSeconds = 15,
  [ValidateRange(30, 3600)]
  [int]$WaitTimeoutSeconds = 900,
  [ValidateRange(0, 1800)]
  [int]$PostRunDelaySeconds = 300,
  [switch]$SampleOnce
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-Bytes {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  if ($Value -notmatch '^\s*([0-9.]+)\s*([KMGT]?B)\s*$') { return $null }
  $multipliers = @{ B = 1; KB = 1KB; MB = 1MB; GB = 1GB; TB = 1TB }
  return [long]([double]$Matches[1] * $multipliers[$Matches[2].ToUpperInvariant()])
}

function ConvertTo-Percent {
  param([AllowNull()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $parsed = 0.0
  if (-not [double]::TryParse($Value.Trim().TrimEnd('%'), [ref]$parsed)) { return $null }
  return $parsed
}

function Get-WindowsHostSample {
  $os = Get-CimInstance Win32_OperatingSystem
  $pageFiles = @(Get-CimInstance Win32_PageFileUsage)
  $trackedNames = @('vmmemWSL', 'wslservice', 'wslhost', 'wslrelay')
  $processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $trackedNames -contains $_.Name
  })

  [pscustomobject]@{
    capturedAt = [DateTimeOffset]::Now.ToString('o')
    totalPhysicalMemoryBytes = [long]$os.TotalVisibleMemorySize * 1KB
    availablePhysicalMemoryBytes = [long]$os.FreePhysicalMemory * 1KB
    pageFileAllocatedBytes = [long](($pageFiles | Measure-Object AllocatedBaseSize -Sum).Sum) * 1MB
    pageFileUsedBytes = [long](($pageFiles | Measure-Object CurrentUsage -Sum).Sum) * 1MB
    pageFileSystemPeakBytes = [long](($pageFiles | Measure-Object PeakUsage -Sum).Sum) * 1MB
    vmProcessWorkingSetBytes = [long](($processes | Measure-Object WorkingSet64 -Sum).Sum)
    vmProcessPrivateBytes = [long](($processes | Measure-Object PrivateMemorySize64 -Sum).Sum)
    vmProcessCpuSeconds = [double](($processes | Measure-Object CPU -Sum).Sum)
    vmProcessIds = @($processes | ForEach-Object { $_.Id })
    vmProcessNames = @($processes | ForEach-Object { $_.Name } | Sort-Object -Unique)
  }
}

function ConvertFrom-PodmanJson {
  param([string[]]$Lines)
  $text = $Lines -join [Environment]::NewLine
  if ([string]::IsNullOrWhiteSpace($text)) { return @() }
  return @($text | ConvertFrom-Json)
}

function Get-PodmanSample {
  param([AllowNull()][string]$TaskId)
  $running = ConvertFrom-PodmanJson @(& podman ps --format json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'podman ps failed' }
  $stats = ConvertFrom-PodmanJson @(& podman stats --no-stream --format json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'podman stats failed' }

  $jobPattern = if ([string]::IsNullOrWhiteSpace($TaskId)) {
    "^FORGEJO-ACTIONS-TASK-(?<task>[0-9]+)_.*_JOB-$([regex]::Escape($JobName))$"
  } else {
    "^FORGEJO-ACTIONS-TASK-$([regex]::Escape($TaskId))_.*_JOB-$([regex]::Escape($JobName))$"
  }
  $jobContainer = $null
  foreach ($container in $running) {
    foreach ($name in @($container.Names)) {
      if ($name -match $jobPattern) {
        $jobContainer = $name
        if ([string]::IsNullOrWhiteSpace($TaskId)) { $TaskId = $Matches.task }
        break
      }
    }
    if ($null -ne $jobContainer) { break }
  }

  $relatedPattern = if ([string]::IsNullOrWhiteSpace($TaskId)) {
    '^$'
  } else {
    "^FORGEJO-ACTIONS-TASK-$([regex]::Escape($TaskId))(?:_|-)"
  }
  $related = @($stats | Where-Object { $_.name -match $relatedPattern })
  $memoryBytes = 0L
  $cpuPercent = 0.0
  $pids = 0
  foreach ($container in $related) {
    $usage = @($container.mem_usage -split '/')[0].Trim()
    $bytes = ConvertTo-Bytes $usage
    $cpu = ConvertTo-Percent $container.cpu_percent
    if ($null -ne $bytes) { $memoryBytes += $bytes }
    if ($null -ne $cpu) { $cpuPercent += $cpu }
    $parsedPids = 0
    if ([int]::TryParse([string]$container.pids, [ref]$parsedPids)) { $pids += $parsedPids }
  }

  [pscustomobject]@{
    available = $true
    error = $null
    capturedAt = [DateTimeOffset]::Now.ToString('o')
    taskId = $TaskId
    jobContainerName = $jobContainer
    jobActive = $null -ne $jobContainer
    relatedContainerNames = @($related | ForEach-Object { $_.name } | Sort-Object)
    aggregateCpuPercent = if ($related.Count -gt 0) { $cpuPercent } else { $null }
    aggregateMemoryBytes = if ($related.Count -gt 0) { $memoryBytes } else { $null }
    aggregatePids = if ($related.Count -gt 0) { $pids } else { $null }
  }
}

function Get-ResourceSample {
  param([AllowNull()][string]$TaskId)
  $probe = [Diagnostics.Stopwatch]::StartNew()
  $hostSample = Get-WindowsHostSample
  try {
    $podmanSample = Get-PodmanSample $TaskId
  } catch {
    $podmanSample = [pscustomobject]@{
      available = $false
      error = $_.Exception.Message
      capturedAt = [DateTimeOffset]::Now.ToString('o')
      taskId = $TaskId
      jobContainerName = $null
      jobActive = $false
      relatedContainerNames = @()
      aggregateCpuPercent = $null
      aggregateMemoryBytes = $null
      aggregatePids = $null
    }
  }
  $probe.Stop()
  [pscustomobject]@{
    host = $hostSample
    podman = $podmanSample
    probeDurationMilliseconds = [math]::Round($probe.Elapsed.TotalMilliseconds, 3)
  }
}

function New-Aggregate {
  [pscustomobject]@{
    sampleCount = 0
    podmanUnavailableSampleCount = 0
    probeDurationTotalMilliseconds = 0.0
    probeDurationPeakMilliseconds = 0.0
    minAvailablePhysicalMemoryBytes = $null
    peakPageFileUsedBytes = $null
    peakVmProcessWorkingSetBytes = $null
    peakVmProcessPrivateBytes = $null
    peakContainerCpuPercent = $null
    peakContainerMemoryBytes = $null
    peakContainerPids = $null
  }
}

function Get-MaxNullable {
  param($Current, $Candidate)
  if ($null -eq $Candidate) { return $Current }
  if ($null -eq $Current) { return $Candidate }
  return [math]::Max($Current, $Candidate)
}

function Get-MinNullable {
  param($Current, $Candidate)
  if ($null -eq $Candidate) { return $Current }
  if ($null -eq $Current) { return $Candidate }
  return [math]::Min($Current, $Candidate)
}

function Add-Sample {
  param($Aggregate, $Sample)
  $Aggregate.sampleCount += 1
  if (-not $Sample.podman.available) { $Aggregate.podmanUnavailableSampleCount += 1 }
  $Aggregate.probeDurationTotalMilliseconds += $Sample.probeDurationMilliseconds
  $Aggregate.probeDurationPeakMilliseconds = Get-MaxNullable $Aggregate.probeDurationPeakMilliseconds $Sample.probeDurationMilliseconds
  $Aggregate.minAvailablePhysicalMemoryBytes = Get-MinNullable $Aggregate.minAvailablePhysicalMemoryBytes $Sample.host.availablePhysicalMemoryBytes
  $Aggregate.peakPageFileUsedBytes = Get-MaxNullable $Aggregate.peakPageFileUsedBytes $Sample.host.pageFileUsedBytes
  $Aggregate.peakVmProcessWorkingSetBytes = Get-MaxNullable $Aggregate.peakVmProcessWorkingSetBytes $Sample.host.vmProcessWorkingSetBytes
  $Aggregate.peakVmProcessPrivateBytes = Get-MaxNullable $Aggregate.peakVmProcessPrivateBytes $Sample.host.vmProcessPrivateBytes
  $Aggregate.peakContainerCpuPercent = Get-MaxNullable $Aggregate.peakContainerCpuPercent $Sample.podman.aggregateCpuPercent
  $Aggregate.peakContainerMemoryBytes = Get-MaxNullable $Aggregate.peakContainerMemoryBytes $Sample.podman.aggregateMemoryBytes
  $Aggregate.peakContainerPids = Get-MaxNullable $Aggregate.peakContainerPids $Sample.podman.aggregatePids
}

function Get-MachineInfo {
  $machines = @(ConvertFrom-PodmanJson @(& podman machine inspect 2>$null))
  if ($LASTEXITCODE -ne 0 -or $machines.Count -eq 0) { return $null }
  $machine = $machines[0]
  [pscustomobject]@{
    name = $machine.Name
    state = $machine.State
    cpus = $machine.Resources.CPUs
    memoryMiB = $machine.Resources.Memory
    backend = 'wsl'
  }
}

function Write-Observation {
  param($Observation)
  $directory = Split-Path -Parent $OutputPath
  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  $json = $Observation | ConvertTo-Json -Depth 10 -Compress
  [IO.File]::WriteAllText($OutputPath, "$json`n", (New-Object Text.UTF8Encoding($false)))
  Write-Output $json
}

$observerStartedAt = [DateTimeOffset]::Now
$observerCpuStart = (Get-Process -Id $PID).CPU
$machineInfo = Get-MachineInfo
$aggregate = New-Aggregate
$startSample = Get-ResourceSample $null
Add-Sample $aggregate $startSample

if ($SampleOnce) {
  $observerCpuEnd = (Get-Process -Id $PID).CPU
  Write-Observation ([pscustomobject]@{
    schemaVersion = 1
    mode = 'snapshot'
    scope = [pscustomobject]@{
      runnerHost = 'windows'
      jobRuntime = 'linux-amd64-podman'
      vmProcessAttribution = 'shared-wsl-host-process-set'
      containerAttribution = 'none'
    }
    machine = $machineInfo
    sampling = [pscustomobject]@{
      sampleIntervalSeconds = $SampleIntervalSeconds
      sampleCount = $aggregate.sampleCount
      podmanUnavailableSampleCount = $aggregate.podmanUnavailableSampleCount
      probeDurationAverageMilliseconds = [math]::Round($aggregate.probeDurationTotalMilliseconds / $aggregate.sampleCount, 3)
      probeDurationPeakMilliseconds = $aggregate.probeDurationPeakMilliseconds
      estimatedProbeDutyCyclePercent = [math]::Round(100 * $aggregate.probeDurationTotalMilliseconds / $aggregate.sampleCount / ($SampleIntervalSeconds * 1000), 3)
      observerCpuSeconds = [math]::Round($observerCpuEnd - $observerCpuStart, 6)
    }
    snapshot = $startSample
  })
  exit 0
}

$taskId = $null
$jobStartSample = $null
$deadline = [DateTimeOffset]::Now.AddSeconds($WaitTimeoutSeconds)
while ([DateTimeOffset]::Now -lt $deadline) {
  if ($startSample.podman.available -and $startSample.podman.jobActive) {
    $taskId = $startSample.podman.taskId
    $jobStartSample = $startSample
    break
  }
  Start-Sleep -Seconds $SampleIntervalSeconds
  $startSample = Get-ResourceSample $null
  Add-Sample $aggregate $startSample
}
if ($null -eq $jobStartSample) { throw "Forgejo job container for '$JobName' was not observed before timeout" }

$jobAggregate = New-Aggregate
Add-Sample $jobAggregate $jobStartSample
$jobEndSample = $null
while ($true) {
  Start-Sleep -Seconds $SampleIntervalSeconds
  $sample = Get-ResourceSample $taskId
  Add-Sample $aggregate $sample
  Add-Sample $jobAggregate $sample
  if ($sample.podman.available -and -not $sample.podman.jobActive) {
    $jobEndSample = $sample
    break
  }
}

if ($PostRunDelaySeconds -gt 0) { Start-Sleep -Seconds $PostRunDelaySeconds }
$postRunSample = Get-ResourceSample $taskId
Add-Sample $aggregate $postRunSample
$observerEndedAt = [DateTimeOffset]::Now
$observerCpuEnd = (Get-Process -Id $PID).CPU

Write-Observation ([pscustomobject]@{
  schemaVersion = 1
  mode = 'forgejo-job'
  scope = [pscustomobject]@{
    runnerHost = 'windows'
    jobRuntime = 'linux-amd64-podman'
    vmProcessAttribution = 'shared-wsl-host-process-set'
    containerAttribution = 'forgejo-task-scoped'
  }
  machine = $machineInfo
  job = [pscustomobject]@{
    name = $JobName
    taskId = $taskId
    containerName = $jobStartSample.podman.jobContainerName
    detectedStartedAt = $jobStartSample.podman.capturedAt
    detectedEndedAt = $jobEndSample.podman.capturedAt
  }
  sampling = [pscustomobject]@{
    observerStartedAt = $observerStartedAt.ToString('o')
    observerEndedAt = $observerEndedAt.ToString('o')
    sampleIntervalSeconds = $SampleIntervalSeconds
    postRunDelaySeconds = $PostRunDelaySeconds
    sampleCount = $aggregate.sampleCount
    podmanUnavailableSampleCount = $aggregate.podmanUnavailableSampleCount
    probeDurationAverageMilliseconds = [math]::Round($aggregate.probeDurationTotalMilliseconds / $aggregate.sampleCount, 3)
    probeDurationPeakMilliseconds = $aggregate.probeDurationPeakMilliseconds
    estimatedProbeDutyCyclePercent = [math]::Round(100 * $aggregate.probeDurationTotalMilliseconds / $aggregate.sampleCount / ($SampleIntervalSeconds * 1000), 3)
    observerCpuSeconds = [math]::Round($observerCpuEnd - $observerCpuStart, 6)
  }
  windowsHost = [pscustomobject]@{
    totalPhysicalMemoryBytes = $jobStartSample.host.totalPhysicalMemoryBytes
    availablePhysicalMemoryBytes = [pscustomobject]@{
      start = $jobStartSample.host.availablePhysicalMemoryBytes
      minimum = $jobAggregate.minAvailablePhysicalMemoryBytes
      end = $jobEndSample.host.availablePhysicalMemoryBytes
      postRun = $postRunSample.host.availablePhysicalMemoryBytes
    }
    pageFileUsedBytes = [pscustomobject]@{
      start = $jobStartSample.host.pageFileUsedBytes
      peakSampled = $jobAggregate.peakPageFileUsedBytes
      end = $jobEndSample.host.pageFileUsedBytes
      postRun = $postRunSample.host.pageFileUsedBytes
    }
    pageFileAllocatedBytes = $jobStartSample.host.pageFileAllocatedBytes
    pageFileSystemPeakBytes = $postRunSample.host.pageFileSystemPeakBytes
  }
  podmanVmHostProcesses = [pscustomobject]@{
    names = $jobStartSample.host.vmProcessNames
    workingSetBytes = [pscustomobject]@{
      start = $jobStartSample.host.vmProcessWorkingSetBytes
      peakSampled = $jobAggregate.peakVmProcessWorkingSetBytes
      end = $jobEndSample.host.vmProcessWorkingSetBytes
      postRun = $postRunSample.host.vmProcessWorkingSetBytes
    }
    privateBytes = [pscustomobject]@{
      start = $jobStartSample.host.vmProcessPrivateBytes
      peakSampled = $jobAggregate.peakVmProcessPrivateBytes
      end = $jobEndSample.host.vmProcessPrivateBytes
      postRun = $postRunSample.host.vmProcessPrivateBytes
    }
    cpuSecondsDelta = [math]::Round([math]::Max(0, $jobEndSample.host.vmProcessCpuSeconds - $jobStartSample.host.vmProcessCpuSeconds), 6)
  }
  podmanTaskContainers = [pscustomobject]@{
    peakAggregateCpuPercent = $jobAggregate.peakContainerCpuPercent
    peakAggregateMemoryBytes = $jobAggregate.peakContainerMemoryBytes
    peakAggregatePids = $jobAggregate.peakContainerPids
    namesAtStart = $jobStartSample.podman.relatedContainerNames
  }
})
