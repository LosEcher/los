import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatPage = readFileSync(new URL('./chat-page.tsx', import.meta.url), 'utf8');
const pages = readFileSync(new URL('./pages.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('chat keeps per-run choices beside the composer and evidence in the inspector', () => {
  const composer = between(chatPage, '<form className="composer"', '</form>');
  const inspector = between(chatPage, '<aside className="panel inspector">', '</aside>');

  assert.match(composer, /className="composer-toolbar"/);
  assert.match(composer, /aria-label="run choices"/);
  assert.match(composer, /label="provider"/);
  assert.match(composer, /label="model"/);
  assert.match(composer, /label="tools \/ skills"/);
  assert.match(composer, /label="execution dir"/);
  assert.match(composer, /title="Advanced request settings"/);
  assert.match(composer, /label="temperature"/);
  assert.match(composer, /label="max tokens"/);

  assert.match(inspector, /Run Evidence/);
  assert.match(inspector, /Recent Events/);
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
  const providerWorkspace = between(pages, 'function ProviderConfigWorkspace()', 'function ConfigSnippet');

  assert.match(providerWorkspace, /Provider Settings/);
  assert.match(providerWorkspace, /label="provider id"/);
  assert.match(providerWorkspace, /label="api key env"/);
  assert.match(providerWorkspace, /label="base url"/);
  assert.match(providerWorkspace, /label="default model"/);
  assert.match(providerWorkspace, /enabled/);
  assert.match(providerWorkspace, /\.env/);
  assert.match(providerWorkspace, /~\/.los\/config.yaml/);

  assert.doesNotMatch(chatPage, /label="api key env"/);
  assert.doesNotMatch(chatPage, /label="base url"/);
  assert.doesNotMatch(chatPage, /label="default model"/);
  assert.doesNotMatch(chatPage, /Provider Settings/);
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
