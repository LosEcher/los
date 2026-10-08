/**
 * project-dsh-sessions — 触发 DSH 会话跨项目投射（P1 L1-2）。
 *
 * 只读 DSH 的 `~/.dsh/storages/session-index.db`，投影进 los Postgres。
 * **不写 DSH 侧任何文件。**
 *
 * 放在 `packages/cli` 而不是 `tools/`：`tools/` 没有 `node_modules`，
 * 裸导入解析不到工作区包（`@los/infra` / `@los/agent`）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '@los/infra/db';
import { projectSessionCatalog } from '@los/agent';

const HOME = homedir();
const DEFAULT_ALIAS = join(HOME, '.dsh', 'storages', 'path-alias-map.json');
const CURRENT_ROOT = join(HOME, 'syncfolder', 'project');

export async function projectDshSessions(argv: string[] = []): Promise<number> {
  const aliasPath = argv.includes('--alias-map')
    ? argv[argv.indexOf('--alias-map') + 1]
    : DEFAULT_ALIAS;

  let aliasMap: unknown = null;
  if (aliasPath && existsSync(aliasPath)) {
    try { aliasMap = JSON.parse(readFileSync(aliasPath, 'utf8')); } catch { aliasMap = null; }
  }

  await initDb();
  try {
    const r = await projectSessionCatalog({ aliasMap: aliasMap as never, currentRoot: CURRENT_ROOT });
    console.log(`status   : ${r.status}`);
    console.log(`sessions : ${r.sessions}`);
    console.log(`byState  : ${JSON.stringify(r.byState)}`);
    console.log(`asOf     : ${r.asOf}`);
    if (r.detail) console.log(`detail   : ${r.detail}`);
    if (r.status === 'degraded') {
      console.error('投射未刷新（环境故障）—— 这不是"没有会话"');
      return 2;
    }
    return 0;
  } finally {
    await closeDb();
  }
}
