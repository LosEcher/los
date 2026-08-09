import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const EN = readDict('en');

const chatPage = readFileSync(new URL('./chat-page.tsx', import.meta.url), 'utf8');
const chatPlanApproval = readFileSync(new URL('./chat-plan-approval.tsx', import.meta.url), 'utf8');
const chatComposer = readFileSync(new URL('./chat-composer.tsx', import.meta.url), 'utf8');
const chatMessages = readFileSync(new URL('./chat-messages.tsx', import.meta.url), 'utf8');
const useChatStream = readFileSync(new URL('./hooks/useChatStream.ts', import.meta.url), 'utf8');
const useChatRun = readFileSync(new URL('./hooks/useChatRun.ts', import.meta.url), 'utf8');
const useChatProviders = readFileSync(new URL('./hooks/useChatProviders.ts', import.meta.url), 'utf8');
const apiClient = readFileSync(new URL('./api/client.ts', import.meta.url), 'utf8');
const providersPage = readFileSync(new URL('./pages/providers-page.tsx', import.meta.url), 'utf8');
const providerAccountsPanel = readFileSync(new URL('./pages/provider-accounts-panel.tsx', import.meta.url), 'utf8');
const apiTypes = readFileSync(new URL('./api/types.ts', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const tasksPage = readFileSync(new URL('./pages/tasks-page.tsx', import.meta.url), 'utf8');
const agentGraphControl = readFileSync(new URL('./pages/agent-graph-control.tsx', import.meta.url), 'utf8');
const runSpecsPage = readFileSync(new URL('./pages/run-specs-page.tsx', import.meta.url), 'utf8');
const chatApproval = readFileSync(new URL('./chat-approval.tsx', import.meta.url), 'utf8');
const deadLetterPage = readFileSync(new URL('./pages/dead-letter-page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const navConfig = readFileSync(new URL('./nav-config.ts', import.meta.url), 'utf8');
const mobileNav = readFileSync(new URL('./mobile-nav.tsx', import.meta.url), 'utf8');
const setupPage = readFileSync(new URL('./pages/setup-page.tsx', import.meta.url), 'utf8');
const skillsPage = readFileSync(new URL('./skills-page.tsx', import.meta.url), 'utf8');
const mcpPage = readFileSync(new URL('./mcp-page.tsx', import.meta.url), 'utf8');
const mcpCreate = readFileSync(new URL('./mcp-server-create.tsx', import.meta.url), 'utf8');
const inboxPage = readFileSync(new URL('./pages/inbox-page.tsx', import.meta.url), 'utf8');
const workPage = readFileSync(new URL('./pages/work-page.tsx', import.meta.url), 'utf8');
const workCreateForm = readFileSync(new URL('./pages/work-create-form.tsx', import.meta.url), 'utf8');
const workReviewPanel = readFileSync(new URL('./pages/work-review-panel.tsx', import.meta.url), 'utf8');
const schedulesPage = readFileSync(new URL('./pages/schedules-page.tsx', import.meta.url), 'utf8');
const evalsPage = readFileSync(new URL('./evals-page.tsx', import.meta.url), 'utf8');
const dailyQualityView = readFileSync(new URL('./pages/daily-quality-view.tsx', import.meta.url), 'utf8');

test('chat keeps per-run choices beside the composer and evidence in the inspector', () => {
  assert.equal(EN['chat.runChoicesAria'], 'run choices');
  assert.equal(EN['chat.runEvidence'], 'Run Evidence');
  // Form may span multiple attributes (className + data-debug for phone power fields).
  const composer = between(chatComposer, 'className="composer"', '</form>');
  const inspector = between(chatPage, '<aside className="panel inspector">', '</aside>');

  assert.match(composer, /className="composer-toolbar"/);
  assert.match(composer, /aria-label=\{t\('chat\.runChoicesAria'\)\}/);
  assert.match(composer, /label=\{t\('chat\.provider'\)\}/);
  assert.match(composer, /label=\{t\('chat\.model'\)\}/);
  assert.match(composer, /label=\{t\('chat\.toolsSkills'\)\}/);
  assert.match(composer, /label=\{t\('chat\.executionDir'\)\}/);
  assert.match(composer, /ChatAdvancedSettings/);
  assert.match(composer, /composer-power-fields/);
  assert.match(composer, /data-debug=\{props\.debugMode \? 'true' : 'false'\}/);
  assert.match(chatPage, /refetchInterval: run\.running \? 4_000 : false/);
  assert.match(useChatRun, /useChatStream/);
  assert.match(useChatStream, /connectWsStream/);
  assert.match(useChatStream, /addEventListener\('session\.event'/);
  assert.doesNotMatch(useChatStream, /es\.onmessage/);

  assert.match(inspector, /\{t\('chat\.runEvidence'\)\}/);
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
  assert.equal(EN['pages.providers.addTitle'], 'Add Provider');
  assert.equal(EN['pages.providers.providerIdField'], 'provider id *');
  assert.equal(EN['pages.providers.apiKeyField'], 'api key');
  assert.equal(EN['pages.providers.baseUrlField'], 'base url');
  assert.equal(EN['pages.providers.defaultModelField'], 'default model');
  assert.equal(EN['common.enabled'], 'enabled');
  assert.equal(EN['pages.providers.weightField'], 'weight');
  const providerWorkspace = between(providersPage, 'function ProviderAddForm', 'function providerReadinessLabel');

  assert.match(providerWorkspace, /t\('pages\.providers\.addTitle'\)/);
  assert.match(providerWorkspace, /t\('pages\.providers\.providerIdField'\)/);
  assert.match(providerWorkspace, /t\('pages\.providers\.apiKeyField'\)/);
  assert.match(providerWorkspace, /t\('pages\.providers\.baseUrlField'\)/);
  assert.match(providerWorkspace, /t\('pages\.providers\.defaultModelField'\)/);
  assert.match(providerWorkspace, /t\('common\.enabled'\)/);
  assert.match(providerWorkspace, /t\('pages\.providers\.weightField'\)/);

  assert.doesNotMatch(chatPage, /api key env/);
  assert.doesNotMatch(chatPage, /base url/);
  assert.doesNotMatch(chatPage, /default model/);
  assert.doesNotMatch(chatPage, /Provider Settings/);
});

test('Grok existing-login adoption stays explicit, redacted, and runtime-gated', () => {
  assert.equal(EN['pages.accounts.noteUnavailable'], 'No usable login is copied or stored. Grok runtime remains unavailable until discovery and adoption both pass.');
  assert.match(providersPage, /<ProviderAccountsPanel \/>/);
  assert.match(providerAccountsPanel, /getJson<ProviderAccountDiscoveryResponse>\('\/providers\/accounts\/discovery'\)/);
  assert.match(providerAccountsPanel, /postJson<[^>]+>\('\/providers\/accounts\/grok', \{\}\)/);
  assert.match(providerAccountsPanel, /grok\?\.available && !active/);
  assert.match(providerAccountsPanel, /t\('pages\.accounts\.noteUnavailable'\)/);
  assert.doesNotMatch(providerAccountsPanel, /secretRef|auth\.json|access_token|refresh_token/);

  assert.match(chatPage, /providerAccountDiscovery\.data\?\.grok\.available === true/);
  assert.match(chatPage, /account\.id === 'xai-grok-default' && account\.state === 'active'/);
  assert.match(chatComposer, /props\.grokRuntimeEnabled \|\| props\.runtimeKind === 'grok'/);
  assert.match(chatComposer, /t\('chat\.grokExisting'\)/);
  assert.equal(EN['chat.grokExisting'], 'Grok (existing login)');
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
  assert.equal(EN['ops.tasks.graphCompletionTitle'], 'Graph Completion');
  assert.equal(EN['ops.tasks.attemptEvidenceTitle'], 'Attempt Evidence');
  const taskInspector = between(tasksPage, 'function TaskRunInspector', 'function formatIdList');

  assert.match(taskInspector, /agentGraphIdForTask/);
  assert.match(taskInspector, /getJson<AgentTaskGraph>\(`\/agent-graphs\/\$\{graphId\}`\)/);
  assert.match(taskInspector, /t\('ops\.tasks\.graphCompletionTitle'\)/);
  assert.match(taskInspector, /readyTaskIds/);
  assert.match(taskInspector, /waitingTaskIds/);
  assert.match(taskInspector, /blockedTaskIds/);
  assert.match(taskInspector, /t\('ops\.tasks\.attemptEvidenceTitle'\)/);
  assert.doesNotMatch(taskInspector, /JSON\.stringify\(graphResult/);
});

test('tasks page exposes governed graph create, watch, cancel, and verifier-gated integration', () => {
  assert.match(tasksPage, /<AgentGraphControl \/>/);
  assert.match(agentGraphControl, /postJson<GovernedAgentTaskGraphResponse>\('\/agent-graphs'/);
  assert.match(agentGraphControl, /`\/agent-graphs\/\$\{graphId\}\/watch`/);
  assert.match(agentGraphControl, /useGraphAction\(graphId, 'run'/);
  assert.match(agentGraphControl, /useGraphAction\(graphId, 'cancel'/);
  assert.match(agentGraphControl, /useGraphAction\(graphId, 'integrate'/);
  assert.match(agentGraphControl, /control\?\.integrationStatus !== 'ready'/);
  assert.match(viteConfig, /'\/agent-graphs': 'http:\/\/127\.0\.0\.1:8080'/);
  assert.doesNotMatch(agentGraphControl, /setIntegrationOwner|integrationOwner,/);
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

test('chat timeline is append-down with tool gates inline and footer steering', () => {
  assert.match(chatApproval, /function OperatorSteeringBar/);
  assert.match(chatApproval, /export function ApprovalSummary/);
  assert.match(chatApproval, /postOperatorSteering/);
  assert.match(chatApproval, /instruction:\s*'approve'/);
  assert.match(chatPage, /OperatorSteeringBar/);
  assert.match(chatPage, /sessionId=\{sessionId\}/);
  assert.match(chatPage, /footer=\{/);
  assert.match(chatPage, /ApprovalSummary/);
  assert.match(chatPage, /approvalEvents=\{run\.approvalEvents\}/);
  assert.doesNotMatch(chatPage, /className="approval-strip"/);
  assert.match(chatMessages, /className="chat-timeline"/);
  assert.match(chatMessages, /className="chat-timeline-footer"/);
  assert.match(chatMessages, /Tools first/);
});

test('Chat plan approval preserves the Work capability revision binding', () => {
  assert.match(chatPage, /ChatPlanApproval/);
  assert.match(chatPage, /workItemId=\{activeTodoContext\?\.id\}/);
  assert.match(chatPlanApproval, /planRevision:\s*planApproval\.planRevision/);
  assert.match(chatPlanApproval, /contractHash:\s*planApproval\.contractHash/);
  assert.match(chatPlanApproval, /queryKey:\s*\['work-item', workItemId\]/);
  assert.doesNotMatch(chatPlanApproval, /actor:\s*['"]web-chat['"]/);
});

test('dead-letter resolution requires an audited disposition instead of an empty ack', () => {
  assert.match(deadLetterPage, /type DeadLetterResolution = 'replaced' \| 'superseded' \| 'accepted_loss' \| 'regression_covered'/);
  assert.match(deadLetterPage, /\/tasks\/dead-letter\?acknowledged=false&limit=200/);
  assert.match(deadLetterPage, /\/tasks\/dead-letter\?acknowledged=true&limit=200/);
  assert.match(deadLetterPage, /replacementTaskRunId/);
  assert.equal(EN['ops.deadLetter.noteRequiredPlaceholder'], 'reason for accepting data loss');
  assert.match(deadLetterPage, /t\('ops\.deadLetter\.noteRequiredPlaceholder'\)/);
  assert.match(deadLetterPage, /postJson<DeadLetterEvent>\(`\/tasks\/dead-letter\/\$\{id\}\/ack`, body\)/);
  assert.doesNotMatch(deadLetterPage, /\/ack`, \{\}\)/);
});

test('setup source excludes sensitive fields and keeps responsive rows', () => {
  assert.doesNotMatch(setupPage, /apiKey|credentialPath|workspacePath|weclawBinary/);
  assert.match(styles, /\.setup-row[\s\S]*grid-template-columns/);
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*\.setup-row/);
});

test('skill and MCP distribution require inspect before apply and expose rollback controls', () => {
  assert.equal(EN['assets.mcp.credentialRef'], 'credential ref');
  assert.equal(EN['assets.mcp.allowedTools'], 'allowed tools');
  assert.equal(EN['assets.mcp.capabilityAdapter'], 'capability adapter');
  assert.equal(EN['assets.mcp.optionCantool'], 'CanTool local read-only');
  assert.equal(EN['assets.mcp.providerLocation'], 'provider location');
  assert.equal(EN['assets.mcp.dataGrantOwner'], 'data grant owner');
  assert.equal(EN['assets.state.available'], 'available');
  assert.equal(EN['assets.mcp.blockedReason'], 'blocked: {reason}');
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
  assert.match(mcpSurface, /t\('assets\.mcp\.credentialRef'\)/);
  assert.match(mcpSurface, /t\('assets\.mcp\.allowedTools'\)/);
  assert.match(mcpSurface, /t\('assets\.mcp\.capabilityAdapter'\)/);
  assert.match(mcpSurface, /t\('assets\.mcp\.optionCantool'\)/);
  assert.match(mcpSurface, /t\('assets\.mcp\.providerLocation'\)/);
  assert.match(mcpSurface, /t\('assets\.mcp\.dataGrantOwner'\)/);
  assert.match(mcpSurface, /assets\.state\.available/);
  assert.match(mcpSurface, /assets\.mcp\.blockedReason/);
  assert.doesNotMatch(mcpSurface, /env \(JSON\)|API_KEY/);
});

test('daily workflow opens on Inbox and keeps Inbox, Work, Chat, Sessions first', () => {
  assert.equal(EN['nav.inbox'], 'Inbox');
  assert.equal(EN['nav.work'], 'Work');
  // NAV table lives in nav-config.ts; App wires pages and mobile shell.
  assert.match(navConfig, /\{ id: 'inbox', labelKey: 'nav.inbox'/);
  assert.match(navConfig, /\{ id: 'work', labelKey: 'nav.work'/);
  assert.match(navConfig, /\{ id: 'inbox'[^]*\{ id: 'work'[^]*\{ id: 'chat'[^]*\{ id: 'sessions'/);
  assert.match(navConfig, /'inbox'/);
  assert.match(app, /from '\.\/nav-config'/);
  assert.match(app, /page === 'inbox' && <InboxPage/);
  assert.match(app, /page === 'work' && <WorkPage/);
  assert.match(app, /MobileTabBar/);
  assert.match(mobileNav, /MOBILE_TAB_IDS/);
  assert.match(inboxPage, /getJson<InboxResponse>\('\/inbox\?limit=100'\)/);
});

test('W4 nav converges daily path, demotes Todos, and keeps Tasks/Run specs in Ops', () => {
  assert.equal(EN['nav.section.daily'], 'Daily');
  assert.equal(EN['nav.section.library'], 'Library');
  assert.equal(EN['nav.section.advanced'], 'Advanced');
  assert.equal(EN['nav.section.operations'], 'Ops · troubleshoot');
  assert.equal(EN['nav.todos'], 'Todos (legacy)');
  assert.equal(EN['nav.tasks'], 'Task runs');
  assert.equal(EN['nav.runSpecs'], 'Run specs');
  assert.equal(EN['nav.brandSubtitle'], 'daily agent workspace');
  // Daily strip: no StatusPill noise (showStatus: false) — owned by nav-config.
  assert.match(navConfig, /id: 'inbox'[^]*showStatus: false/);
  assert.match(navConfig, /id: 'work'[^]*showStatus: false/);
  assert.match(navConfig, /id: 'schedules'[^]*showStatus: false/);
  assert.match(navConfig, /id: 'chat'[^]*showStatus: false/);
  assert.match(app, /item\.showStatus === false \? null/);
  // Todos is advanced/compat, not daily; Tasks + Run specs stay under operations.
  assert.match(navConfig, /id: 'todos'[^]*sectionKey: 'nav\.section\.advanced'/);
  assert.match(navConfig, /id: 'tasks'[^]*audience: 'operations'/);
  assert.match(navConfig, /id: 'run-specs'[^]*audience: 'operations'/);
  assert.match(app, /function navEyebrow/);
  // Ops deep-link expands the collapsible section.
  assert.match(app, /item\?\.audience === 'operations'/);
  assert.match(app, /setOpsExpanded\(true\)/);
  // Phone tabs: Inbox/Work/Chat; Schedules stays in More (not a bottom tab).
  assert.match(navConfig, /MOBILE_TAB_IDS = \['inbox', 'work', 'chat'\]/);
  assert.match(navConfig, /export function buildHash/);
  assert.match(navConfig, /export function parseHash/);
});

test('Inbox decision rows use human copy and a single primary CTA without technical ids', () => {
  assert.equal(EN['work.inbox.needLabel'], 'You need to:');
  assert.equal(EN['work.inbox.effectLabel'], 'This button will:');
  assert.equal(EN['work.inbox.action.review_plan'], 'Review plan');
  assert.match(inboxPage, /export function buildInboxDecision/);
  assert.match(inboxPage, /data-testid="inbox-decision-row"/);
  assert.match(inboxPage, /data-testid="inbox-primary-action"/);
  assert.match(inboxPage, /inbox-primary-cta/);
  assert.match(inboxPage, /work\.inbox\.needLabel/);
  assert.match(inboxPage, /work\.inbox\.whyLabel/);
  assert.match(inboxPage, /work\.inbox\.effectLabel/);
  // Default meta must not surface runSpecId codes; plan approval is on Work, not a second Inbox CTA.
  assert.doesNotMatch(inboxPage, /entry\.runSpecId\.slice|runSpecId\.slice\(0,\s*12\)/);
  assert.doesNotMatch(between(inboxPage, 'function InboxRow', 'function SummaryCount'), /onApprovePlan|approve-action/);
  assert.match(styles, /\.inbox-decision/);
  assert.match(styles, /\.inbox-primary-cta/);
});

test('Schedules exposes bounded presets, trigger preview, operator actions, and run history', () => {
  assert.equal(EN['nav.schedules'], 'Schedules');
  assert.match(navConfig, /\{ id: 'schedules', labelKey: 'nav.schedules'/);
  assert.match(app, /page === 'schedules' && <SchedulesPage/);
  // Default operator view is active-only (excludeRetired), not the full archive.
  assert.match(schedulesPage, /function schedulesListUrl\(filter: ScheduleStatusFilter\)/);
  assert.match(schedulesPage, /params\.set\('excludeRetired', 'true'\)/);
  assert.match(schedulesPage, /getJson<ScheduledWorkListResponse>\(schedulesListUrl\(statusFilter\)\)/);
  assert.match(schedulesPage, /useState<ScheduleStatusFilter>\('active'\)/);
  assert.match(schedulesPage, /getJson<ScheduledWorkPreviewResponse>\(previewPath\(trigger\)\)/);
  assert.match(schedulesPage, /schedule-goal/);
  assert.match(schedulesPage, /postJson<CreateScheduledWorkResponse>\('\/scheduled-work-items'/);
  assert.match(schedulesPage, /patchJson<ScheduledWorkItem>\(`\/scheduled-work-items\/\$\{id\}`/);
  assert.match(schedulesPage, /postJson\(`\/scheduled-work-items\/\$\{id\}\/trigger`/);
  assert.match(schedulesPage, /postJson\(`\/scheduled-work-item-runs\/\$\{runId\}\/retry`/);
  assert.match(schedulesPage, /type TriggerPreset = 'daily' \| 'weekly' \| 'interval' \| 'once'/);
  assert.match(schedulesPage, /preview\.data\?\.occurrences\.map/);
  assert.match(schedulesPage, /detail\.data\?\.runs\.map/);
  assert.match(schedulesPage, /validateFeedAnalysisRequest/);
  assert.equal(EN['ops.schedules.feedAnalysisNoEvidence'], 'Add at least one material item, observation, or material bundle reference.');
  assert.match(schedulesPage, /t\('ops\.schedules\.feedAnalysisNoEvidence'\)/);
  assert.match(schedulesPage, /form\.templateId === 'scheduled_feed_analysis' && !feedAnalysisRequest\.value/);
  assert.match(viteConfig, /'\/scheduled-work-items': 'http:\/\/127\.0\.0\.1:8080'/);
  assert.match(viteConfig, /'\/scheduled-work-item-runs': 'http:\/\/127\.0\.0\.1:8080'/);
  assert.match(styles, /@media \(max-width: 780px\)[^]*\.schedule-split/);
});

test('Daily Quality keeps the 28-day evidence window and metric families separate', () => {
  assert.equal(EN['ops.evals.tabDailyQuality'], 'Daily Quality');
  assert.equal(EN['ops.dailyQuality.evidenceWindowLabel'], '28-day evidence window');
  assert.equal(EN['ops.dailyQuality.groupInbox'], 'Inbox');
  assert.equal(EN['ops.dailyQuality.groupSchedules'], 'Schedules');
  assert.equal(EN['ops.dailyQuality.groupRecovery'], 'Recovery');
  assert.equal(EN['ops.dailyQuality.groupVerification'], 'Verification');
  assert.equal(EN['ops.dailyQuality.groupProviderModel'], 'Provider / Model Quality');
  assert.match(evalsPage, /<CalendarDays size=\{14\} \/> \{t\('ops\.evals\.tabDailyQuality'\)\}/);
  assert.match(evalsPage, /mode === 'daily' && <DailyQualityView \/>/);
  assert.match(dailyQualityView, /getJson<DailyAgentQualityBaseline>\('\/daily-agent-quality\/baseline\?days=28'\)/);
  assert.match(dailyQualityView, /postJson<DailyAgentQualityCaptureResponse>\('\/daily-agent-quality\/capture', \{\}\)/);
  assert.match(dailyQualityView, /t\('ops\.dailyQuality\.evidenceWindowLabel'\)/);
  assert.match(dailyQualityView, /t\('ops\.dailyQuality\.groupInbox'\)/);
  assert.match(dailyQualityView, /t\('ops\.dailyQuality\.groupSchedules'\)/);
  assert.match(dailyQualityView, /t\('ops\.dailyQuality\.groupRecovery'\)/);
  assert.match(dailyQualityView, /t\('ops\.dailyQuality\.groupVerification'\)/);
  assert.match(dailyQualityView, /t\('ops\.dailyQuality\.groupProviderModel'\)/);
  assert.doesNotMatch(dailyQualityView, /combined score|overall score/i);
  assert.match(viteConfig, /'\/daily-agent-quality': 'http:\/\/127\.0\.0\.1:8080'/);
  assert.match(styles, /@container \(max-width: 560px\)[^]*\.quality-metric-groups/);
});

test('new Work sends a structured contract draft and does not dispatch directly', () => {
  assert.equal(EN['work.form.draftNote'], 'Creates a draft only. Execution starts after operator action.');
  assert.equal(EN['work.form.permission'], 'Permission');
  assert.equal(EN['work.form.advanced'], 'Advanced');
  assert.match(workPage, /StructuredCreateForm/);
  assert.match(workCreateForm, /postJson<WorkItemProjection>\('\/work-items', buildCreateWorkItemPayload\(form\)\)/);
  assert.match(workCreateForm, /mode: form\.mode/);
  assert.match(workCreateForm, /toolMode: form\.toolMode/);
  assert.match(workCreateForm, /editableSurfaces: lines\(form\.editableSurfaces\)/);
  assert.match(workCreateForm, /requiredChecks: lines\(form\.requiredChecks\)/);
  assert.match(workCreateForm, /stopConditions: lines\(form\.stopConditions\)/);
  assert.match(workCreateForm, /t\('work\.form\.draftNote'\)/);
  assert.doesNotMatch(between(workCreateForm, 'export function StructuredCreateForm', 'function LineField'), /postJson[^\n]+\/chat/);
});

test('Work create form is two-tier: default goal/permission/priority, advanced holds contract fields', () => {
  const createForm = between(workCreateForm, 'export function StructuredCreateForm', 'function LineField');
  assert.match(createForm, /className="work-create-defaults"/);
  assert.match(createForm, /t\('work\.form\.goal'\)/);
  assert.match(createForm, /t\('work\.form\.permission'\)/);
  assert.match(createForm, /t\('work\.form\.priority'\)/);
  assert.match(createForm, /className="work-create-advanced"/);
  assert.match(createForm, /t\('work\.form\.advanced'\)/);
  assert.match(createForm, /countAdvancedOverrides\(form\)/);
  // Mode enum (incl. feed-analysis) and contract lists live only under advanced.
  assert.match(createForm, /work-create-advanced[\s\S]*feed-analysis-ingress/);
  assert.match(createForm, /work-create-advanced[\s\S]*editableSurfaces/);
  assert.match(createForm, /work-create-advanced[\s\S]*requiredChecks/);
  assert.match(createForm, /work-create-advanced[\s\S]*stopConditions/);
  // Default strip must not surface mode enum or feed-analysis option.
  const defaults = between(createForm, 'work-create-defaults', 'work-create-advanced');
  assert.doesNotMatch(defaults, /feed-analysis-ingress/);
  assert.doesNotMatch(defaults, /work\.form\.mode/);
  assert.match(styles, /\.work-create-advanced/);
  assert.match(styles, /\.work-create-defaults/);
});

test('Work reviews plans in the daily surface and proxies Work Item routes', () => {
  assert.match(workPage, /getJson<RuntimeInspect>\(`\/runs\/\$\{runSpecId\}\/inspect`\)/);
  assert.match(workPage, /postJson\(`\/runs\/\$\{action\.payload\.runSpecId\}\/approve`/);
  assert.match(workPage, /reason: approvalReason\.trim\(\)/);
  assert.match(workPage, /availableActions\?\.approvePlan/);
  assert.match(workPage, /\.\.\.action\.payload/);
  assert.doesNotMatch(workPage, /item\.nextAction === 'review_plan' && runSpecId/);
  assert.match(workReviewPanel, /Boolean\(item\.availableActions\.reviewResult\)/);
  assert.match(viteConfig, /'\/inbox': 'http:\/\/127\.0\.0\.1:8080'/);
  assert.match(viteConfig, /'\/work-items': 'http:\/\/127\.0\.0\.1:8080'/);
  assert.match(styles, /@media \(max-width: 780px\)[^]*\.daily-split,[^]*\.work-split/);
});

test('Work decision layer uses Outcome Card and folds technical evidence behind Debug', () => {
  const workGuidance = readFileSync(new URL('./pages/work-guidance.tsx', import.meta.url), 'utf8');
  assert.equal(EN['work.tech.summary'], 'Technical details');
  assert.equal(EN['work.debugLabel'], 'Debug');
  assert.equal(EN['work.outcome.checksLabel'], 'Checks');
  assert.match(workPage, /<OutcomeCard item=\{item\} \/>/);
  assert.match(workPage, /work-primary-cta/);
  assert.match(workPage, /data-testid="work-technical-details"/);
  assert.match(workPage, /data-testid="work-action-strip"/);
  assert.match(workPage, /readWorkDebugPreference/);
  assert.match(workPage, /writeWorkDebugPreference/);
  assert.match(workPage, /primaryActionKey/);
  // Technical ids live only inside TechnicalEvidence / Lineage (folded), not the default decision strip.
  assert.match(workPage, /function TechnicalEvidence/);
  assert.match(workPage, /function Lineage/);
  assert.doesNotMatch(between(workPage, '<OutcomeCard item={item} />', '<WorkReviewPanel'), /latestRunSpecId|latestTaskRunId|lineage-section/);
  assert.match(workGuidance, /data-testid="work-outcome-card"/);
  assert.match(workGuidance, /export function buildWorkOutcome/);
  assert.match(workGuidance, /export function primaryActionKey/);
  assert.match(workGuidance, /WORK_DEBUG_STORAGE_KEY/);
  assert.match(styles, /\.outcome-card/);
  assert.match(styles, /\.work-technical/);
  assert.match(styles, /\.work-primary-cta/);
});

test('project-write chat intake creates and reuses a Work Item before streaming', () => {
  assert.match(useChatRun, /let resolvedTodo = o\.activeTodoContext \?\? autoWorkItemRef\.current/);
  assert.match(useChatRun, /postJson<WorkItemProjection>\('\/work-items'/);
  assert.match(useChatRun, /mode: 'execution'/);
  assert.match(useChatRun, /toolMode: 'project-write'/);
  assert.match(useChatRun, /autoWorkItemRef\.current = resolvedTodo/);
  assert.match(useChatRun, /todoId: resolvedTodo\?\.id/);
  assert.match(useChatRun, /runContract: readRunContract\(resolvedTodo \?\? null\)/);
  assert.match(useChatRun, /queryKey: \['work-items'\]/);
  assert.match(useChatRun, /queryKey: \['inbox'\]/);
  assert.match(useChatRun, /o\.toolMode === 'project-write'/);
});

test('Work-first context keeps the project header and tool mode aligned', () => {
  assert.match(apiClient, /headers\['x-project-id'\] = getCurrentProjectId\(\) \?\? 'los'/);
  assert.match(chatPage, /const contractToolMode = readRunContract\(activeTodoContext\)\?\.toolMode/);
  assert.match(chatPage, /contractToolMode === 'read-only' \|\| contractToolMode === 'project-write'/);
  assert.match(chatPage, /setToolMode\(contractToolMode\)/);
});

test('Chat provider defaults follow the effective server configuration', () => {
  assert.match(useChatProviders, /getJson<[^>]+>\('\/settings'\)/);
  assert.match(useChatProviders, /settings\.data\?\.agent\?\.defaultProvider/);
  assert.match(useChatProviders, /providerOptions\.find\(option => option\.id === defaultProvider\)/);
  assert.match(useChatProviders, /settings\.data\?\.agent\?\.defaultModel/);
});

test('Work plan review exposes structured steps, verification mapping, and revision history', () => {
  assert.equal(EN['work.plan.revisionHistory'], 'Revision history');
  assert.match(workPage, /t\('work\.plan\.revision', \{ n: contract\.planRevision \}\)/);
  assert.match(workPage, /t\('work\.plan\.dependsOn'\)/);
  assert.match(workPage, /t\('work\.plan\.writableScope'\)/);
  assert.match(workPage, /t\('work\.plan\.doneWhen'\)/);
  assert.match(workPage, /t\('work\.plan\.verificationMapping'\)/);
  assert.match(workPage, /planHistory/);
  assert.match(workPage, /t\('work\.plan\.revisionHistory'\)/);
});

test('Work result review exposes verification and durable workspace evidence before an operator decision', () => {
  assert.match(workPage, /<WorkReviewPanel/);
  assert.match(workPage, /postJson\(`\/work-items\/\$\{item!\.id\}\/result-decision`/);
  assert.match(workPage, /dirtyPaths,?\s*$/m);
  assert.match(workPage, /record\.status === 'succeeded' \|\| record\.status === 'skipped'/);
  assert.match(workReviewPanel, /item\.verificationRecords\.map/);
  assert.match(workReviewPanel, /workspace\.backupArtifactId \?\? t\('work\.review\.backupRequired'\)/);
  assert.match(workReviewPanel, /t\('work\.review\.createBackup'\)/);
  assert.match(workReviewPanel, /decide\('revision_requested'\)/);
  assert.match(workReviewPanel, /decide\('accepted'\)/);
  assert.match(workReviewPanel, /onFilesLoaded=\{onDiffFiles\}/);
  assert.match(styles, /\.workspace-record code[^]*overflow-wrap: anywhere/);
});

function readDict(lang) {
  const dict = {};
  const dir = new URL(`./i18n/${lang}/`, import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'index.ts')) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',\s*$/gm)) {
      dict[m[1]] = m[2];
    }
  }
  return dict;
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex + end.length);
}
