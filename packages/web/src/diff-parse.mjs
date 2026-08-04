/**
 * Line-level unified diff parser for the work review panel (G8).
 * Pure ESM module so `node --test src/*.test.mjs` can exercise it at runtime;
 * TypeScript declarations live in diff-parse.d.mts.
 *
 * Understands the subset of `git diff --unified` output that the gateway
 * returns from GET /managed-workspaces/:id/diff:
 *   - `diff --git a/x b/y` file separators
 *   - `new file mode`, `deleted file mode`, `index ...`, `--- a/x`, `+++ b/x`
 *   - `@@ -a[,b] +c[,d] @@` hunk headers (omitted counts default to 1)
 *   - context, `-` removal, `+` addition lines
 *   - `Binary files ... differ` and `\ No newline at end of file` markers
 */

/** @typedef {'meta'|'hunk'|'ctx'|'add'|'del'} DiffLineType */

/**
 * @typedef {Object} DiffLine
 * @property {DiffLineType} type
 * @property {number|null} oldLine 1-based old-side line number (ctx/del)
 * @property {number|null} newLine 1-based new-side line number (ctx/add)
 * @property {string} text raw line content without the trailing newline
 */

/**
 * @typedef {Object} ParsedDiffFile
 * @property {string} path new-side path
 * @property {string|null} oldPath old-side path when renamed
 * @property {boolean} isNew file created in this diff
 * @property {boolean} isDeleted file removed in this diff
 * @property {boolean} isBinary binary marker instead of hunks
 * @property {number} added count of `+` lines
 * @property {number} removed count of `-` lines
 * @property {DiffLine[]} lines parsed lines in file order
 */

/**
 * Parse a unified diff string into per-file line structures.
 * @param {string} diff
 * @returns {ParsedDiffFile[]}
 */
export function parseDiffFileLines(diff) {
  const files = [];
  let current = null;

  for (const raw of String(diff ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      current = newDiffFile(line);
      continue;
    }
    if (!current) continue;
    const entry = classifyLine(current, line);
    if (entry) {
      current.lines.push(entry.line);
      if (entry.type === 'add') current.added += 1;
      if (entry.type === 'del') current.removed += 1;
      if (entry.type === 'binary') current.isBinary = true;
    }
  }
  if (current) files.push(current);
  return files;
}

/**
 * Collapse oversized file contents to a bounded preview plus a marker line.
 * @param {ParsedDiffFile} file
 * @param {number} maxLines
 * @returns {ParsedDiffFile} new object with a trailing meta marker line
 */
export function collapseLargeHunks(file, maxLines = 60) {
  if (file.lines.length <= maxLines) return file;
  const head = file.lines.slice(0, maxLines);
  const remaining = file.lines.length - maxLines;
  const marker = { type: 'meta', oldLine: null, newLine: null, text: `… ${remaining} more lines` };
  return { ...file, lines: [...head, marker] };
}

/**
 * Transform parsed lines into side-by-side rows.
 * Context lines occupy both columns; consecutive `-` blocks pair with the
 * immediately following `+` block so replacement hunks align side by side.
 * Meta/hunk/binary markers occupy the left column with a right-column null
 * and are rendered full-width by the view.
 * @param {DiffLine[]} lines
 * @returns {Array<{left: DiffLine|null, right: DiffLine|null, full?: boolean}>}
 */
export function buildSideBySideRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    if (line.type === 'del') {
      const dels = [];
      while (i < lines.length && lines[i].type === 'del') {
        dels.push(lines[i]);
        i += 1;
      }
      const adds = [];
      while (i < lines.length && lines[i].type === 'add') {
        adds.push(lines[i]);
        i += 1;
      }
      const pairCount = Math.max(dels.length, adds.length);
      for (let k = 0; k < pairCount; k += 1) {
        rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      }
      continue;
    }
    if (line.type === 'add') {
      // standalone additions (no preceding deletion run)
      rows.push({ left: null, right: line });
      i += 1;
      continue;
    }
    // meta / hunk / binary markers span the full width
    rows.push({ left: line, right: null, full: true });
    i += 1;
  }
  return rows;
}

/** @param {string} headerLine @returns {ParsedDiffFile} */
function newDiffFile(headerLine) {
  const pathMatch = headerLine.match(/diff --git a\/(.*?) b\/(.*)$/);
  const path = pathMatch?.[2] ?? headerLine.replace('diff --git ', '');
  const oldPath = pathMatch?.[1] && pathMatch[1] !== pathMatch[2] ? pathMatch[1] : null;
  return {
    path,
    oldPath,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    added: 0,
    removed: 0,
    lines: [],
    currentOldLine: 0,
    currentNewLine: 0,
  };
}

/**
 * Classify one diff line against the current file and update its line cursor.
 * @param {ParsedDiffFile} file
 * @param {string} line
 * @returns {{type: 'add'|'del'|'ctx'|'hunk'|'meta'|'binary', line: DiffLine}|null}
 */
function classifyLine(file, line) {
  if (line.startsWith('@@')) {
    const head = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (head) {
      file.currentOldLine = Number(head[1]) - 1;
      file.currentNewLine = Number(head[2]) - 1;
      return {
        type: 'hunk',
        line: { type: 'hunk', oldLine: Number(head[1]), newLine: Number(head[2]), text: line },
      };
    }
    return { type: 'hunk', line: { type: 'hunk', oldLine: null, newLine: null, text: line } };
  }
  if (line.startsWith('new file mode')) {
    file.isNew = true;
    return { type: 'meta', line: { type: 'meta', oldLine: null, newLine: null, text: line } };
  }
  if (line.startsWith('deleted file mode')) {
    file.isDeleted = true;
    return { type: 'meta', line: { type: 'meta', oldLine: null, newLine: null, text: line } };
  }
  if (line.startsWith('Binary files')) {
    return { type: 'binary', line: { type: 'meta', oldLine: null, newLine: null, text: line } };
  }
  if (line === '\\ No newline at end of file') {
    return { type: 'meta', line: { type: 'meta', oldLine: null, newLine: null, text: line } };
  }
  if (
    line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')
    || line.startsWith('similarity index') || line.startsWith('rename from') || line.startsWith('rename to')
  ) {
    return { type: 'meta', line: { type: 'meta', oldLine: null, newLine: null, text: line } };
  }
  if (line.startsWith('+')) {
    const newLine = file.currentNewLine + 1;
    file.currentNewLine = newLine;
    return { type: 'add', line: { type: 'add', oldLine: null, newLine, text: line.slice(1) } };
  }
  if (line.startsWith('-')) {
    const oldLine = file.currentOldLine + 1;
    file.currentOldLine = oldLine;
    return { type: 'del', line: { type: 'del', oldLine, newLine: null, text: line.slice(1) } };
  }
  // context line advances both cursors
  const oldLine = file.currentOldLine + 1;
  const newLine = file.currentNewLine + 1;
  file.currentOldLine = oldLine;
  file.currentNewLine = newLine;
  return { type: 'ctx', line: { type: 'ctx', oldLine, newLine, text: line } };
}
