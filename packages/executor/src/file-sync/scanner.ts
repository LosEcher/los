// Scanner: directory tree walker with change detection against the sync store.
// Inspired by sync-node's scanner.go and rclonemana's manifest-first verification.
import { statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import type { FileSyncStore } from './store.js';

const log = getLogger('file-sync-scanner');

export interface ScanResult {
  folder: string;
  localPath: string;
  totalFiles: number;
  added: number;
  modified: number;
  removed: number;
  unchanged: number;
  durationMs: number;
  scanId: string;
}

export interface ScanEntry {
  filePath: string;
  size: number;
  mtimeNs: number;
  inode: number;
  changeType: 'added' | 'modified' | 'unchanged' | 'removed';
}

const SKIP_DIRS = new Set(['.DS_Store', '@eaDir', '__pycache__', '.git', 'node_modules']);

export function createScanner(store: FileSyncStore, nodeId: string) {
  return {
    scanFolder,
    deepVerify,
    computeFileSha256,
  };

  async function scanFolder(
    folderName: string,
    localPath: string,
    mode: 'full' | 'incremental' = 'full',
  ): Promise<ScanResult> {
    const start = Date.now();
    const scanId = `scan-${nodeId}-${Date.now()}`;
    const resolvedRoot = resolve(localPath);

    const entry = await store.getOrCreateFolder({
      folderId: `folder-${nodeId}-${folderName}`,
      name: folderName,
      localPath: resolvedRoot,
      nodeId,
    });

    const seenPaths = new Set<string>();
    const entries: ScanEntry[] = [];

    await walkDir(resolvedRoot, resolvedRoot, seenPaths, entries, mode);

    // Mark files not seen during walk as removed
    const removedEntries = await store.markStaleFiles(entry.folderId, nodeId, seenPaths);
    const removedPaths = removedEntries.map(e => e.filePath);

    // Upsert all seen entries
    let added = 0;
    let modified = 0;
    let unchanged = 0;
    for (const e of entries) {
      await store.upsertFileEntry({
        ...e,
        folderId: entry.folderId,
        sourceNode: nodeId,
      });
      switch (e.changeType) {
        case 'added': added++; break;
        case 'modified': modified++; break;
        case 'unchanged': unchanged++; break;
      }
    }

    const durationMs = Date.now() - start;
    const result: ScanResult = {
      folder: folderName,
      localPath: resolvedRoot,
      totalFiles: entries.length,
      added,
      modified,
      removed: removedPaths.length,
      unchanged,
      durationMs,
      scanId,
    };

    await store.endScan({
      folderId: entry.folderId,
      nodeId,
      changeCount: added + modified + removedPaths.length,
      durationMs,
    });

    log.info(`scan ${folderName}: +${added} ~${modified} -${removedPaths.length} =${unchanged} (${entries.length} files in ${durationMs}ms)`);
    return result;
  }

  async function deepVerify(
    folderName: string,
    localPath: string,
    computeSha256: boolean,
  ): Promise<ScanResult> {
    const result = await scanFolder(folderName, localPath, 'full');
    if (!computeSha256) return result;

    const resolvedRoot = resolve(localPath);
    let hashed = 0;
    for (const entry of await store.listChangedFiles(result.folder, result.scanId)) {
      try {
        const sha256 = await computeFileSha256(resolve(resolvedRoot, entry.filePath));
        await store.updateFileSha256(entry.entryId, sha256);
        hashed++;
      } catch (err) {
        log.warn(`sha256 failed for ${entry.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log.info(`deep verify ${folderName}: sha256 computed for ${hashed} files`);
    return result;
  }

  async function computeFileSha256(filePath: string): Promise<string> {
    const { createReadStream } = await import('node:fs');
    return new Promise((resolvePromise, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk as Buffer));
      stream.on('end', () => resolvePromise(hash.digest('hex')));
      stream.on('error', reject);
    });
  }
}

async function walkDir(
  root: string,
  currentDir: string,
  seenPaths: Set<string>,
  results: ScanEntry[],
  _mode: 'full' | 'incremental',
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const dirent of entries) {
    if (SKIP_DIRS.has(dirent.name)) continue;

    const fullPath = join(currentDir, dirent.name);
    const relPath = relative(root, fullPath).replace(/\\/g, '/');

    if (dirent.isDirectory()) {
      await walkDir(root, fullPath, seenPaths, results, _mode);
      continue;
    }

    if (!dirent.isFile()) continue;

    try {
      const stat = statSync(fullPath);
      seenPaths.add(relPath);
      results.push({
        filePath: relPath,
        size: stat.size,
        mtimeNs: Math.floor(stat.mtimeMs * 1_000_000),
        inode: stat.ino,
        changeType: 'added', // store.detectChangeType will reclassify
      });
    } catch {
      // skip unreadable files
    }
  }
}
