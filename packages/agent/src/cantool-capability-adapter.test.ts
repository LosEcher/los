import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _assessCanToolPrivateDisclosure,
  normalizeCanToolPolicy,
  projectCanToolCapability,
} from './cantool-capability-adapter.js';

const safeAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function tool(name: string) {
  return { name, inputSchema: { type: 'object' }, annotations: safeAnnotations };
}

test('CanTool projection exposes reviewed status and transforms but blocks private and unknown capabilities', () => {
  assert.equal(projectCanToolCapability(tool('agent.resource.read')).availability, 'available');
  assert.equal(projectCanToolCapability(tool('json_format')).dataClassification, 'caller_supplied');
  assert.equal(projectCanToolCapability(tool('calculator.evaluate')).availability, 'available');

  const privateTool = projectCanToolCapability(tool('snippet.search'));
  assert.equal(privateTool.availability, 'blocked');
  assert.equal(privateTool.reason, 'data_grant_forwarding_unavailable');
  assert.equal(privateTool.grantRequired, true);

  const unknown = projectCanToolCapability(tool('future.local.read'));
  assert.equal(unknown.availability, 'blocked');
  assert.equal(unknown.reason, 'capability_not_reviewed');
});

test('CanTool projection fails closed when MCP safety annotations are absent or unsafe', () => {
  assert.equal(
    projectCanToolCapability({ name: 'json_format', inputSchema: { type: 'object' } }).reason,
    'mcp_annotations_missing_or_unsafe',
  );
  assert.equal(
    projectCanToolCapability({
      ...tool('json_format'),
      annotations: { ...safeAnnotations, destructiveHint: true },
    }).availability,
    'blocked',
  );
});

test('CanTool policy defaults to the reviewed L0 set and rejects private or unknown allow entries', () => {
  const defaults = normalizeCanToolPolicy({ allow: [], deny: [], riskLevel: 'L2' });
  assert.equal(defaults.riskLevel, 'L0');
  assert.equal(defaults.allow.includes('agent.resource.read'), true);
  assert.equal(defaults.allow.includes('snippet.search'), false);
  assert.throws(
    () => normalizeCanToolPolicy({ allow: ['snippet.search'], deny: [], riskLevel: 'L0' }),
    /unreviewed capabilities/,
  );
});

test('CanTool private disclosure preflight rejects missing, mismatched, expired, and cross-session grants', () => {
  const base = {
    providerId: 'cantool.mcp.local',
    providerLocation: 'local' as const,
    sessionId: 'session-a',
    observedAt: '2026-07-19T10:00:00.000Z',
  };
  const grant = {
    providerId: base.providerId,
    providerLocation: base.providerLocation,
    sessionId: base.sessionId,
    expiresAt: '2026-07-19T10:15:00.000Z',
  };

  assert.equal(_assessCanToolPrivateDisclosure(base).reason, 'grant_required');
  assert.equal(_assessCanToolPrivateDisclosure({ ...base, grant: { ...grant, providerLocation: 'online' } }).reason, 'provider_location_mismatch');
  assert.equal(_assessCanToolPrivateDisclosure({ ...base, grant: { ...grant, expiresAt: '2026-07-19T09:59:59.000Z' } }).reason, 'grant_expired');
  assert.equal(_assessCanToolPrivateDisclosure({ ...base, grant: { ...grant, sessionId: 'session-b' } }).reason, 'session_mismatch');
  assert.equal(_assessCanToolPrivateDisclosure({ ...base, grant }).reason, 'data_grant_forwarding_unavailable');
});
