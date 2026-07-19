export type MCPAdapterConfig =
  | { kind: 'generic' }
  | {
      kind: 'cantool';
      providerId: 'cantool.mcp.local';
      providerLocation: 'local';
      dataGrantOwner: 'cantool';
      sessionBinding: 'per_call';
    };

export type CanToolDataClassification =
  | 'public'
  | 'caller_supplied'
  | 'local_metadata'
  | 'local_private'
  | 'secret'
  | 'unknown';

export interface MCPDiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface CanToolCapabilityProjection {
  capabilityId: string;
  dataClassification: CanToolDataClassification;
  providerId: 'cantool.mcp.local';
  providerLocation: 'local';
  availability: 'available' | 'blocked';
  reason:
    | 'reviewed_initial_capability'
    | 'data_grant_forwarding_unavailable'
    | 'secret_capability_not_exposed'
    | 'mcp_annotations_missing_or_unsafe'
    | 'capability_not_reviewed';
  approvalMode: 'none' | 'cantool_data_grant' | 'not_available';
  grantRequired: boolean;
  sessionBinding: 'per_call';
  cancellation: 'mcp_notification_late_result_discarded';
  resume: 'new_call_only';
  readOnly: boolean;
  idempotent: boolean;
}

export interface CanToolGrantBindingEvidence {
  providerId: string;
  providerLocation: 'local' | 'online';
  sessionId: string;
  expiresAt: string;
  revoked?: boolean;
}

export interface CanToolDisclosureContext {
  providerId: string;
  providerLocation: 'local' | 'online';
  sessionId: string;
  observedAt?: string;
  grant?: CanToolGrantBindingEvidence;
}

export interface CanToolDisclosureDecision {
  allowed: false;
  reason:
    | 'grant_required'
    | 'grant_revoked'
    | 'grant_expired'
    | 'provider_mismatch'
    | 'provider_location_mismatch'
    | 'session_mismatch'
    | 'data_grant_forwarding_unavailable';
}

const CANTOOL_METADATA_CAPABILITIES = new Set([
  'agent.resource.read',
  'clipboard.stats',
  'file.index_status',
]);

const CANTOOL_PRIVATE_CAPABILITIES = new Set([
  'clipboard.get',
  'clipboard.search',
  'file.read_excerpt',
  'file.recent',
  'file.search',
  'snippet.get',
  'snippet.search',
]);

const CANTOOL_SECRET_CAPABILITIES = new Set([
  'generate_password',
  'jwt_verify',
]);

const CANTOOL_CALLER_SUPPLIED_CAPABILITIES = new Set([
  'ascii_to_hex',
  'base64_decode',
  'base64_encode',
  'case_convert',
  'cidr_info',
  'cron_describe',
  'css_format',
  'csv_to_json',
  'generate_address',
  'generate_nanoid',
  'generate_person_name',
  'generate_qr_code',
  'generate_random',
  'generate_random_number',
  'generate_random_text',
  'generate_uuid',
  'get_current_timestamp',
  'get_current_timestamp_millis',
  'hex_to_ascii',
  'html_entity_decode',
  'html_entity_encode',
  'http_status_lookup',
  'ipv4_in_cidr',
  'js_format',
  'json_format',
  'json_inspect',
  'json_to_csv',
  'json_to_toml',
  'json_to_yaml',
  'json_validate',
  'jwt_decode',
  'lines_process',
  'list_convert',
  'number_base_convert',
  'sql_format',
  'string_inspect',
  'string_length',
  'text_lowercase',
  'text_uppercase',
  'timestamp_convert',
  'toml_to_json',
  'url_decode',
  'url_encode',
  'url_parse',
  'xml_format',
  'yaml_to_json',
]);

const CANTOOL_PUBLIC_CAPABILITIES = new Set([
  'calculator.evaluate',
  'regex.explain',
  'regex.replace',
  'regex.test',
  'unit.convert',
]);

export function normalizeMCPAdapterConfig(value: unknown): MCPAdapterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'generic' };
  const kind = (value as Record<string, unknown>).kind;
  if (kind === undefined || kind === 'generic') return { kind: 'generic' };
  if (kind !== 'cantool') throw new Error('MCP adapter kind must be generic or cantool');
  return {
    kind: 'cantool',
    providerId: 'cantool.mcp.local',
    providerLocation: 'local',
    dataGrantOwner: 'cantool',
    sessionBinding: 'per_call',
  };
}

export function projectCanToolCapability(tool: MCPDiscoveredTool): CanToolCapabilityProjection {
  const dataClassification = classifyCanToolCapability(tool.name);
  const readOnly = tool.annotations?.readOnlyHint === true
    && tool.annotations.destructiveHint === false
    && tool.annotations.openWorldHint === false;
  const idempotent = tool.annotations?.idempotentHint === true;
  let availability: CanToolCapabilityProjection['availability'] = 'blocked';
  let reason: CanToolCapabilityProjection['reason'] = 'capability_not_reviewed';
  let approvalMode: CanToolCapabilityProjection['approvalMode'] = 'not_available';

  if (!readOnly) {
    reason = 'mcp_annotations_missing_or_unsafe';
  } else if (dataClassification === 'local_private') {
    reason = 'data_grant_forwarding_unavailable';
    approvalMode = 'cantool_data_grant';
  } else if (dataClassification === 'secret') {
    reason = 'secret_capability_not_exposed';
  } else if (dataClassification !== 'unknown') {
    availability = 'available';
    reason = 'reviewed_initial_capability';
    approvalMode = 'none';
  }

  return {
    capabilityId: tool.name,
    dataClassification,
    providerId: 'cantool.mcp.local',
    providerLocation: 'local',
    availability,
    reason,
    approvalMode,
    grantRequired: dataClassification === 'local_private',
    sessionBinding: 'per_call',
    cancellation: 'mcp_notification_late_result_discarded',
    resume: 'new_call_only',
    readOnly,
    idempotent,
  };
}

export function normalizeCanToolPolicy(policy: {
  allow: string[];
  deny: string[];
  riskLevel: 'L0' | 'L1' | 'L2';
}): { allow: string[]; deny: string[]; riskLevel: 'L0' } {
  const reviewed = reviewedCanToolCapabilityIds();
  const requested = policy.allow.length > 0 ? policy.allow : reviewed;
  const unsupported = requested.filter(name => !reviewed.includes(name));
  if (unsupported.length > 0) {
    throw new Error(`CanTool adapter does not allow unreviewed capabilities: ${unsupported.join(', ')}`);
  }
  return {
    allow: requested.filter(name => !policy.deny.includes(name)).sort(),
    deny: [...policy.deny].sort(),
    riskLevel: 'L0',
  };
}

export function _assessCanToolPrivateDisclosure(
  context: CanToolDisclosureContext,
): CanToolDisclosureDecision {
  const grant = context.grant;
  if (!grant) return { allowed: false, reason: 'grant_required' };
  if (grant.revoked) return { allowed: false, reason: 'grant_revoked' };
  const observedAt = Date.parse(context.observedAt ?? new Date().toISOString());
  if (!Number.isFinite(observedAt) || Date.parse(grant.expiresAt) <= observedAt) {
    return { allowed: false, reason: 'grant_expired' };
  }
  if (grant.providerId !== context.providerId) return { allowed: false, reason: 'provider_mismatch' };
  if (grant.providerLocation !== context.providerLocation) {
    return { allowed: false, reason: 'provider_location_mismatch' };
  }
  if (grant.sessionId !== context.sessionId) return { allowed: false, reason: 'session_mismatch' };
  return { allowed: false, reason: 'data_grant_forwarding_unavailable' };
}

export function summarizeCanToolCapabilities(
  projections: CanToolCapabilityProjection[],
): { projected: number; available: number; blocked: number; byDataClassification: Record<string, number> } {
  const byDataClassification: Record<string, number> = {};
  for (const projection of projections) {
    byDataClassification[projection.dataClassification] =
      (byDataClassification[projection.dataClassification] ?? 0) + 1;
  }
  const available = projections.filter(item => item.availability === 'available').length;
  return {
    projected: projections.length,
    available,
    blocked: projections.length - available,
    byDataClassification,
  };
}

function classifyCanToolCapability(name: string): CanToolDataClassification {
  if (CANTOOL_METADATA_CAPABILITIES.has(name)) return 'local_metadata';
  if (CANTOOL_PRIVATE_CAPABILITIES.has(name)) return 'local_private';
  if (CANTOOL_SECRET_CAPABILITIES.has(name)) return 'secret';
  if (CANTOOL_CALLER_SUPPLIED_CAPABILITIES.has(name)) return 'caller_supplied';
  if (CANTOOL_PUBLIC_CAPABILITIES.has(name)) return 'public';
  return 'unknown';
}

function reviewedCanToolCapabilityIds(): string[] {
  return [
    ...CANTOOL_METADATA_CAPABILITIES,
    ...CANTOOL_CALLER_SUPPLIED_CAPABILITIES,
    ...CANTOOL_PUBLIC_CAPABILITIES,
  ].sort();
}
