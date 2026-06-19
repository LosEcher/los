/**
 * @los/agent/tools/glob-matcher — Pure glob pattern matching utilities.
 *
 * String-to-boolean/RegExp functions with zero dependencies on other los modules.
 * Extracted from search-tools.ts.
 */

/**
 * Simple glob matching: supports * (single segment), ** (any segments),
 * ? (single char), {a,b} (alternation). Converts glob to regex.
 */
export function matchGlob(path: string, pattern: string): boolean {
  // Handle **/ prefix
  if (pattern.includes('**')) {
    return matchGlobRecursive(path, pattern);
  }

  const regex = globToRegex(pattern);
  return regex.test(path);
}

export function matchGlobRecursive(path: string, pattern: string): boolean {
  // Split on ** and match each segment
  const parts = pattern.split('**');
  if (parts.length === 1) return matchGlob(path, pattern);

  // If pattern starts with **/, match anywhere in path
  // If pattern ends with /**, match prefix
  // If pattern is **, match everything

  const before = parts[0]!;
  const after = parts[1]!;

  // Simple cases:
  if (pattern === '**' || pattern === '**/*') return true;
  if (pattern.startsWith('**/')) {
    // Match suffix anywhere
    const suffix = pattern.slice(3);
    const regex = globToRegex(suffix);
    // Try matching at every position
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (regex.test(segments.slice(i).join('/'))) return true;
    }
    return false;
  }
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    const regex = globToRegex(prefix + '/*');
    // Match any path starting with prefix
    const prefixParts = prefix.split('/');
    const pathParts = path.split('/');
    if (pathParts.length < prefixParts.length) return false;
    for (let i = 0; i < prefixParts.length; i++) {
      if (!matchGlob(pathParts[i]!, prefixParts[i]!)) return false;
    }
    return true;
  }

  // Middle **: match prefix then suffix
  const prefixRegex = globToRegex(before);
  const suffixRegex = globToRegex(after);

  // Find where the prefix matches, then check suffix in remainder
  const segments = path.split('/');
  for (let i = segments.length; i >= 0; i--) {
    const left = segments.slice(0, i).join('/');
    const right = segments.slice(i).join('/');
    if (prefixRegex.test(left) && suffixRegex.test(right)) return true;
  }
  return false;
}

export function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** handled at higher level; treat as .* here
        regex += '.*';
        i += 2;
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if (ch === '{') {
      // Alternation {a,b,c}
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const parts = pattern.slice(i + 1, end).split(',').map(p => escapeRegex(p));
        regex += `(${parts.join('|')})`;
        i = end + 1;
      } else {
        regex += '\\{';
        i += 1;
      }
    } else if (ch === '.') {
      regex += '\\.';
      i += 1;
    } else if ('+^$()[]|\\'.includes(ch)) {
      regex += '\\' + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|[\]{}]/g, '\\$&');
}

export function globToFilenameRegex(pattern: string): RegExp {
  // For filename matching (search_files), the pattern matches filename only
  // and * matches any chars including path separators (since we match against
  // relative paths)
  if (pattern.includes('/')) {
    // Path-aware glob
    return new RegExp(globToRegex(pattern).source);
  }
  // Simple substring/regex for filenames
  return new RegExp(globToRegex(`**/${pattern}`).source + '|' + globToRegex(pattern).source);
}

export function isSubstringPattern(pattern: string): boolean {
  return !/[*?{[\]\\^$()+|]/.test(pattern);
}
