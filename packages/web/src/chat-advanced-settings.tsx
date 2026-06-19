import { SlidersHorizontal } from 'lucide-react';
import { RunField } from './chat-ui.js';

export interface ChatAdvancedSettingsState {
  systemPrompt: string;
  allowedTools: string;
  maxLoops: number;
  timeoutMs: number;
  toolRetryMaxAttempts: string;
  toolRetryBaseDelayMs: string;
  toolRetryMaxDelayMs: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  presencePenalty: string;
  frequencyPenalty: string;
}

export function ChatAdvancedSettings(props: {
  state: ChatAdvancedSettingsState;
  onChange: (patch: Partial<ChatAdvancedSettingsState>) => void;
  advancedCount: number;
}) {
  const { state, onChange, advancedCount } = props;

  return (
    <details className="composer-advanced">
      <summary title="Advanced request settings">
        <SlidersHorizontal size={14} />
        {advancedCount > 0 ? <span className="filter-badge">{advancedCount}</span> : null}
      </summary>
      <div className="composer-advanced-panel">
        <RunField label="system prompt" title="System prompt override" variant="panel">
          <textarea value={state.systemPrompt} onChange={e => onChange({ systemPrompt: e.target.value })} placeholder="provider default" rows={2} />
        </RunField>
        <RunField label="allowed tools" title="Comma-separated tool names to allow (empty = all)" variant="panel">
          <input value={state.allowedTools} onChange={e => onChange({ allowedTools: e.target.value })} placeholder="read_file, write_file, search_codebase" />
        </RunField>
        <RunField label="max turns" title="Hard cap on model turns (maxLoops)" variant="panel">
          <input type="number" min={1} max={100} value={state.maxLoops} onChange={e => onChange({ maxLoops: Number(e.target.value) })} />
        </RunField>
        <RunField label="timeout ms" title="Request timeout in milliseconds" variant="panel">
          <input type="number" min={1000} step={1000} value={state.timeoutMs} onChange={e => onChange({ timeoutMs: Number(e.target.value) })} />
        </RunField>
        <RunField label="tool retry attempts" title="Max tool call retry attempts" variant="panel">
          <input type="number" min={0} max={10} value={state.toolRetryMaxAttempts} onChange={e => onChange({ toolRetryMaxAttempts: e.target.value })} placeholder="3" />
          <input type="number" min={0} step={500} value={state.toolRetryBaseDelayMs} onChange={e => onChange({ toolRetryBaseDelayMs: e.target.value })} placeholder="1000" />
          <input type="number" min={0} step={1000} value={state.toolRetryMaxDelayMs} onChange={e => onChange({ toolRetryMaxDelayMs: e.target.value })} placeholder="30000" />
        </RunField>
        <RunField label="temperature" title="Sampling temperature" variant="panel">
          <input value={state.temperature} onChange={e => onChange({ temperature: e.target.value })} placeholder="provider default" />
        </RunField>
        <RunField label="top p" title="Nucleus sampling top_p" variant="panel">
          <input value={state.topP} onChange={e => onChange({ topP: e.target.value })} placeholder="provider default" />
        </RunField>
        <RunField label="max tokens" title="Model output token limit" variant="panel">
          <input value={state.maxTokens} onChange={e => onChange({ maxTokens: e.target.value })} placeholder="provider default" />
        </RunField>
        <RunField label="presence" title="Presence penalty" variant="panel">
          <input value={state.presencePenalty} onChange={e => onChange({ presencePenalty: e.target.value })} placeholder="provider default" />
        </RunField>
        <RunField label="frequency" title="Frequency penalty" variant="panel">
          <input value={state.frequencyPenalty} onChange={e => onChange({ frequencyPenalty: e.target.value })} placeholder="provider default" />
        </RunField>
      </div>
    </details>
  );
}
