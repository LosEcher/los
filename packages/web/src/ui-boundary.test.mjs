import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatPage = readFileSync(new URL('./chat-page.tsx', import.meta.url), 'utf8');
const chatComposer = readFileSync(new URL('./chat-composer.tsx', import.meta.url), 'utf8');
const useChatStream = readFileSync(new URL('./hooks/useChatStream.ts', import.meta.url), 'utf8');
const useChatRun = readFileSync(new URL('./hooks/useChatRun.ts', import.meta.url), 'utf8');
const providersPage = readFileSync(new URL('./pages/providers-page.tsx', import.meta.url), 'utf8');
const tasksPage = readFileSync(new URL('./pages/tasks-page.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

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

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex + end.length);
}
