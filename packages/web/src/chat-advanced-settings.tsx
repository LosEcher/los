import { SlidersHorizontal } from 'lucide-react';
import { RunField } from './chat-ui.js';
import { useI18n } from './i18n';

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
  const { t } = useI18n();

  return (
    <details className="composer-advanced">
      <summary title={t('chat.adv.title')}>
        <SlidersHorizontal size={14} />
        {advancedCount > 0 ? <span className="filter-badge">{advancedCount}</span> : null}
      </summary>
      <div className="composer-advanced-panel">
        <RunField label={t('chat.adv.systemPrompt')} title={t('chat.adv.systemPromptTitle')} variant="panel">
          <textarea value={state.systemPrompt} onChange={e => onChange({ systemPrompt: e.target.value })} placeholder={t('chat.providerDefault')} rows={2} />
        </RunField>
        <RunField label={t('chat.adv.allowedTools')} title={t('chat.adv.allowedToolsTitle')} variant="panel">
          <input value={state.allowedTools} onChange={e => onChange({ allowedTools: e.target.value })} placeholder="read_file, write_file, search_codebase" />
        </RunField>
        <RunField label={t('chat.adv.maxTurns')} title={t('chat.adv.maxTurnsTitle')} variant="panel">
          <input type="number" min={1} max={100} value={state.maxLoops} onChange={e => onChange({ maxLoops: Number(e.target.value) })} />
        </RunField>
        <RunField label={t('chat.adv.timeoutMs')} title={t('chat.adv.timeoutMsTitle')} variant="panel">
          <input type="number" min={1000} step={1000} value={state.timeoutMs} onChange={e => onChange({ timeoutMs: Number(e.target.value) })} />
        </RunField>
        <RunField label={t('chat.adv.retryAttempts')} title={t('chat.adv.retryAttemptsTitle')} variant="panel">
          <input type="number" min={0} max={10} value={state.toolRetryMaxAttempts} onChange={e => onChange({ toolRetryMaxAttempts: e.target.value })} placeholder="3" />
          <input type="number" min={0} step={500} value={state.toolRetryBaseDelayMs} onChange={e => onChange({ toolRetryBaseDelayMs: e.target.value })} placeholder="1000" />
          <input type="number" min={0} step={1000} value={state.toolRetryMaxDelayMs} onChange={e => onChange({ toolRetryMaxDelayMs: e.target.value })} placeholder="30000" />
        </RunField>
        <RunField label={t('chat.adv.temperature')} title={t('chat.adv.temperatureTitle')} variant="panel">
          <input value={state.temperature} onChange={e => onChange({ temperature: e.target.value })} placeholder={t('chat.providerDefault')} />
        </RunField>
        <RunField label={t('chat.adv.topP')} title={t('chat.adv.topPTitle')} variant="panel">
          <input value={state.topP} onChange={e => onChange({ topP: e.target.value })} placeholder={t('chat.providerDefault')} />
        </RunField>
        <RunField label={t('chat.adv.maxTokens')} title={t('chat.adv.maxTokensTitle')} variant="panel">
          <input value={state.maxTokens} onChange={e => onChange({ maxTokens: e.target.value })} placeholder={t('chat.providerDefault')} />
        </RunField>
        <RunField label={t('chat.adv.presence')} title={t('chat.adv.presenceTitle')} variant="panel">
          <input value={state.presencePenalty} onChange={e => onChange({ presencePenalty: e.target.value })} placeholder={t('chat.providerDefault')} />
        </RunField>
        <RunField label={t('chat.adv.frequency')} title={t('chat.adv.frequencyTitle')} variant="panel">
          <input value={state.frequencyPenalty} onChange={e => onChange({ frequencyPenalty: e.target.value })} placeholder={t('chat.providerDefault')} />
        </RunField>
      </div>
    </details>
  );
}
