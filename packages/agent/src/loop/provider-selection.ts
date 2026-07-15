import { resolveProviderModelPolicy } from '../providers/provider-policy.js';
import type { AgentConfig } from './types.js';

export function resolveAgentRunProviderModelSelection(
  config: Pick<AgentConfig, 'provider' | 'model' | 'architectEditor'>,
) {
  const editorMode = config.architectEditor?.enabled === true;
  const requestedProvider = editorMode
    ? (config.architectEditor!.editorProvider ?? config.provider)
    : config.provider;
  const requestedModel = editorMode ? config.architectEditor!.editorModel : config.model;
  const architectEditorOverride = editorMode && Boolean(
    config.architectEditor!.editorProvider || config.architectEditor!.editorModel,
  );

  return resolveProviderModelPolicy({
    explicit: { provider: requestedProvider, model: requestedModel },
    fallback: {},
    sources: {
      evidence: 'configured_default',
      target: 'configured_default',
      explicit: architectEditorOverride
        ? 'architect_editor_override'
        : requestedModel
          ? 'explicit_model'
          : 'explicit_provider',
      fallback: 'configured_default',
    },
  });
}
