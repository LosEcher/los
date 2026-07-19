import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatPage = readFileSync(new URL('./chat-page.tsx', import.meta.url), 'utf8');
const chatComposer = readFileSync(new URL('./chat-composer.tsx', import.meta.url), 'utf8');
const chatMessages = readFileSync(new URL('./chat-messages.tsx', import.meta.url), 'utf8');
const useChatStream = readFileSync(new URL('./hooks/useChatStream.ts', import.meta.url), 'utf8');
const useChatRun = readFileSync(new URL('./hooks/useChatRun.ts', import.meta.url), 'utf8');
const providersPage = readFileSync(new URL('./pages/providers-page.tsx', import.meta.url), 'utf8');
const providerAccountsPanel = readFileSync(new URL('./pages/provider-accounts-panel.tsx', import.meta.url), 'utf8');
const apiTypes = readFileSync(new URL('./api/types.ts', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const tasksPage = readFileSync(new URL('./pages/tasks-page.tsx', import.meta.url), 'utf8');
const runSpecsPage = readFileSync(new URL('./pages/run-specs-page.tsx', import.meta.url), 'utf8');
const chatApproval = readFileSync(new URL('./chat-approval.tsx', import.meta.url), 'utf8');
const deadLetterPage = readFileSync(new URL('./pages/dead-letter-page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const setupPage = readFileSync(new URL('./pages/setup-page.tsx', import.meta.url), 'utf8');
const skillsPage = readFileSync(new URL('./skills-page.tsx', import.meta.url), 'utf8');
const mcpPage = readFileSync(new URL('./mcp-page.tsx', import.meta.url), 'utf8');
const mcpCreate = readFileSync(new URL('./mcp-server-create.tsx', import.meta.url), 'utf8');

test('chat keeps per-run choices beside the composer and evidence in the inspector', () => {
  const composer = between(chatComposer, '<form className="composer"', '</form>');
  const inspector = between(chatPage, '<aside className="panel inspector">', '</aside>');

  assert.match(composer, /className="composer-toolbar"/);
  assert.match(composer, /aria-label="run choices"/);
  assert.match(composer, /label="provider"/);
  assert.match(composer, /label="model"/);
  assert.match(composer, /label="tools \/ skills"/);
  assert.match(composer, /label="execution dir"/);
  assert.match(composer, /ChatAdvancedSettings/);
  assert.match(composer, /aria-label="run choices"/);
  assert.match(chatPage, /refetchInterval: run\.running \? 4_000 : false/);
  assert.match(useChatRun, /useChatStream/);
  assert.match(useChatStream, /connectWsStream/);
  assert.match(useChatStream, /addEventListener\('session\.event'/);
  assert.doesNotMatch(useChatStream, /es\.onmessage/);

  assert.match(inspector, /Run Evidence/);
  assert.doesNotMatch(inspector, /Run Controls/);
  assert.doesNotMatch(composer, /Provider setup stays in Providers/);
  assert.doesNotMatch(composer, /composer-run-panel/);
  assert.doesNotMatch(inspector, /provider endpoint/);
  assert.doesNotMatch(inspector, /provider model/);
  assert.doesNotMatch(inspector, /workspace root/);
  assert.doesNotMatch(inspector, /tool mode/);
  assert.doesNotMatch(inspector, /Model settings/);
});

test('provider setup fields live on the providers page, not chat', () => {
  const providerWorkspace = between(providersPage, 'function ProviderAddForm', 'function providerReadinessLabel');

  assert.match(providerWorkspace, /Add Provider/);
  assert.match(providerWorkspace, /provider id \*/);
  assert.match(providerWorkspace, /api key/);
  assert.match(providerWorkspace, /base url/);
  assert.match(providerWorkspace, /default model/);
  assert.match(providerWorkspace, /enabled/);
  assert.match(providerWorkspace, /weight/);

  assert.doesNotMatch(chatPage, /api key env/);
  assert.doesNotMatch(chatPage, /base url/);
  assert.doesNotMatch(chatPage, /default model/);
  assert.doesNotMatch(chatPage, /Provider Settings/);
});

test('Grok existing-login adoption stays explicit, redacted, and runtime-gated', () => {
  assert.match(providersPage, /<ProviderAccountsPanel \/>/);
  assert.match(providerAccountsPanel, /getJson<ProviderAccountDiscoveryResponse>\('\/providers\/accounts\/discovery'\)/);
  assert.match(providerAccountsPanel, /postJson<[^>]+>\('\/providers\/accounts\/grok', \{\}\)/);
  assert.match(providerAccountsPanel, /grok\?\.available && !active/);
  assert.match(providerAccountsPanel, /No usable login is copied or stored/);
  assert.doesNotMatch(providerAccountsPanel, /secretRef|auth\.json|access_token|refresh_token/);

  assert.match(chatPage, /providerAccountDiscovery\.data\?\.grok\.available === true/);
  assert.match(chatPage, /account\.id === 'xai-grok-default' && account\.state === 'active'/);
  assert.match(chatComposer, /props\.grokRuntimeEnabled \|\| props\.runtimeKind === 'grok'/);
  assert.match(chatComposer, /Grok \(existing login\)/);
  assert.match(apiTypes, /export type RuntimeKind = 'claude-code' \| 'codex' \| 'grok'/);
  assert.match(viteConfig, /'\/runtimes': 'http:\/\/127\.0\.0\.1:8080'/);
});

test('providers page renders readiness instead of raw discovery booleans', () => {
  const section = between(providersPage, 'export function ProvidersPage()', 'function ProviderAddForm');

  assert.match(section, /providerReadinessLabel/);
  assert.match(section, /providerReadinessDetail/);
  assert.match(section, /className="record-row provider-row"/);
  assert.match(section, /readiness\.ready/);
  assert.match(section, /readiness\.manualSetupRequired/);
  assert.match(section, /compat-evidence-detail/);
  assert.match(section, /taskRunId/);
  assert.doesNotMatch(section, /String\(provider\.available \?\? provider\.importable/);
});

test('task inspector renders agent graph read model fields', () => {
  const taskInspector = between(tasksPage, 'function TaskRunInspector', 'function formatIdList');

  assert.match(taskInspector, /agentGraphIdForTask/);
  assert.match(taskInspector, /getJson<AgentTaskGraph>\(`\/agent-graphs\/\$\{graphId\}`\)/);
  assert.match(taskInspector, /Graph Completion/);
  assert.match(taskInspector, /readyTaskIds/);
  assert.match(taskInspector, /waitingTaskIds/);
  assert.match(taskInspector, /blockedTaskIds/);
  assert.match(taskInspector, /Attempt Evidence/);
  assert.doesNotMatch(taskInspector, /JSON\.stringify\(graphResult/);
});

test('composer run controls are responsive instead of fixed to one crowded grid', () => {
  const toolbar = between(styles, '.composer-toolbar {', '}');
  const runField = between(styles, '.run-field {', '}');
  const advancedPanel = between(styles, '.composer-advanced-panel {', '}');

  assert.match(toolbar, /display: flex/);
  assert.match(runField, /height: 28px/);
  assert.match(runField, /border-radius: 999px/);
  assert.match(advancedPanel, /position: absolute/);
  assert.match(styles, /@media \(max-width: 1080px\)[\s\S]*\.composer-toolbar\s+\{\n\s+flex-wrap: wrap/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*\.composer-advanced-panel\s+\{\n\s+right: 0;\n\s+left: auto;\n\s+grid-template-columns: 1fr/);
  assert.doesNotMatch(styles, /composer-run-panel/);
});

test('run specs operator actions send actor/reason contract, not approved/note', () => {
  assert.match(runSpecsPage, /function buildRunOperatorPayload/);
  assert.match(runSpecsPage, /actor:\s*WEB_OPERATOR_ACTOR/);
  assert.match(runSpecsPage, /postJson\(`\/runs\/\$\{id\}\/approve`/);
  assert.match(runSpecsPage, /buildRunOperatorPayload\(approvalReason/);
  assert.match(runSpecsPage, /postJson\(`\/runs\/\$\{id\}\/recover`/);
  assert.match(runSpecsPage, /intent:\s*'cancel'/);
  assert.match(runSpecsPage, /postJson\(`\/runs\/\$\{id\}\/verify`/);
  // Legacy broken payload must not return
  assert.doesNotMatch(runSpecsPage, /approved:\s*true/);
  assert.doesNotMatch(runSpecsPage, /approved:\s*false/);
  assert.doesNotMatch(runSpecsPage, /note:\s*approvalNote/);
});

test('chat ApprovalCard is interactive via operator-events and WS steering is wired', () => {
  assert.match(chatApproval, /function OperatorSteeringBar/);
  assert.match(chatApproval, /postOperatorSteering/);
  assert.match(chatApproval, /instruction:\s*'approve'/);
  assert.match(chatPage, /OperatorSteeringBar/);
  assert.match(chatPage, /sessionId=\{sessionId\}/);
  assert.match(chatPage, /notices=\{/);
  assert.match(chatMessages, /\{notices\}[\s\S]*\{debugMode \?/);
});

test('dead-letter resolution requires an audited disposition instead of an empty ack', () => {
  assert.match(deadLetterPage, /type DeadLetterResolution = 'replaced' \| 'superseded' \| 'accepted_loss' \| 'regression_covered'/);
  assert.match(deadLetterPage, /\/tasks\/dead-letter\?acknowledged=false&limit=200/);
  assert.match(deadLetterPage, /\/tasks\/dead-letter\?acknowledged=true&limit=200/);
  assert.match(deadLetterPage, /replacementTaskRunId/);
  assert.match(deadLetterPage, /reason for accepting data loss/);
  assert.match(deadLetterPage, /postJson<DeadLetterEvent>\(`\/tasks\/dead-letter\/\$\{id\}\/ack`, body\)/);
  assert.doesNotMatch(deadLetterPage, /\/ack`, \{\}\)/);
});

test('setup readiness is wired, redacted, and keeps discovery separate from compatibility', () => {
  assert.match(app, /id: 'setup'/);
  assert.match(app, /page === 'setup' && <SetupPage/);
  assert.match(setupPage, /Promise\.allSettled/);
  assert.match(setupPage, /compatibility evidence is still required/);
  assert.match(setupPage, /Provider discovery and compatibility evidence are separate checks/);
  assert.match(setupPage, /Hermes \$\{hermes\?\.installed/);
  assert.doesNotMatch(setupPage, /apiKey|credentialPath|workspacePath|weclawBinary/);
  assert.match(styles, /\.setup-row[\s\S]*grid-template-columns/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*\.setup-row/);
});

test('skill and MCP distribution require inspect before apply and expose rollback controls', () => {
  const mcpSurface = mcpPage + mcpCreate;
  assert.match(skillsPage, /'\/skills\/import\/inspect'/);
  assert.match(skillsPage, /'\/skills\/import\/apply'/);
  assert.match(skillsPage, /\/pin`/);
  assert.match(skillsPage, /\/rollback`/);
  assert.match(skillsPage, /pinnedVersionHash/);

  assert.match(mcpSurface, /'\/mcp-servers\/inspect'/);
  assert.match(mcpSurface, /inspectedVersionHash/);
  assert.match(mcpSurface, /\/enable`/);
  assert.match(mcpSurface, /\/pin`/);
  assert.match(mcpSurface, /\/rollback`/);
  assert.match(mcpSurface, /credential ref/);
  assert.match(mcpSurface, /allowed tools/);
  assert.doesNotMatch(mcpSurface, /env \(JSON\)|API_KEY/);
});

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex + end.length);
}
