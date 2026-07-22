#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesRoot = resolve(repoRoot, 'packages');
const baselinePath = resolve(repoRoot, 'docs/governance/repository-coverage-baseline.json');
const update = process.argv.includes('--update');
const coverageTolerance = 0.5;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function isSource(path) {
  return /\.(?:[cm]?js|jsx|tsx?)$/.test(path) && !/\.d\.ts$/.test(path);
}

function isTest(path) {
  return /\.test\.(?:[cm]?js|jsx|tsx?)$/.test(path);
}

function countLines(paths) {
  return paths.reduce((count, path) => count + readFileSync(path, 'utf8').split('\n').length, 0);
}

function parseCoverage(output, packageName) {
  const match = [...output.matchAll(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/g)].at(-1);
  if (!match) throw new Error(`${packageName}: coverage summary not found`);
  return { lines: Number(match[1]), branches: Number(match[2]), functions: Number(match[3]) };
}

function observedSources(coverageDir, packageDir, implementationFiles) {
  const known = new Set(implementationFiles.map(path => pathToFileURL(path).href));
  const observed = new Set();
  for (const file of readdirSync(coverageDir)) {
    if (!file.endsWith('.json')) continue;
    const payload = JSON.parse(readFileSync(join(coverageDir, file), 'utf8'));
    for (const script of payload.result ?? []) {
      if (known.has(script.url)) observed.add(relative(packageDir, fileURLToPath(script.url)).replaceAll('\\', '/'));
    }
  }
  return [...observed].sort();
}

function listPackages() {
  return readdirSync(packagesRoot)
    .map(name => resolve(packagesRoot, name))
    .filter(path => statSync(path).isDirectory())
    .filter(path => {
      try { return statSync(resolve(path, 'package.json')).isFile() && statSync(resolve(path, 'src')).isDirectory(); }
      catch { return false; }
    })
    .sort();
}

function capturePackage(packageDir) {
  const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
  const sourceFiles = walk(resolve(packageDir, 'src')).filter(isSource);
  const testFiles = sourceFiles.filter(isTest);
  const implementationFiles = sourceFiles.filter(path => !isTest(path));
  if (!manifest.scripts?.test) {
    process.stdout.write(`coverage baseline: ${manifest.name} (no test script)\n`);
    return {
      name: manifest.name,
      path: relative(repoRoot, packageDir).replaceAll('\\', '/'),
      implementationFiles: implementationFiles.length,
      sourceTestFiles: testFiles.length,
      sourceTestLines: countLines(testFiles),
      observedImplementationFiles: 0,
      observedFilePercent: 0,
      coverage: null,
    };
  }
  const coverageDir = mkdtempSync(join(tmpdir(), 'los-coverage-'));

  try {
    process.stdout.write(`coverage baseline: ${manifest.name}\n`);
    const result = spawnSync('pnpm', ['--filter', manifest.name, 'test'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
      maxBuffer: 64 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(output);
      throw new Error(`${manifest.name}: tests failed with exit ${result.status}`);
    }

    const observedFiles = observedSources(coverageDir, packageDir, implementationFiles);
    return {
      name: manifest.name,
      path: relative(repoRoot, packageDir).replaceAll('\\', '/'),
      implementationFiles: implementationFiles.length,
      sourceTestFiles: testFiles.length,
      sourceTestLines: countLines(testFiles),
      observedImplementationFiles: observedFiles.length,
      observedFilePercent: implementationFiles.length === 0
        ? 100
        : Math.round(observedFiles.length / implementationFiles.length * 10_000) / 100,
      coverage: observedFiles.length > 0 ? parseCoverage(output, manifest.name) : null,
    };
  } finally {
    rmSync(coverageDir, { recursive: true, force: true });
  }
}

function captureBaseline() {
  const packages = listPackages().map(capturePackage);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toLocaleDateString('en-CA'),
    nodeVersion: process.version,
    command: 'pnpm test:coverage:baseline:update',
    methodology: 'Each package test runs with package-local Node coverage. Static inventory and V8-observed implementation files are recorded separately; unobserved files are not represented as covered.',
    regressionTolerancePercent: coverageTolerance,
    totals: {
      packages: packages.length,
      implementationFiles: packages.reduce((sum, item) => sum + item.implementationFiles, 0),
      sourceTestFiles: packages.reduce((sum, item) => sum + item.sourceTestFiles, 0),
      sourceTestLines: packages.reduce((sum, item) => sum + item.sourceTestLines, 0),
      observedImplementationFiles: packages.reduce((sum, item) => sum + item.observedImplementationFiles, 0),
    },
    packages,
  };
}

function compareBaseline(expected, current) {
  const failures = [];
  const currentByName = new Map(current.packages.map(item => [item.name, item]));
  for (const baselinePackage of expected.packages) {
    const candidate = currentByName.get(baselinePackage.name);
    if (!candidate) {
      failures.push(`${baselinePackage.name}: package missing`);
      continue;
    }
    for (const field of ['implementationFiles', 'sourceTestFiles', 'sourceTestLines']) {
      if (candidate[field] !== baselinePackage[field]) {
        failures.push(`${baselinePackage.name}: ${field} changed ${baselinePackage[field]} -> ${candidate[field]}`);
      }
    }
    if (candidate.observedImplementationFiles < baselinePackage.observedImplementationFiles) {
      failures.push(`${baselinePackage.name}: observed implementation files regressed ${baselinePackage.observedImplementationFiles} -> ${candidate.observedImplementationFiles}`);
    }
    if (baselinePackage.coverage && !candidate.coverage) {
      failures.push(`${baselinePackage.name}: package coverage is no longer available`);
    }
    for (const metric of ['lines', 'branches', 'functions']) {
      if (baselinePackage.coverage && candidate.coverage
        && candidate.coverage[metric] + coverageTolerance < baselinePackage.coverage[metric]) {
        failures.push(`${baselinePackage.name}: ${metric} coverage regressed ${baselinePackage.coverage[metric]} -> ${candidate.coverage[metric]}`);
      }
    }
    currentByName.delete(baselinePackage.name);
  }
  for (const name of currentByName.keys()) failures.push(`${name}: new package is missing from baseline`);
  return failures;
}

const current = captureBaseline();
if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  process.stdout.write(`updated ${relative(repoRoot, baselinePath)}\n`);
} else {
  const expected = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const failures = compareBaseline(expected, current);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\nRun pnpm test:coverage:baseline:update after reviewing the changes.\n`);
    process.exit(1);
  }
  process.stdout.write(`repository coverage baseline passed for ${current.packages.length} packages\n`);
}
