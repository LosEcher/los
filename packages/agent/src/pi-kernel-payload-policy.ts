import type { ModelSettings } from './model-settings.js';
import type { ModelProfile } from './model-profiles.js';

export function _applyPiProviderPayloadPolicy(
  payload: unknown,
  profile: ModelProfile,
  modelSettings?: ModelSettings,
): unknown {
  if (profile.apiShape !== 'openai-chat-completions') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const governed = { ...record };
  let changed = false;
  if (modelSettings?.maxTokens === undefined) {
    changed = deletePayloadField(governed, 'max_completion_tokens') || changed;
    changed = deletePayloadField(governed, 'max_tokens') || changed;
  }
  if (modelSettings?.reasoningEffort === undefined && modelSettings?.thinking === undefined) {
    changed = deletePayloadField(governed, 'thinking') || changed;
    changed = deletePayloadField(governed, 'reasoning_effort') || changed;
  }
  if (!profile.supportsParallelToolCalls && Array.isArray(record.tools) && record.tools.length > 0
      && record.parallel_tool_calls !== false) {
    governed.parallel_tool_calls = false;
    changed = true;
  }
  return changed ? governed : payload;
}

function deletePayloadField(payload: Record<string, unknown>, field: string): boolean {
  if (!(field in payload)) return false;
  delete payload[field];
  return true;
}
