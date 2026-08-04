export type DiffLineType = 'meta' | 'hunk' | 'ctx' | 'add' | 'del';

export type DiffLine = {
  type: DiffLineType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type ParsedDiffFile = {
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
};

export type SideBySideRow = {
  left: DiffLine | null;
  right: DiffLine | null;
  full?: boolean;
};

export function parseDiffFileLines(diff: string): ParsedDiffFile[];
export function collapseLargeHunks(file: ParsedDiffFile, maxLines?: number): ParsedDiffFile;
export function buildSideBySideRows(lines: DiffLine[]): SideBySideRow[];
