#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_INTERVAL_MS = 5_000;

export async function observeCommand({
  command,
  args = [],
  label = command,
  output,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  const cgroupPath = findCgroupV2Path();
  const aggregate = createAggregate(intervalMs);
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  const completion = waitForChild(child);
  const forwardSignal = signal => {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch {
      // The command may have exited between signal delivery and forwarding.
    }
  };
  const forwardSigint = () => forwardSignal('SIGINT');
  const forwardSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);

  let completed = false;
  completion.finally(() => { completed = true; });
  while (!completed) {
    await sampleResources(child.pid, cgroupPath, aggregate);
    if (!completed) await Promise.race([delay(intervalMs), completion]);
  }
  await sampleResources(child.pid, cgroupPath, aggregate);

  process.removeListener('SIGINT', forwardSigint);
  process.removeListener('SIGTERM', forwardSigterm);
  const result = await completion;
  const endedAt = new Date();
  const observation = finalizeObservation({
    aggregate,
    cgroupPath,
    label,
    startedAt,
    endedAt,
    elapsedSeconds: Number(process.hrtime.bigint() - startedNs) / 1e9,
    result,
  });

  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(observation)}\n`);
  }
  return observation;
}

function createAggregate(intervalMs) {
  return {
    intervalMs,
    sampleCount: 0,
    peakCpuPercent: null,
    peakRssKiB: null,
    minAvailableMemoryKiB: null,
    swapUsedStartKiB: null,
    peakSwapUsedKiB: null,
    swapUsedEndKiB: null,
    cgroupMemoryCurrentStartKiB: null,
    cgroupMemoryCurrentPeakKiB: null,
    cgroupSwapCurrentStartKiB: null,
    cgroupSwapCurrentPeakKiB: null,
  };
}

async function sampleResources(processGroupId, cgroupPath, aggregate) {
  const [processGroup, host] = await Promise.all([
    sampleProcessGroup(processGroupId),
    Promise.resolve(sampleHostMemory()),
  ]);
  const cgroup = sampleCgroup(cgroupPath);

  aggregate.sampleCount += 1;
  aggregate.peakCpuPercent = maxNullable(aggregate.peakCpuPercent, processGroup.cpuPercent);
  aggregate.peakRssKiB = maxNullable(aggregate.peakRssKiB, processGroup.rssKiB);
  aggregate.minAvailableMemoryKiB = minNullable(aggregate.minAvailableMemoryKiB, host.availableKiB);
  if (aggregate.swapUsedStartKiB === null) aggregate.swapUsedStartKiB = host.swapUsedKiB;
  aggregate.peakSwapUsedKiB = maxNullable(aggregate.peakSwapUsedKiB, host.swapUsedKiB);
  aggregate.swapUsedEndKiB = host.swapUsedKiB;
  if (aggregate.cgroupMemoryCurrentStartKiB === null) {
    aggregate.cgroupMemoryCurrentStartKiB = cgroup.memoryCurrentKiB;
  }
  aggregate.cgroupMemoryCurrentPeakKiB = maxNullable(
    aggregate.cgroupMemoryCurrentPeakKiB,
    cgroup.memoryCurrentKiB,
  );
  if (aggregate.cgroupSwapCurrentStartKiB === null) {
    aggregate.cgroupSwapCurrentStartKiB = cgroup.swapCurrentKiB;
  }
  aggregate.cgroupSwapCurrentPeakKiB = maxNullable(
    aggregate.cgroupSwapCurrentPeakKiB,
    cgroup.swapCurrentKiB,
  );
}

function sampleProcessGroup(processGroupId) {
  if (process.platform === 'win32') return Promise.resolve({ cpuPercent: null, rssKiB: null });
  return new Promise(resolve => {
    execFile('ps', ['-eo', 'pgid=,rss=,pcpu='], { encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve({ cpuPercent: null, rssKiB: null });
      let cpuPercent = 0;
      let rssKiB = 0;
      let matched = false;
      for (const line of stdout.split('\n')) {
        const [pgid, rss, cpu] = line.trim().split(/\s+/).map(Number);
        if (pgid !== processGroupId) continue;
        matched = true;
        rssKiB += Number.isFinite(rss) ? rss : 0;
        cpuPercent += Number.isFinite(cpu) ? cpu : 0;
      }
      resolve({
        cpuPercent: matched ? round(cpuPercent, 2) : null,
        rssKiB: matched ? rssKiB : null,
      });
    });
  });
}

function sampleHostMemory() {
  try {
    const values = Object.fromEntries(readFileSync('/proc/meminfo', 'utf8')
      .trim().split('\n').map(line => {
        const [key, value] = line.split(':');
        return [key, Number.parseInt(value, 10)];
      }));
    return {
      availableKiB: numberOrNull(values.MemAvailable),
      swapUsedKiB: Number.isFinite(values.SwapTotal) && Number.isFinite(values.SwapFree)
        ? values.SwapTotal - values.SwapFree
        : null,
    };
  } catch {
    return { availableKiB: null, swapUsedKiB: null };
  }
}

function findCgroupV2Path() {
  try {
    const entry = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n').find(line => line.startsWith('0::'));
    if (!entry) return null;
    return join('/sys/fs/cgroup', entry.slice(3).replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

function sampleCgroup(cgroupPath) {
  if (!cgroupPath) return { memoryCurrentKiB: null, swapCurrentKiB: null };
  return {
    memoryCurrentKiB: readKiB(join(cgroupPath, 'memory.current')),
    swapCurrentKiB: readKiB(join(cgroupPath, 'memory.swap.current')),
  };
}

function finalizeObservation({ aggregate, cgroupPath, label, startedAt, endedAt, elapsedSeconds, result }) {
  return {
    schemaVersion: 1,
    label,
    platform: process.platform,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedSeconds: round(elapsedSeconds, 3),
    exitCode: result.exitCode,
    signal: result.signal,
    sampleIntervalMs: aggregate.intervalMs,
    sampleCount: aggregate.sampleCount,
    processGroup: {
      peakCpuPercent: aggregate.peakCpuPercent,
      peakRssKiB: aggregate.peakRssKiB,
    },
    host: {
      minAvailableMemoryKiB: aggregate.minAvailableMemoryKiB,
      swapUsedStartKiB: aggregate.swapUsedStartKiB,
      peakSwapUsedKiB: aggregate.peakSwapUsedKiB,
      swapUsedEndKiB: aggregate.swapUsedEndKiB,
    },
    cgroupV2: {
      path: cgroupPath,
      memoryCurrentStartKiB: aggregate.cgroupMemoryCurrentStartKiB,
      peakSampledMemoryCurrentKiB: aggregate.cgroupMemoryCurrentPeakKiB,
      memoryPeakEndKiB: cgroupPath ? readKiB(join(cgroupPath, 'memory.peak')) : null,
      swapCurrentStartKiB: aggregate.cgroupSwapCurrentStartKiB,
      peakSampledSwapCurrentKiB: aggregate.cgroupSwapCurrentPeakKiB,
      swapCurrentEndKiB: cgroupPath ? readKiB(join(cgroupPath, 'memory.swap.current')) : null,
    },
  };
}

function waitForChild(child) {
  return new Promise(resolve => {
    let spawnError = null;
    child.once('error', error => { spawnError = error; });
    child.once('close', (exitCode, signal) => resolve({
      exitCode: Number.isInteger(exitCode) ? exitCode : (spawnError ? 127 : 1),
      signal: signal ?? null,
    }));
  });
}

function readKiB(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value === 'max') return null;
    const bytes = Number(value);
    return Number.isFinite(bytes) ? Math.round(bytes / 1024) : null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function maxNullable(current, candidate) {
  if (candidate === null) return current;
  return current === null ? candidate : Math.max(current, candidate);
}

function minNullable(current, candidate) {
  if (candidate === null) return current;
  return current === null ? candidate : Math.min(current, candidate);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = { intervalMs: DEFAULT_INTERVAL_MS };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') break;
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--label') options.label = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--interval-ms') options.intervalMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  const [command, ...args] = argv.slice(index + 1);
  if (!command) throw new Error('missing command after --');
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 10) {
    throw new Error('--interval-ms must be at least 10');
  }
  return { ...options, command, args };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('usage: observe-command-resources.mjs [--label LABEL] [--output FILE] [--interval-ms MS] -- COMMAND [ARG...]');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('usage: observe-command-resources.mjs [--label LABEL] [--output FILE] [--interval-ms MS] -- COMMAND [ARG...]');
    return;
  }
  const observation = await observeCommand(options);
  console.log(JSON.stringify(observation));
  process.exitCode = observation.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
