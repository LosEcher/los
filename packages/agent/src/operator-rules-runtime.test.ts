import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOperatorRulesGateConfig,
  evaluateOperatorRuleGate,
  injectOperatorRulesIntoSystemPrompt,
  listActiveOperatorRules,
  selectOperatorRulesForRun,
} from './operator-rules-runtime.js';
import type { RuleRecord } from './rules.js';

function rule(partial: Partial<RuleRecord> & Pick<RuleRecord, 'name' | 'content'>): RuleRecord {
  return {
    id: partial.id ?? `rule-${partial.name}`,
    name: partial.name,
    severity: partial.severity ?? 'warn',
    enforcementMode: partial.enforcementMode ?? 'advisory',
    status: partial.status ?? 'active',
    content: partial.content,
    metadata: partial.metadata ?? {},
    createdAt: partial.createdAt ?? '2026-08-09T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-08-09T00:00:00.000Z',
  };
}

describe('listActiveOperatorRules + match parse', () => {
  it('parses tools pathGlobs and argRegex frontmatter', async () => {
    const rules = await listActiveOperatorRules({
      catalog: [rule({
        name: 'no-force',
        severity: 'block',
        enforcementMode: 'required',
        content: `---
match:
  tools:
    - write_file
    - run_shell
  pathGlobs: ["packages/infra/**", "contracts/**"]
  argRegex:
    command: "(rm -rf|git push --force)"
---
Never wipe infra without approval.
`,
      })],
    });
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.machineEnforceable, true);
    assert.deepEqual(rules[0]!.match?.tools, ['write_file', 'run_shell']);
    assert.deepEqual(rules[0]!.match?.pathGlobs, ['packages/infra/**', 'contracts/**']);
    assert.equal(rules[0]!.match?.argRegex?.command, '(rm -rf|git push --force)');
  });

  it('marks free-text rules as non-enforceable', async () => {
    const rules = await listActiveOperatorRules({
      catalog: [rule({ name: 'style', content: 'Always prefer small diffs.' })],
    });
    assert.equal(rules[0]!.machineEnforceable, false);
    assert.equal(rules[0]!.match, null);
  });

  it('fails closed on invalid regex for required block candidates', async () => {
    const rules = await listActiveOperatorRules({
      catalog: [rule({
        name: 'broken',
        severity: 'block',
        enforcementMode: 'required',
        content: `---
match:
  tools: [write_file]
  argRegex:
    command: "(unterminated"
---
body
`,
      })],
    });
    assert.equal(rules[0]!.machineEnforceable, false);
    assert.ok(rules[0]!.parseWarnings.some(w => w.startsWith('arg_regex_compile_failed')));
  });
});

describe('evaluateOperatorRuleGate', () => {
  async function blockRule() {
    const [gateRule] = await listActiveOperatorRules({
      catalog: [rule({
        name: 'no-force-infra',
        severity: 'block',
        enforcementMode: 'required',
        content: `---
match:
  tools:
    - write_file
  pathGlobs:
    - packages/infra/**
---
Do not write under packages/infra without approval.
`,
      })],
    });
    return gateRule!;
  }

  it('hard-blocks required+block matches', async () => {
    const gate = buildOperatorRulesGateConfig([await blockRule()], true);
    const decision = evaluateOperatorRuleGate(
      'write_file',
      { path: 'packages/infra/src/config.ts' },
      gate,
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.action, 'block');
    assert.equal(decision.ruleName, 'no-force-infra');
  });

  it('allows non-matching tools', async () => {
    const gate = buildOperatorRulesGateConfig([await blockRule()], true);
    const decision = evaluateOperatorRuleGate(
      'read_file',
      { path: 'packages/infra/src/config.ts' },
      gate,
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.action, 'allow');
  });

  it('does not hard-block advisory rules', async () => {
    const [advisory] = await listActiveOperatorRules({
      catalog: [rule({
        name: 'prefer-small',
        severity: 'warn',
        enforcementMode: 'advisory',
        content: `---
match:
  tools: [write_file]
---
Prefer small diffs.
`,
      })],
    });
    const gate = buildOperatorRulesGateConfig([advisory!], true);
    const decision = evaluateOperatorRuleGate('write_file', { path: 'a.ts' }, gate);
    assert.equal(decision.allowed, true);
    assert.equal(decision.action, 'warn');
  });

  it('does not hard-block required+block without machine-enforceable match', async () => {
    const [broken] = await listActiveOperatorRules({
      catalog: [rule({
        name: 'broken-block',
        severity: 'block',
        enforcementMode: 'required',
        content: 'no match dsl here',
      })],
    });
    assert.equal(broken!.machineEnforceable, false);
    const gate = buildOperatorRulesGateConfig([broken!], true);
    const decision = evaluateOperatorRuleGate('write_file', { path: 'x.ts' }, gate);
    assert.equal(decision.allowed, true);
  });

  it('respects enabled:false', async () => {
    const gate = buildOperatorRulesGateConfig([await blockRule()], false);
    const decision = evaluateOperatorRuleGate(
      'write_file',
      { path: 'packages/infra/src/config.ts' },
      gate,
    );
    assert.equal(decision.allowed, true);
  });
});

describe('formatOperatorRulesForPrompt + inject', () => {
  it('formats operator title and injects before learned procedural', async () => {
    const [style] = await listActiveOperatorRules({
      catalog: [rule({ name: 'style', content: 'Use conventional commits.' })],
    });
    const selected = selectOperatorRulesForRun([style!]);
    assert.match(selected.promptBlock, /## Operator Rules/);
    const base = 'identity\n\nbase prompt\n\n## Learned Procedural Rules (memory)\nlearned';
    const injected = injectOperatorRulesIntoSystemPrompt(base, selected.promptBlock);
    const opIdx = injected.indexOf('## Operator Rules');
    const learnedIdx = injected.indexOf('## Learned Procedural Rules (memory)');
    assert.ok(opIdx >= 0 && learnedIdx > opIdx);
  });
});
