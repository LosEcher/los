#!/usr/bin/env node
/**
 * model-route-truth.mjs — 「配置的模型」vs「实际生效的模型」对照表（只读）。
 *
 * 依据：ADR 0047 第 2 节（三个 provider 决策中心）+ 判据 J8。
 * J8 要求每次"路由/模型"结论必须给三件：
 *   ① 配置路径与值  ② **该工具的路由 owner**  ③ 实际生效证据
 * 三者不一致即**冲突**，必须显式报冲突而非择一。
 *
 * 三个决策中心（各自成立，不合并）：
 *   A. cc-switch（桌面工具：claude/codex/gemini/grokbuild）—— 读它的 DB，**只读不写**
 *   B. DSH 自己（会话宿主）—— `agent-default-model` + `dsh-llm-fallbacks`
 *   C. los gateway（agent / headless / 治理）—— `~/.los/config.yaml` + provider-defaults
 *
 * 输出：每个工具一行 { owner, declared, live, verdict }。
 * verdict ∈ { consistent, conflict, unverified, not-configured }
 *   - consistent  : 声明的上游与可验证的生效证据一致
 *   - conflict    : 二者不一致 ⇒ **非零退出**（--check）
 *   - unverified  : 缺证据（例如 GUI 未运行、DB 不可读）⇒ 不算冲突，但必须显式报"未验证"
 *   - not-configured: 该工具未配置路由
 *
 * 纪律：**只读**；值一律脱敏（api key/token/secret 只显示 `<redacted>`）。
 * 用法：
 *   node tools/model-route-truth.mjs [--json] [--check]
 *   node tools/model-route-truth.mjs --self-test   # 负向控制（纯函数，不读真机）
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const CC_SWITCH_DB = join(HOME, '.cc-switch', 'cc-switch.db');
const CC_SWITCH_LIVE = join(HOME, '.cc-switch', 'live-state.json');
const CODEX_CONFIG = join(HOME, '.codex', 'config.toml');
const GROK_CONFIG = join(HOME, '.grok', 'config.toml');
const CLAUDE_SETTINGS = join(HOME, '.claude', 'settings.json');
const DSH_DESKTOP_PATCH = join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const DSH_WEB_PATCH = join(HOME, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
const LOS_CONFIG = join(HOME, '.los', 'config.yaml');

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|auth)/i;

/** 脱敏：任何 key 名含 key/token/secret/password/auth 的值一律替换。 */
export function redact(obj, depth = 0) {
  if (depth > 6) return '<depth-limit>';
  if (Array.isArray(obj)) return obj.map(v => redact(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SECRET_KEY_RE.test(k) ? '<redacted>' : redact(v, depth + 1);
    }
    return out;
  }
  return obj;
}

/** 从 TOML 文本里取赋值（极简，只处理 key = "value" 形式，足够本用途）。 */
export function tomlValue(text, key, section = null) {
  let scope = text;
  if (section) {
    const m = text.match(new RegExp(`\\[${section.replace(/[.[\]]/g, '\\$&')}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
    if (!m) return null;
    scope = m[1];
  }
  const m = scope.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

/** 从 YAML 文本里取 `agent-default-model` 的 provider/model（极简缩进解析）。 */
export function dshDefaultModel(patchText) {
  const block = patchText.match(/- id: agent-default-model[\s\S]*?(?=\n- id:|\s*$)/);
  if (!block) return null;
  const provider = block[0].match(/^\s*provider:\s*(\S+)/m)?.[1] ?? null;
  const model = block[0].match(/^\s*model:\s*(\S+)/m)?.[1] ?? null;
  return provider || model ? { provider, model } : null;
}

/** dsh-llm-fallbacks 是否启用、root chain 尾部是否有值。 */
export function dshFallbacks(patchText) {
  const block = patchText.match(/- id: llm-fallbacks[\s\S]*?(?=\n- id:|\s*$)/);
  if (!block) return { present: false, rulesEmpty: null };
  const rulesEmpty = /^\s*rules:\s*\[\]\s*$/m.test(block[0]);
  return { present: true, rulesEmpty };
}

/** 探测本地端口是否有监听（只读；用 lsof，不发起业务请求）。 */
export function listenerOn(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000,
    });
    const line = out.split('\n')[1];
    return line ? line.split(/\s+/)[0] : null;   // 进程名
  } catch { return null; }
}

/** 从 session-index.db 取指定窗口内各模型的真实请求数（= 实际生效证据）。 */
export function observedModels(days = 14) {
  const db = join(HOME, '.dsh', 'storages', 'session-index.db');
  if (!existsSync(db)) return null;
  const cutoff = Date.now() - days * 86400_000;
  const out = trySqlite(
    `SELECT name || '|' || count(*) FROM events WHERE kind='request/header' AND ts > ${cutoff} GROUP BY name ORDER BY count(*) DESC LIMIT 8;`,
    db);
  if (!out) return null;
  return out.split('\n').filter(Boolean).map(l => {
    const [name, n] = l.split('|');
    const provider = name.includes('/') ? name.split('/')[0] : name;
    return { name, provider, count: Number(n) };
  });
}

function trySqlite(sql, db = CC_SWITCH_DB) {
  if (!existsSync(db)) return null;
  try {
    // 不加 -readonly：对缺失 -shm 的 WAL 库会以 (14) 失败（只跑 SELECT，不写）。
    // cc-switch.db 是 rollback-journal 模式，加不加都能读；统一去掉以免混淆。
    return execFileSync('sqlite3', [db, sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    }).trim();
  } catch { return null; }
}

/** 采集三个决策中心的声明与证据。所有读取都容错（缺失 → null + 原因）。 */
export function collect() {
  const rows = [];
  const notes = [];

  // ── A. cc-switch（桌面工具）──
  let live = null;
  if (existsSync(CC_SWITCH_LIVE)) {
    try { live = JSON.parse(readFileSync(CC_SWITCH_LIVE, 'utf8')); } catch { /* ignore */ }
  }
  const csProviders = trySqlite(
    "SELECT app_type || '|' || name || '|' || is_current FROM providers ORDER BY app_type, is_current DESC;");
  const csByApp = {};
  if (csProviders) {
    for (const line of csProviders.split('\n').filter(Boolean)) {
      const [app, name, cur] = line.split('|');
      (csByApp[app] ??= []).push({ name, current: cur === '1' });
    }
  }
  const csProxy = trySqlite("SELECT app_type || '|' || listen_port || '|' || enabled || '|' || proxy_enabled FROM proxy_config;");
  const proxyByApp = {};
  if (csProxy) {
    for (const line of csProxy.split('\n').filter(Boolean)) {
      const [app, port, en, pe] = line.split('|');
      proxyByApp[app] = { port: Number(port), enabled: en === '1', proxyEnabled: pe === '1' };
    }
  }

  for (const app of ['claude', 'codex', 'gemini', 'grokbuild']) {
    const active = (csByApp[app] ?? []).find(p => p.current);
    const mode = live?.apps?.[app]?.mode ?? null;
    const proxy = proxyByApp[app] ?? null;
    rows.push({
      tool: app,
      owner: 'cc-switch (GUI, :15721)',
      declared: active ? active.name : null,
      declaredSource: active ? '~/.cc-switch/cc-switch.db providers.is_current' : null,
      live: mode ? `mode=${mode}${proxy ? ` port=${proxy.port} enabled=${proxy.enabled} proxy=${proxy.proxyEnabled}` : ''}` : null,
      liveSource: live ? '~/.cc-switch/live-state.json' : null,
      verdict: active ? (mode ? 'consistent' : 'unverified') : 'not-configured',
    });
  }
  // 桌面工具的"生效证据"来自它们各自的 config（下面逐个覆盖 declared/live）

  // ── B. DSH（会话宿主）──
  let dshPatch = null;
  for (const p of [DSH_DESKTOP_PATCH, DSH_WEB_PATCH]) {
    if (existsSync(p)) { dshPatch = readFileSync(p, 'utf8'); rows[0] && notes.push(`DSH patch: ${p}`); break; }
  }
  const dshModel = dshPatch ? dshDefaultModel(dshPatch) : null;
  const dshFb = dshPatch ? dshFallbacks(dshPatch) : { present: false, rulesEmpty: null };
  const losGatewayDeclared = dshPatch && /los-gateway:/.test(dshPatch);
  rows.push({
    tool: 'DSH (desktop)',
    owner: 'DSH itself (agent-default-model + dsh-llm-fallbacks)',
    declared: dshModel ? `${dshModel.provider}/${dshModel.model}` : null,
    declaredSource: existsSync(DSH_DESKTOP_PATCH) ? '~/.dsh/profiles/desktop/cordis.patch.yml agent-default-model' : null,
    live: `los-gateway provider configured=${losGatewayDeclared}, fallbacks present=${dshFb.present} rulesEmpty=${dshFb.rulesEmpty}`,
    liveSource: 'same profile patch (los-gateway block + llm-fallbacks block)',
    verdict: dshModel ? 'consistent' : 'not-configured',
  });

  // ── A 的生效证据：各桌面工具自己的 config ──
  const codexBase = existsSync(CODEX_CONFIG) ? tomlValue(readFileSync(CODEX_CONFIG, 'utf8'), 'base_url', 'model_providers.custom') : null;
  const codexModel = existsSync(CODEX_CONFIG) ? tomlValue(readFileSync(CODEX_CONFIG, 'utf8'), 'model') : null;
  const grokBase = existsSync(GROK_CONFIG) ? tomlValue(readFileSync(GROK_CONFIG, 'utf8'), 'models_base_url', 'endpoints') : null;
  const grokModel = existsSync(GROK_CONFIG) ? tomlValue(readFileSync(GROK_CONFIG, 'utf8'), 'default', 'models') : null;
  let claudeBase = null;
  if (existsSync(CLAUDE_SETTINGS)) {
    try { claudeBase = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))?.env?.ANTHROPIC_BASE_URL ?? null; } catch { /* ignore */ }
  }

  const effective = {
    codex: codexBase ? `base_url=${codexBase} model=${codexModel ?? '?'}` : null,
    grokbuild: grokBase ? `models_base_url=${grokBase} default=${grokModel ?? '?'}` : null,
    claude: claudeBase ? `ANTHROPIC_BASE_URL=${claudeBase}` : null,
  };
  // 真判据：proxy 模式下 config 指向本地端口是**正确形态**；一致性取决于
  // (a) proxy 是否真的在监听，(b) 该工具的 live mode 是否为 proxy。
  // direct 模式下 config 必须直接指向 cc-switch 声明的上游。
  for (const row of rows) {
    const eff = effective[row.tool];
    if (!eff) continue;
    row.effective = eff;
    row.effectiveSource = row.tool === 'codex' ? '~/.codex/config.toml'
      : row.tool === 'grokbuild' ? '~/.grok/config.toml'
      : row.tool === 'claude' ? '~/.claude/settings.json'
      : null;
    const port = proxyByApp[row.tool]?.port;
    const mode = live?.apps?.[row.tool]?.mode ?? null;
    row.proxyListener = port ? listenerOn(port) : null;
    if (mode === 'proxy') {
      const pointsLocal = port ? String(eff).includes(`:${port}`) : false;
      row.verdict = pointsLocal
        ? (row.proxyListener ? 'consistent' : 'conflict')   // proxy 模式但端口无监听 ⇒ 真冲突
        : 'conflict';                                        // proxy 模式却没指向 proxy ⇒ 真冲突
      if (row.verdict === 'conflict' && !row.proxyListener) {
        row.conflictReason = `declared mode=proxy but nothing is listening on :${port}`;
      }
    } else if (mode === 'direct') {
      // direct：config 必须自洽（有 base_url/model 且不指向本地 proxy 端口）
      const pointsLocal = port ? String(eff).includes(`:${port}`) : false;
      row.verdict = pointsLocal ? 'conflict' : 'consistent';
    }
  }

  // 实际流量观测（DSH 会话的 model 名）—— 用于与 DSH 声明值对照
  const observed = observedModels(14);
  const dshRow = rows.find(r => r.tool === 'DSH (desktop)');
  if (dshRow && observed) {
    const top = observed[0];
    dshRow.observedTraffic = observed.map(o => `${o.name}×${o.count}`).join(', ');
    const declaredProvider = dshRow.declared?.split('/')[0] ?? null;
    dshRow.verdict = declaredProvider && top?.provider === declaredProvider ? 'consistent' : 'conflict';
    if (dshRow.verdict === 'conflict') {
      dshRow.conflictReason = `declared provider=${declaredProvider} but top observed traffic is ${top?.provider}`;
    }
  }

  // ── C. los gateway ──
  let losDeclared = null;
  let losFallbacks = null;
  if (existsSync(LOS_CONFIG)) {
    const t = readFileSync(LOS_CONFIG, 'utf8');
    losDeclared = (t.match(/^\s*([a-z0-9-]+):\s*$/gm) ?? []).length ? 'providers declared in ~/.los/config.yaml' : null;
    const fb = t.match(/^providerFallbacks:[\s\S]*?(?=^\S|\Z)/m);
    losFallbacks = fb ? fb[0].split('\n').filter(l => /^ {2}[a-z]/.test(l)).map(l => l.trim().replace(':', '')) : null;
  }
  rows.push({
    tool: 'los gateway (:8080)',
    owner: 'los (agent / headless / governance)',
    declared: losDeclared,
    declaredSource: existsSync(LOS_CONFIG) ? '~/.los/config.yaml' : null,
    live: losFallbacks ? `providerFallbacks roots: ${losFallbacks.join(', ')}` : null,
    liveSource: 'same file',
    verdict: losDeclared ? 'consistent' : 'not-configured',
  });

  return { rows, notes };
}

// ── 负向控制（纯函数，不读真机）──
function selfTest() {
  let fail = 0;
  const check = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`self-test FAILED: ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
      fail++;
    }
  };
  // 脱敏：key 名命中即替换，且不影响非敏感字段
  check('redact nested secret',
    redact({ providers: { kimi: { apiKey: 'sk-live-123', baseUrl: 'https://x/v1' } }, ok: 1 }),
    { providers: { kimi: { apiKey: '<redacted>', baseUrl: 'https://x/v1' } }, ok: 1 });
  check('redact token-ish keys', redact({ auth_token: 'a', password: 'b', name: 'c' }),
    { auth_token: '<redacted>', password: '<redacted>', name: 'c' });
  check('redact array of secrets', redact([{ api_key: 'x' }]), [{ api_key: '<redacted>' }]);

  // TOML 取值
  const toml = `model_provider = "custom"\nmodel = "gpt-6.1-sol"\n\n[model_providers.custom]\nname = "packycode"\nbase_url = "https://api-slb.packyapi.com/v1"\nwire_api = "responses"\n`;
  check('toml value in section', tomlValue(toml, 'base_url', 'model_providers.custom'), 'https://api-slb.packyapi.com/v1');
  check('toml value at root', tomlValue(toml, 'model'), 'gpt-6.1-sol');
  check('toml missing key', tomlValue(toml, 'nope', 'model_providers.custom'), null);

  // DSH 解析
  const patch = `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n    reasoningEffort: high\n- id: llm-fallbacks\n  config:\n    roles:\n      rules: []\n`;
  check('dsh default model', dshDefaultModel(patch), { provider: 'deepseek-official', model: 'deepseek-flash' });
  check('dsh fallbacks rules empty', dshFallbacks(patch), { present: true, rulesEmpty: true });
  check('dsh default model absent', dshDefaultModel('- id: other\n  config:\n    x: 1\n'), null);
  // 负向：字段缺失不得凭空造值
  check('dsh partial does not invent', dshDefaultModel('- id: agent-default-model\n  config:\n    provider: p\n'), { provider: 'p', model: null });

  if (fail) { console.error(`\nself-test: ${fail} failure(s)`); process.exit(1); }
  console.log('self-test OK: redaction (3) + toml (3) + dsh (4) = 10 assertions');
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

const { rows, notes } = collect();
const asJson = argv.includes('--json');

if (asJson) {
  console.log(JSON.stringify(redact({ generatedAt: new Date().toISOString(), rows, notes }), null, 2));
} else {
  console.log('model-route-truth — 配置 vs 生效 vs owner（只读）');
  console.log('═'.repeat(96));
  for (const r of rows) {
    console.log(`\n${r.tool}`);
    console.log(`  owner     : ${r.owner}`);
    console.log(`  declared  : ${r.declared ?? '(none)'}   [${r.declaredSource ?? '—'}]`);
    if (r.effective) console.log(`  effective : ${r.effective}   [${r.effectiveSource ?? '—'}]`);
    console.log(`  live      : ${r.live ?? '(no evidence)'}`);
    if (r.proxyListener !== undefined) console.log(`  listener  : ${r.proxyListener ?? '(none)'}`);
    if (r.observedTraffic) console.log(`  observed  : ${r.observedTraffic}   [session-index.db request/header, 14d]`);
    console.log(`  verdict   : ${r.verdict}${r.conflictReason ? `  ← ${r.conflictReason}` : ''}`);
  }
  console.log('\n' + '─'.repeat(96));
  const v = rows.reduce((a, r) => (a[r.verdict] = (a[r.verdict] ?? 0) + 1, a), {});
  console.log('verdict 汇总:', JSON.stringify(v));
  console.log('说明：consistent = 声明/生效/proxy 监听/流量观测一致；conflict = 真冲突（非零）；unverified = 缺证据；not-configured = 未配置。');
  if (notes.length) console.log('notes:', notes.join('; '));
}

// --check：只有 needs-review / conflict 才非零（unverified 与 not-configured 不算冲突）
if (argv.includes('--check')) {
  const bad = rows.filter(r => r.verdict === 'conflict');
  if (bad.length) {
    console.error(`\nmodel-route-truth --check: ${bad.length} CONFLICT(s): ${bad.map(r => `${r.tool}(${r.conflictReason ?? '?'})`).join('; ')}`);
    process.exit(1);
  }
  console.log('\nmodel-route-truth --check: no route conflict');
}
