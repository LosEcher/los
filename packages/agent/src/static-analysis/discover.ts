import fg from 'fast-glob';

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
    ignore: ignore || [],
  });
}
