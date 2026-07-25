import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptUrl = new URL('./observe-windows-runner-resources.ps1', import.meta.url);

test('Windows observer keeps host, shared VM, and task container scopes separate', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.match(script, /runnerHost = 'windows'/);
  assert.match(script, /jobRuntime = 'linux-amd64-podman'/);
  assert.match(script, /vmProcessAttribution = 'shared-wsl-host-process-set'/);
  assert.match(script, /containerAttribution = 'forgejo-task-scoped'/);
  assert.match(script, /windowsHost = \[pscustomobject\]/);
  assert.match(script, /podmanVmHostProcesses = \[pscustomobject\]/);
  assert.match(script, /podmanTaskContainers = \[pscustomobject\]/);
});

test('Windows observer uses job-container boundaries and a five-minute post-run sample', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.match(script, /FORGEJO-ACTIONS-TASK-\(\?<task>\[0-9\]\+\).*_JOB-/);
  assert.match(script, /FORGEJO-ACTIONS-TASK-\$\(\[regex\]::Escape\(\$TaskId\)\)_\.\*_JOB-/);
  assert.match(script, /\[int\]\$PostRunDelaySeconds = 300/);
  assert.match(script, /if \(\$sample\.podman\.available -and -not \$sample\.podman\.jobActive\)/);
  assert.match(script, /postRun = \$postRunSample\.host\.pageFileUsedBytes/);
});

test('Windows observer excludes wait and post-run samples from target job peaks', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.match(script, /\$jobAggregate = New-Aggregate/);
  assert.match(script, /Add-Sample \$jobAggregate \$jobStartSample/);
  assert.match(script, /peakSampled = \$jobAggregate\.peakPageFileUsedBytes/);
  assert.match(script, /peakAggregateMemoryBytes = \$jobAggregate\.peakContainerMemoryBytes/);
  assert.doesNotMatch(script, /Add-Sample \$jobAggregate \$postRunSample/);
});

test('Windows observer reports sampling cost and uses a low-frequency default', async () => {
  const script = await readFile(scriptUrl, 'utf8');

  assert.match(script, /\[int\]\$SampleIntervalSeconds = 15/);
  assert.match(script, /probeDurationAverageMilliseconds/);
  assert.match(script, /probeDurationPeakMilliseconds/);
  assert.match(script, /observerCpuSeconds/);
  assert.match(script, /estimatedProbeDutyCyclePercent/);
  assert.match(script, /podmanUnavailableSampleCount/);
  assert.match(script, /podman stats --no-stream --format json/);
});
