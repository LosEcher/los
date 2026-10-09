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
import { projectContextInjection, projectSessionCatalog, projectSessionPain } from '@los/agent';

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
    // 三个投影按依赖顺序：catalog 先跑（pain/injection 的 project_key 需要它已建）
    // —— 其实三者都各自解析 cwd，但先跑 catalog 能让"项目归属"先落库，便于对照。
    const r = await projectSessionCatalog({ aliasMap: aliasMap as never, currentRoot: CURRENT_ROOT });
    const pain = await projectSessionPain({ aliasMap: aliasMap as never, currentRoot: CURRENT_ROOT });
    const inj = await projectContextInjection({
      aliasMap: aliasMap as never, currentRoot: CURRENT_ROOT,
      sinceMs: Date.now() - 14 * 86400_000,
    });
    console.log(`catalog   : status=${r.status} sessions=${r.sessions} byState=${JSON.stringify(r.byState)}`);
    console.log(`pain      : status=${pain.status} rows=${pain.rows} ${pain.durationMs}ms`);
    console.log(`injection : status=${inj.status} rows=${inj.rows} ${inj.durationMs}ms`);
    console.log(`asOf      : ${r.asOf}`);
    for (const d of [r.detail, pain.detail, inj.detail]) if (d) console.log(`detail    : ${d}`);
    // 任一为 degraded ⇒ 明示"未刷新"，且**不是**"没有数据"
    if ([r.status, pain.status, inj.status].includes('degraded')) {
      console.error('投射未全部刷新（环境故障）—— 这不是"没有会话/没有痛点"');
      return 2;
    }
    return 0;
  } finally {
    await closeDb();
  }
}
