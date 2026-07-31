import fg from 'fast-glob';

/**
 * Default directories never worth static analysis. `los scan --root <repo>`
 * would otherwise walk every node_modules file (fast-glob does not honor
 * .gitignore), making scans hang on dependency trees.
 */
const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.turbo/**',
  '**/.los-runtime/**',
];

export async function discoverFiles({
  rootDir,
  include,
  ignore,
}: {
  rootDir: string;
  include?: string[];
  ignore?: string[];
}): Promise<string[]> {
  const patterns = include && include.length > 0 ? include : ['**/*'];
  return fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
    unique: true,
    dot: false,
    ignore: [...DEFAULT_IGNORES, ...(ignore || [])],
  });
}
