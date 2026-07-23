import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface PiKernelShadowWorkspaceFixtureDefinition {
  kind: 'json_string_field';
  relativePath: string;
  field: string;
  expectedValue: string;
}

export interface PiKernelShadowWorkspaceFixtureEvidence {
  kind: 'json_string_field';
  fixtureIdentityHash: string;
  contentValueHash: string;
}

export async function _verifyPiKernelShadowWorkspaceFixture(
  definition: PiKernelShadowWorkspaceFixtureDefinition,
  workspaceRoot: string,
): Promise<PiKernelShadowWorkspaceFixtureEvidence> {
  const root = resolve(workspaceRoot);
  const fixturePath = resolve(root, definition.relativePath);
  const relativePath = relative(root, fixturePath);
  if (!relativePath || isAbsolute(relativePath) || relativePath === '..'
    || relativePath.startsWith('../') || relativePath.startsWith('..\\')) {
    throw new Error(`Pi shadow workspace fixture escapes workspace root: ${definition.relativePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Pi shadow workspace fixture is unreadable: ${definition.relativePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Pi shadow workspace fixture is not a JSON object: ${definition.relativePath}`);
  }
  const actualValue = (parsed as Record<string, unknown>)[definition.field];
  if (actualValue !== definition.expectedValue) {
    throw new Error(`Pi shadow workspace fixture field mismatch: ${definition.relativePath}#${definition.field}`);
  }
  return expectedEvidence(definition);
}

export function _matchesPiKernelShadowWorkspaceFixture(
  definition: PiKernelShadowWorkspaceFixtureDefinition | undefined,
  evidence: PiKernelShadowWorkspaceFixtureEvidence | undefined,
): boolean {
  if (!definition) return evidence === undefined;
  if (!evidence) return false;
  const expected = expectedEvidence(definition);
  return evidence.kind === expected.kind
    && evidence.fixtureIdentityHash === expected.fixtureIdentityHash
    && evidence.contentValueHash === expected.contentValueHash;
}

export function _parsePiKernelShadowWorkspaceFixtureEvidence(
  value: unknown,
): PiKernelShadowWorkspaceFixtureEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'json_string_field'
    || typeof record.fixtureIdentityHash !== 'string'
    || typeof record.contentValueHash !== 'string') return undefined;
  return {
    kind: record.kind,
    fixtureIdentityHash: record.fixtureIdentityHash,
    contentValueHash: record.contentValueHash,
  };
}

function expectedEvidence(
  definition: PiKernelShadowWorkspaceFixtureDefinition,
): PiKernelShadowWorkspaceFixtureEvidence {
  return {
    kind: definition.kind,
    fixtureIdentityHash: sha256(JSON.stringify({
      kind: definition.kind,
      relativePath: definition.relativePath,
      field: definition.field,
    })),
    contentValueHash: sha256(JSON.stringify(definition.expectedValue)),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
