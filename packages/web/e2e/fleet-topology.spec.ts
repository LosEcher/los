import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 机队拓扑面板（消费 `GET /topology/fleet`）的端到端判据。
 *
 * 为什么要有 e2e（而不是只留纯函数测试）：布局投影的测试证明不了
 * "面板真的把它画出来、降级横幅真的在 DOM 里、请求真的带 operator 头"。
 * 三条关键断言：
 *   1. 三类节点与观测边都渲染出来（含"注册了但没跑过 ⇒ 无 边"的那一个）；
 *   2. **服务端的 degraded/warnings 必须出现在 DOM 里**（面板不许吞降级信号）；
 *   3. 取数走 operator 通道（请求头带 `x-los-operator-token`）——否则这条曲线在真实环境会 401。
 */

const AUTH_TOKEN = 'e2e-auth-token';
const OPERATOR_TOKEN = 'e2e-operator-token';
const AS_OF = '2026-10-12T11:39:18.779Z';
/** 故意超长的标签：用来断言"截断发生 + 完整名不溢出" */
const LONG_LABEL = 'registered-but-idle-with-a-very-long-hostname';

const FLEET = {
  nodes: [
    { id: 'gateway', kind: 'gateway', label: 'gateway', recordId: 'gateway', record: { localPlacement: { total: 73 } } },
    {
      id: 'mbp-executor-1', kind: 'executor', label: 'Echers-Mbp.local', recordId: 'mbp-executor-1',
      record: {
        status: 'online', hostLabel: 'Echers-Mbp.local',
        placement: { total: 370, succeeded: 300, failed: 20, blocked: 50, lastAt: AS_OF },
        execution: { candidate: true, blockers: [] },
        decision: { at: AS_OF, reason: 'executor_registry', hasSelectionEvidence: true },
      },
    },
    {
      id: 'idle-executor', kind: 'executor', label: LONG_LABEL, recordId: 'idle-executor',
      record: { status: 'online', placement: null, execution: { candidate: true, blockers: [] } },
    },
    {
      // 注册表里的 **SSH 运维库存**：不是执行面 ⇒ 单独一列、没有 dispatch 边。
      // （真实数据验证时抓到过缺陷：27 个 ssh_target 被当成执行器，图声称"36 个执行器"。）
      id: 'hh-sgp1-r-t', kind: 'ssh_target', label: 'hh-sgp1-r-t', recordId: 'hh-sgp1-r-t',
      record: { status: 'offline' },
    },
    {
      id: 'placement:gateway-local', kind: 'placement_only', label: 'gateway-local', recordId: 'placement:gateway-local',
      record: { rawNodeId: 'gateway-local', reason: 'gateway-local', placement: { total: 73 } },
    },
  ],
  edges: [
    { from: 'gateway', to: 'mbp-executor-1', kind: 'dispatch', label: '370 次' },
    { from: 'gateway', to: 'placement:gateway-local', kind: 'dispatch', label: '73 次' },
  ],
  counts: { gateway: 1, executor: 2, ssh_target: 1, placement_only: 1 },
  warnings: ['decisions truncated at limit=200: 窗口内命中 449 条，只取了最近 200 条'],
  degraded: { isDegraded: true, reasons: ['decisions truncated at limit=200: 窗口内命中 449 条，只取了最近 200 条'] },
  asOf: AS_OF,
  sources: [
    { id: 'executor_nodes', kind: 'store', asOf: AS_OF, detail: 'listExecutorNodes(limit=200) —— 注册表（声明面）' },
    { id: 'task_runs', kind: 'store', asOf: AS_OF, detail: 'task_runs.node_id 聚合（观测面）' },
    { id: 'scheduler_decisions', kind: 'store', asOf: AS_OF, detail: 'kind=executor_selection 窗口读，命中 449 条' },
  ],
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function isAsset(pathname: string): boolean {
  // Vite dev 的模块请求必须放行（否则整页起不来）：`/`、`/src/*`、`/node_modules/*`、`/@*`，
  // 以及任何带扩展名的资源。规则照抄仓内已验证的 e2e spec。
  return pathname === '/'
    || pathname.startsWith('/src/')
    || pathname.startsWith('/node_modules/')
    || pathname.startsWith('/@')
    || /\.[a-z0-9]+$/i.test(pathname);
}

/** 与 i18n-switcher.spec.ts 同口径：未知路径返回**对象**（不是数组），避免依赖它的页面炸掉。 */
function responseFor(path: string): unknown {
  if (path === '/settings') return { auth: { enabled: true }, agent: { maxLoops: 20 } };
  if (path === '/health') return { status: 'ok', uptime: 42 };
  if (path === '/onboarding') return { providers: [{ name: 'mock', provider: 'mock', defaultModel: 'mock-1', readiness: { ready: true } }] };
  if (path === '/projects') return { projects: [] };
  if (path === '/sessions') return [];
  if (path === '/memory/stats') return { totalObservations: 0 };
  if (path === '/skills' || path === '/rules' || path === '/todos') return [];
  if (path === '/services') return [{ serviceId: 'gateway-e2e', readiness: { ready: true } }];
  if (path === '/communication/accounts') return { channels: [{ id: 'web', status: 'live', live: true, accountCount: 0 }] };
  if (path === '/inbox') return { count: 0, results: [] };
  if (path === '/work-items') return { count: 0, results: [] };
  // ── 被测对象 ────────────────────────────────────────────────────────────
  if (path === '/topology/fleet') return FLEET;
  if (path === '/nodes') return [];
  if (path === '/ops/runtime-health') {
    // ⚠️ 形状必须够用：页面上的 FleetCard 会读 `fleet.attentionNodeIds`，
    // 缺字段会**整页崩**（无错误边界）⇒ 我的面板根本没机会渲染。这是 e2e 的第一教训。
    return {
      overall: 'ok',
      warnings: [],
      fleet: { namedIds: [], healthy: 0, offline: [], onlineUnverified: [], missing: [], attentionNodeIds: [] },
      fleetResources: { nodes: [], assessedAt: AS_OF },
    };
  }
  return { createdAt: AS_OF, updatedAt: AS_OF };
}

async function seedTokens(page: Page): Promise<void> {
  await page.addInitScript(({ auth, operator }) => {
    localStorage.setItem('los-auth-token', auth);
    localStorage.setItem('los-operator-token', operator);
  }, { auth: AUTH_TOKEN, operator: OPERATOR_TOKEN });
}

async function mockGateway(page: Page): Promise<Array<{ path: string; operator: string | undefined }>> {
  const records: Array<{ path: string; operator: string | undefined }> = [];
  await page.routeWebSocket('**/sessions/*/stream', socket => socket.close());
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' || isAsset(url.pathname)) {
      await route.continue();
      return;
    }
    records.push({ path: url.pathname, operator: request.headers()['x-los-operator-token'] });
    await json(route, responseFor(url.pathname));
  });
  return records;
}

test('fleet topology panel renders registry vs observation, degraded banner and node detail', async ({ page }) => {
  await seedTokens(page);
  const records = await mockGateway(page);
  await page.goto('/#nodes');

  const panel = page.locator('.fleet-topology');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Fleet topology', { exact: false }).first()).toBeVisible();

  // 统计口径：节点/边数来自布局投影（3 节点 = 2 executor + 1 gateway；边只画有观测的那两条）
  await expect(panel.locator('.fleet-topology-head')).toContainText('5 nodes');
  await expect(panel.locator('.fleet-topology-head')).toContainText('2 observed edges');

  // 声明 vs 观测：注册了但没跑过的节点在图上、但没有边。
  // 用 SVG 标签数组断言而不是 getByText：后者会同时命中 <text>/<title>/<g>，
  // 在严格模式下解析到多个元素（其中 <title> 不是"可见"元素）。
  await expect(panel.locator('.fleet-topology-node')).toHaveCount(5);
  const nodeLabels = await panel.locator('.fleet-topology-node-label').allTextContents();
  expect(nodeLabels).toContain('Echers-Mbp.local');
  // 长标签必须被截断（出现截断标记）且完整名**不得**原样出现（不溢出列宽）。
  // 断言不写死截断长度：那是布局模块的实现细节，这里只测"截断真的发生"。
  expect(nodeLabels.some(l => l.endsWith('…'))).toBe(true);
  expect(nodeLabels).not.toContain(LONG_LABEL);
  expect(nodeLabels).toContain('hh-sgp1-r-t');

  // 声明面内部也要分开：SSH 运维库存自成一列，且**不得**被算成执行器
  await expect(panel.locator('.fleet-topology-col-label')).toContainText([
    'gateway (1)', 'registered executors (2)', 'SSH ops inventory (1, not execution surface)', 'observed-only targets (1)',
  ]);

  // **降级必须可见**（面板不许吞服务端的 degraded）
  const degraded = panel.locator('.fleet-topology-degraded');
  await expect(degraded).toBeVisible();
  await expect(degraded).toContainText('decisions truncated at limit=200');
  await expect(degraded).toContainText('This graph is incomplete');

  // 点节点看详情：落点观测与阻塞
  await panel.locator('.fleet-topology-node', { hasText: 'Echers-Mbp.local' }).click();
  const detail = panel.locator('.fleet-topology-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('370');
  await expect(detail).toContainText('succeeded 300');
  await expect(detail).toContainText('executor_registry');

  // 取数出处可追溯
  await panel.locator('.fleet-topology-sources summary').click();
  await expect(panel.locator('.fleet-topology-sources')).toContainText('scheduler_decisions');

  // 走的是 operator 通道（否则真实环境 401/403）
  const fleetCalls = records.filter(r => r.path === '/topology/fleet');
  expect(fleetCalls.length).toBeGreaterThan(0);
  expect(fleetCalls.every(r => r.operator === OPERATOR_TOKEN)).toBe(true);
});
