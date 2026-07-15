import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function findImporters({ root, deletedFile, sourceFiles }) {
  const deleted = normalizePath(deletedFile);
  const packageSpecifier = packageSpecifierFor(deleted);
  const importers = new Set();

  for (const sourceFile of sourceFiles) {
    const source = normalizePath(sourceFile);
    if (source === deleted || source.includes('/dist/') || source.includes('.test.')) continue;

    const absoluteSource = resolve(root, source);
    if (!existsSync(absoluteSource)) continue;
    const content = readFileSync(absoluteSource, 'utf8');

    for (const specifier of extractSpecifiers(content)) {
      if (packageSpecifier && specifier === packageSpecifier) {
        importers.add(source);
        break;
      }
      if (!specifier.startsWith('.')) continue;
      const candidates = resolveTypeScriptCandidates(root, source, specifier);
      if (candidates.includes(deleted)) {
        importers.add(source);
        break;
      }
    }
  }

  return [...importers].sort();
}

function extractSpecifiers(content) {
  const specifiers = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function packageSpecifierFor(deletedFile) {
  const match = deletedFile.match(/^packages\/([^/]+)\/src\/(.+)\.tsx?$/);
  if (!match) return null;
  const subpath = match[2] === 'index' ? '' : `/${match[2].replace(/\/index$/, '')}`;
  return `@los/${match[1]}${subpath}`;
}

function resolveTypeScriptCandidates(root, sourceFile, specifier) {
  const rawTarget = resolve(root, dirname(sourceFile), specifier);
  const extension = extname(rawTarget);
  const targets = extension
    ? [rawTarget.slice(0, -extension.length) + '.ts', rawTarget.slice(0, -extension.length) + '.tsx']
    : [rawTarget + '.ts', rawTarget + '.tsx', resolve(rawTarget, 'index.ts'), resolve(rawTarget, 'index.tsx')];
  return targets.map(target => normalizePath(relative(root, target)));
}

function normalizePath(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function trackedSourceFiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    { cwd: root },
  ).toString('utf8');
  return output.split('\0').filter(Boolean);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const deletedFile = process.argv[2];
  if (!deletedFile) {
    console.error('usage: node tools/check-delete-importers.mjs <deleted-file>');
    process.exit(2);
  }
  process.stdout.write(findImporters({
    root,
    deletedFile,
    sourceFiles: trackedSourceFiles(root),
  }).join('\n'));
}
