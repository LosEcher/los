#!/usr/bin/env node
/**
 * check-route-admission.mjs — 网关 HTTP 路由准入面的机械门禁。
 *
 * 依据：ADR 0048（路由准入分类与读模型作用域）决策 1；
 *       多设备机制审计的可迁移项 D3（默认拒绝由枚举结构保证 + 把"永不允许"的类别
 *       固化成可执行的全表扫描不变式）与 D3b（声明与执行必须一致）。
 *
 * 为什么需要它：
 *   网关有 265 处路由注册，但"每条路由对谁开放"是**散落在注册点的隐含事实**。
 *   实践中的后果是三类静默：新增路由没人分类、声明了 operator 却没真的执行门禁、
 *   以及"任何已认证的非 operator 主体可写"的路由无人送审。
 *   本脚本把这三件事变成可机械核查的事实。
 *
 * 三个门禁：
 *   G1 完备性（集合相等）：源码里的每一条路由都必须在 route-admission-inventory.txt 中，
 *      反向也必须成立。新增路由未登记 ⇒ 失败（diff 里看得见一条新行）。
 *   G2 送审名单（棘轮）：**变更类方法（POST/PUT/PATCH/DELETE）且不在 operator 门禁文件里、
 *      也不是公开路径**的路由，必须出现在 route-admission-review.txt 中。
 *      未登记的这类路由 ⇒ 失败。名单里的条目不再命中 ⇒ 提示收缩（名单只减不增）。
 *   G3 声明与执行一致：被登记为 operator-gated 的判定来自"该文件是否真的调用 requireOperator"，
 *      因此判定与源码同源；若某文件删掉了 requireOperator，G1/G2 会因集合变化而失败。
 *
 * 粒度：operator 归属**逐路由**判定——一条路由的"处理体"取其注册行到下一处注册行之前，
 *   窗口内出现 `requireOperator` 即判定有门禁（本仓路由处理器都是内联的，见 scanRoutes 注释）。
 *   刻意不用文件级：文件级会漏掉"同文件另一个路由有门禁、本路由没有"的可写路由。
 *
 * 用法：
 *   node tools/check-route-admission.mjs                 # 校验
 *   node tools/check-route-admission.mjs --report        # 打印当前面（含分类计数）
 *   node tools/check-route-admission.mjs --update-inventory
 *   node tools/check-route-admission.mjs --update-review
 *   node tools/check-route-admission.mjs --self-test     # 负向控制（纯函数）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GATEWAY_SRC = join(ROOT, 'packages/gateway/src');
const AUTH_MIDDLEWARE = join(GATEWAY_SRC, 'auth-middleware.ts');
const INVENTORY_FILE = join(HERE, 'route-admission-inventory.txt');
const REVIEW_FILE = join(HERE, 'route-admission-review.txt');
const OPERATOR_REQUIRED_FILE = join(HERE, 'route-admission-operator-required.txt');
const EMBEDDED_MODULE = join(ROOT, 'packages/gateway/src/route-admission-inventory.ts');

/** Content of the generated runtime module. Deterministic: same input ⇒ byte-identical output. */
export function renderEmbeddedModule(keys) {
  return (
    '/**\n' +
    ' * 网关路由清单（生成物，勿手改）。\n' +
    ' *\n' +
    ' * 生成：`node tools/check-route-admission.mjs --update-embedded`\n' +
    ' * 门禁：`tools/check-route-admission.mjs` 会断言"重新生成 == 磁盘内容"（无 diff），\n' +
    ' *       因此新增/删除路由若不重新生成，CI 直接失败。\n' +
    ' * 用途：`route-admission-guard.ts` 在启动期把真实注册表与本清单对账（ADR 0048 决策 2）。\n' +
    ' */\n' +
    '\n' +
    'export function admissionRouteKeys(): readonly string[] {\n' +
    '  return [\n' +
    keys.map((k) => `    '${k}',`).join('\n') +
    '\n  ];\n' +
    '}\n'
  );
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE_LITERAL = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/;

/**
 * 自证端点：用**非用户主体**的凭证自证，因此「任何已认证的非 operator 主体都能调用」这条
 * 判据对它们不成立，不该进送审名单。但它们仍必须**可见**（check 时打印），因为其中一条的
 * 保证是条件性的。
 */
export const SELF_AUTHENTICATED_PATHS = new Map([
  [
    'POST /nodes/heartbeat',
    'Bearer executor agentKey（file:packages/gateway/src/auth-middleware.ts:38）。' +
      '条件性：config.executor.agentKey 未配置时该分支不生效，请求会退化为通用鉴权 ⇒ 那时 user 主体可写。',
  ],
  [
    'POST /nodes/enroll',
    '一次性 enrollment token 兑换（token 自证，见 file:packages/gateway/src/routes/infrastructure/node-routes.ts:109）。',
  ],
  [
    'POST /nodes/credential/rotate',
    '`x-los-node-credential` 自证：用当前凭据换新凭据，旧值留 24h 重叠窗口（见 file:packages/agent/src/node-enrollment.ts:rotateNodeCredential）。',
  ],
  [
    'POST /tasks/:id/agent-tasks/:agentTaskId/heartbeat',
    '`x-los-task-token`（HMAC，绑定 taskRunId + leaseVersion + exp）；handler 还校验 agent task 的 running attempt 属于该 task run。' +
      '自证且 fail-closed：验不过即 401/403/409。',
  ],
  [
    'POST /tasks/:id/heartbeat',
    '`x-los-task-token`（HMAC，绑定 taskRunId + leaseVersion + exp，见 file:packages/gateway/src/task-token.ts）。' +
      '自证且 fail-closed：验不过即 401，普通已认证主体也进不来。',
  ],
]);

// ── 纯函数区（可被 --self-test 直接覆盖，不碰文件系统）────────────────────

/** 从 auth-middleware.ts 文本解析公开面。单一真源：公开面由该文件定义，本脚本不另立一份。 */
export function parsePublicSurfaces(source) {
  const readStringArray = (name) => {
    const m = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`, 's'));
    if (!m) return [];
    return [...m[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
  };
  const exactMatch = source.match(/const\s+EXACT_PUBLIC_PATHS\s*=\s*new Set\(\[([^\]]*)\]/s);
  const exact = exactMatch
    ? [...exactMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1])
    : [];
  const methodMatch = source.match(/const\s+METHOD_PUBLIC_PATHS[^=]*=\s*\{([\s\S]*?)\n\};/);
  const methodScoped = [];
  if (methodMatch) {
    for (const entry of methodMatch[1].matchAll(/['"`]([^'"`]+)['"`]\s*:\s*new Set\(\[([^\]]*)\]/g)) {
      const path = entry[1];
      const methods = [...entry[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
      methodScoped.push({ path, methods });
    }
  }
  return { exact, prefixes: readStringArray('PREFIX_PUBLIC_PATHS'), methodScoped };
}

/** 复刻 auth-middleware 的 isPublicPath 语义（同一份公开面常量）。 */
export function isPublicPath(surfaces, method, path) {
  if (surfaces.exact.includes(path)) return true;
  const scoped = surfaces.methodScoped.find((s) => s.path === path);
  if (scoped && scoped.methods.includes(method)) return true;
  return surfaces.prefixes.some((p) => path.startsWith(p));
}

/** 单条路由的准入分类。operator 归属逐路由判定（见 scanRoutes 的窗口规则）。 */
export function classifyRoute(surfaces, route) {
  if (isPublicPath(surfaces, route.method, route.path)) return 'public';
  if (SELF_AUTHENTICATED_PATHS.has(`${route.method} ${route.path}`)) return 'self-authenticated';
  if (route.hasOperatorGate) return 'operator';
  return 'authenticated';
}

/** 正则式路由（`:id`）与字面量路由的公共形态：用于集合比较时保持原样。 */
export function routeKey(route) {
  return `${route.method} ${route.path}`;
}

/** G2 的判定：变更类 + 非 operator 文件 + 非公开 ⇒ 必须送审。 */
export function requiresReview(surfaces, route) {
  if (!MUTATING.has(route.method)) return false;
  return classifyRoute(surfaces, route) === 'authenticated';
}

/** 集合差异，用于生成可读的失败信息。 */
export function diffSets(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: [...e].filter((x) => !a.has(x)).sort(),
    extra: [...a].filter((x) => !e.has(x)).sort(),
  };
}

/** 解析 committed 名单（支持 `#` 注释与空行；取首列作为键）。 */
export function parseList(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t')[0].trim());
}

export function serializeList(keys, header) {
  const uniq = [...new Set(keys)].sort();
  return `${header}\n${uniq.join('\n')}\n`;
}

// ── 源码扫描 ──────────────────────────────────────────────────────────────

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.tsx?$/.test(full)) continue;
    if (/\.test\.tsx?$/.test(full) || full.endsWith('.d.ts')) continue;
    yield full;
  }
}

/**
 * 逐路由判定 operator 门禁。
 *
 * 窗口规则：一条路由的"处理体"取**从它自己的注册行到下一处注册行之前**（文件末尾则到 EOF）。
 * 本仓的路由处理器都是内联的（`app.post('/x', async (req, reply) => { … })`），所以这个窗口
 * 恰好等于该路由的处理体。窗口内出现 `requireOperator` ⇒ 该路由有门禁。
 *
 * 为什么不用文件级：文件级会把"同文件里另一个路由有门禁"误判成本路由也有门禁，
 * 从而在送审名单里**漏掉**真正可写的路由——那正是本门禁要防的事。
 */
export function scanRoutes(root = ROOT) {
  const src = join(root, 'packages/gateway/src');
  const routes = [];
  let registrationSites = 0;
  let files = 0;
  for (const file of sourceFiles(src)) {
    files += 1;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    registrationSites += (text.match(/app\.(get|post|put|patch|delete)\(/g) || []).length;

    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ROUTE_LITERAL);
      if (m) hits.push({ method: m[1].toUpperCase(), path: m[2], line: i + 1, index: i });
    }
    for (let h = 0; h < hits.length; h++) {
      const start = hits[h].index;
      const end = h + 1 < hits.length ? hits[h + 1].index : lines.length;
      const body = lines.slice(start, end).join('\n');
      routes.push({
        method: hits[h].method,
        path: hits[h].path,
        file: relative(root, file),
        line: hits[h].line,
        hasOperatorGate: /requireOperator/.test(body),
      });
    }
  }
  return { routes, registrationSites, files };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const surfaces = parsePublicSurfaces(readFileSync(AUTH_MIDDLEWARE, 'utf8'));
  const { routes, registrationSites, files } = scanRoutes();

  // 扫描器自证：注册点数必须等于解析出的路由数，否则有注册形式没被覆盖。
  if (registrationSites !== routes.length) {
    console.error(
      `check-route-admission FAIL: ${registrationSites} registration site(s) but ${routes.length} parsed route(s).\n` +
        '  A registration form is not covered by the scanner (multi-line literal or dynamic path).\n' +
        '  Extend ROUTE_LITERAL / scanRoutes before trusting this gate.',
    );
    process.exit(1);
  }

  const classified = routes.map((r) => ({ ...r, admission: classifyRoute(surfaces, r) }));
  const inventoryKeys = classified.map(routeKey);
  const reviewKeys = classified.filter((r) => requiresReview(surfaces, r)).map(routeKey);

  if (argv.includes('--report')) {
    const counts = classified.reduce((acc, r) => ((acc[r.admission] = (acc[r.admission] || 0) + 1), acc), {});
    console.log(`files=${files} routes=${routes.length} registrationSites=${registrationSites}`);
    console.log(`admission: ${JSON.stringify(counts)}`);
    console.log(`review candidates (mutating + authenticated): ${reviewKeys.length}`);
    for (const [key, why] of SELF_AUTHENTICATED_PATHS) {
      const present = inventoryKeys.includes(key);
      console.log(`self-authenticated${present ? '' : ' (NOT REGISTERED)'}: ${key}\n    ${why}`);
    }
    return;
  }

  if (argv.includes('--update-inventory')) {
    writeFileSync(
      INVENTORY_FILE,
      serializeList(
        inventoryKeys,
        '# 网关路由清单（生成物，勿手改）— 由 tools/check-route-admission.mjs --update-inventory 生成\n' +
          '# 依据 ADR 0048。新增路由必须让本文件出现一行新条目，否则 G1 失败。\n' +
          '# 格式：<METHOD> <path>',
      ),
    );
    console.log(`updated ${relative(ROOT, INVENTORY_FILE)} (${inventoryKeys.length} routes)`);
  }

  if (argv.includes('--update-embedded') || argv.includes('--update-inventory')) {
    const uniq = [...new Set(inventoryKeys)].sort();
    writeFileSync(EMBEDDED_MODULE, renderEmbeddedModule(uniq));
    console.log(`updated ${relative(ROOT, EMBEDDED_MODULE)} (${uniq.length} routes)`);
  }

  if (argv.includes('--update-review')) {
    writeFileSync(
      REVIEW_FILE,
      serializeList(
        reviewKeys,
        '# 送审名单（棘轮：只减不增）— 由 tools/check-route-admission.mjs --update-review 生成\n' +
          '# 含义：变更类方法 + 所属文件无 requireOperator + 不是公开路径\n' +
          '#       ⇒ 任何已认证的非 operator 主体都可调用。逐条收紧是 ADR 0048 的 B2 工作。\n' +
          '# 格式：<METHOD> <path>',
      ),
    );
    console.log(`updated ${relative(ROOT, REVIEW_FILE)} (${reviewKeys.length} routes)`);
  }

  if (argv.includes('--update-operator-required')) {
    const operatorKeys = classified.filter((r) => r.admission === 'operator').map(routeKey);
    writeFileSync(
      OPERATOR_REQUIRED_FILE,
      serializeList(
        operatorKeys,
        '# operator 门禁清单（锁定当前 operator 面）— 由 --update-operator-required 生成\n' +
          '# 含义：这些路由**必须**保持 operator 门禁。任何一条被移除门禁（requireOperator 从\n' +
          '#       其处理体消失）都会让 G4 失败——因为"声明 operator 却不再执行门禁"是本门禁\n' +
          '#       要防的静默退化（ADR 0048 决策 2）。\n' +
          '# 新增收紧：给路由加 requireOperator 后运行本模式把它登记进来。\n' +
          '# 格式：<METHOD> <path>',
      ),
    );
    console.log(`updated ${relative(ROOT, OPERATOR_REQUIRED_FILE)} (${operatorKeys.length} routes)`);
  }

  if (
    argv.includes('--update-inventory') ||
    argv.includes('--update-review') ||
    argv.includes('--update-embedded') ||
    argv.includes('--update-operator-required')
  ) {
    return;
  }

  if (!existsSync(INVENTORY_FILE) || !existsSync(REVIEW_FILE) || !existsSync(OPERATOR_REQUIRED_FILE)) {
    console.error(
      'check-route-admission FAIL: inventory/review/operator-required file missing.\n' +
        '  Generate with: node tools/check-route-admission.mjs --update-inventory --update-review --update-operator-required',
    );
    process.exit(1);
  }

  const problems = [];
  const warnings = [];

  // G1 完备性
  const committedInventory = parseList(readFileSync(INVENTORY_FILE, 'utf8'));
  const inv = diffSets(inventoryKeys, committedInventory);
  for (const k of inv.extra) {
    problems.push(
      `G1 unregistered route: ${k}\n    A route exists in source but not in route-admission-inventory.txt.\n` +
        '    Register it (and classify it) rather than regenerating blindly:\n' +
        '      node tools/check-route-admission.mjs --update-inventory',
    );
  }
  for (const k of inv.missing) problems.push(`G1 stale inventory entry: ${k} (route no longer registered)`);

  // G2 送审名单（棘轮）
  const committedReview = new Set(parseList(readFileSync(REVIEW_FILE, 'utf8')));
  const unlisted = reviewKeys.filter((k) => !committedReview.has(k)).sort();
  for (const k of unlisted) {
    problems.push(
      `G2 unreviewed writable route: ${k}\n` +
        '    Mutating method, no requireOperator in its file, not a public path ⇒ any\n' +
        '    authenticated non-operator principal can call it.\n' +
        '    Either add the operator gate, or record it in route-admission-review.txt with a reason.',
    );
  }
  const stale = [...committedReview].filter((k) => !reviewKeys.includes(k)).sort();
  if (stale.length > 0) {
    warnings.push(
      `G2 review list can shrink by ${stale.length} entr(y|ies) (ratchet: only shrinks): ${stale.slice(0, 5).join(', ')}` +
        `${stale.length > 5 ? ', …' : ''}\n    Run: node tools/check-route-admission.mjs --update-review`,
    );
  }

  // G4 operator 门禁锁定：清单里的路由一旦失去 requireOperator 即失败。
  // 这是"声明 operator 却不再执行门禁"的机械防线（ADR 0048 决策 2）。
  const operatorSet = new Set(classified.filter((r) => r.admission === 'operator').map(routeKey));
  const requiredOperator = parseList(readFileSync(OPERATOR_REQUIRED_FILE, 'utf8'));
  const lostGate = requiredOperator.filter((k) => !operatorSet.has(k)).sort();
  for (const k of lostGate) {
    problems.push(
      `G4 operator gate removed: ${k}\n` +
        '    This route is on the operator-required list but its handler no longer calls\n' +
        '    requireOperator ⇒ any authenticated non-operator principal can reach it again.\n' +
        '    Restore the gate, or — if the relaxation is deliberate — remove the entry from\n' +
        '    route-admission-operator-required.txt and justify it in the change description.',
    );
  }

  // G5 生成物无 diff：运行期模块必须与源码扫描结果逐字节一致。
  // 这是"一源多目标 + 生成物无 diff"纪律（参考实现审计模式 7），保证
  // route-admission-guard 在启动期对账用的清单不会与真实注册表漂移。
  if (!existsSync(EMBEDDED_MODULE)) {
    problems.push(
      `G5 generated module missing: ${relative(ROOT, EMBEDDED_MODULE)}\n` +
        '    Run: node tools/check-route-admission.mjs --update-embedded',
    );
  } else {
    const expectedModule = renderEmbeddedModule([...new Set(inventoryKeys)].sort());
    const actualModule = readFileSync(EMBEDDED_MODULE, 'utf8');
    if (actualModule !== expectedModule) {
      problems.push(
        `G5 generated module is out of date: ${relative(ROOT, EMBEDDED_MODULE)}\n` +
          '    The runtime route list no longer matches the scanned sources. A route was added,\n' +
          '    removed or renamed without regenerating it.\n' +
          '    Run: node tools/check-route-admission.mjs --update-embedded --update-inventory',
      );
    }
  }

  for (const w of warnings) console.warn(`  [WARN] ${w}`);
  if (problems.length > 0) {
    console.error(`check-route-admission FAIL: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `check-route-admission OK: ${routes.length} routes (${reviewKeys.length} in review list, ` +
      `${routes.length - reviewKeys.length} gated/public/self-authenticated, ` +
      `${operatorSet.size} operator-locked), inventory set-equal, review ratchet holds`,
  );
}

// ── 负向控制 ──────────────────────────────────────────────────────────────

function selfTest() {
  const surfaces = parsePublicSurfaces(readFileSync(AUTH_MIDDLEWARE, 'utf8'));
  const results = [];
  const check = (name, cond) => results.push({ name, ok: !!cond });

  // 1. 公开面解析到了 auth-middleware 的真实条目（不是空集假通过）
  check('public surfaces parsed', surfaces.prefixes.includes('/auth/login') && surfaces.exact.includes('/'));

  // 2. 公开路径被正确分类
  check(
    'public route classified public',
    classifyRoute(surfaces, { method: 'POST', path: '/auth/login', hasOperatorGate: false }) === 'public',
  );

  // 3. 无门禁的变更类路由被判为需送审（G2 的核心判据）
  check(
    'ungated mutating route requires review',
    requiresReview(surfaces, { method: 'POST', path: '/invented/new-write', hasOperatorGate: false }) === true,
  );

  // 4. 有 operator 门禁的路由不需要送审
  check(
    'operator-gated route not in review list',
    requiresReview(surfaces, { method: 'POST', path: '/invented/new-write', hasOperatorGate: true }) === false,
  );

  // 5. 只读方法不进送审名单
  check(
    'read method never requires review',
    requiresReview(surfaces, { method: 'GET', path: '/invented/read', hasOperatorGate: false }) === false,
  );

  // 5b. 自证端点（executor agentKey / enrollment token）不进送审名单，但必须可见
  check(
    'self-authenticated route not in review list',
    requiresReview(surfaces, { method: 'POST', path: '/nodes/heartbeat', hasOperatorGate: false }) === false &&
      SELF_AUTHENTICATED_PATHS.size >= 2,
  );

  // 6. 集合差异能同时抓"缺"与"多"
  const d = diffSets(['A', 'B'], ['B', 'C']);
  check('diffSets catches both directions', d.extra.length === 1 && d.missing.length === 1);

  // 7. 名单解析忽略注释与空行
  check('parseList ignores comments/blanks', parseList('# c\n\nGET /a\tfile.ts\n').length === 1);

  // 8. 扫描器覆盖：真实仓库里注册点数 == 解析路由数（防止注册形式漏扫）
  const { routes, registrationSites } = scanRoutes();
  check('scanner covers every registration site', registrationSites === routes.length && routes.length > 200);

  // 9. G4：清单里的路由一旦不在 operator 集合里必须被抓出（防"移除门禁"静默退化）
  const g4Lost = ['GET /a', 'POST /b'].filter((k) => !new Set(['GET /a']).has(k));
  check('G4 catches a removed operator gate', g4Lost.length === 1 && g4Lost[0] === 'POST /b');

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (failed.length > 0) {
    console.error(`check-route-admission --self-test FAILED (${failed.length}/${results.length})`);
    process.exit(1);
  }
  console.log(`check-route-admission --self-test OK (${results.length}/${results.length})`);
}

main();
