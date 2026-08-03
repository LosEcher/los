/**
 * OnboardingPage — step-by-step wizard for first-time setup.
 *
 * Steps:
 *   1. Provider — configure at least one AI provider API key.
 *   2. Verify — run compatibility check on the provider.
 *   3. Project — bind a workspace directory.
 *   4. Chat — ready to start.
 *
 * Auto-appears when no providers are configured; always accessible
 * from Setup page or nav. Each step auto-detects completion state.
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CheckCircle2,
  Circle,
  ArrowRight,
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  Wrench,
  Brain,
  FolderOpen,
  MessageSquare,
  Play,
} from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { useI18n } from '../i18n';

// ── Types ──────────────────────────────────────────────

interface ProviderDiscovery {
  name: string;
  displayName?: string;
  ready: boolean;
  blocker?: string;
  setupAction?: string;
  promotionState?: string;
  models?: Array<{ id: string; default?: boolean }>;
  source: string;
}

interface OnboardingReport {
  providers: ProviderDiscovery[];
  tools: Array<{ name: string; available: boolean }>;
  summary: {
    readyProviders: number;
    totalProviders: number;
    ready: boolean;
    messages: string[];
  };
}

interface ProjectInfo {
  defaultProjectId?: string;
  workspacePath?: string;
}

type Step = 'provider' | 'verify' | 'project' | 'chat';

// ── Step definitions ───────────────────────────────────

const STEPS: Array<{ id: Step; label: string; icon: typeof Wrench }> = [
  { id: 'provider', label: 'pages.onboarding.step.provider', icon: Brain },
  { id: 'verify', label: 'pages.onboarding.step.verify', icon: Play },
  { id: 'project', label: 'pages.onboarding.step.project', icon: FolderOpen },
  { id: 'chat', label: 'nav.chat', icon: MessageSquare },
];

// ── Component ──────────────────────────────────────────

export function OnboardingPage({ onReady }: { onReady?: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const { t } = useI18n();

  const onboarding = useQuery<OnboardingReport>({
    queryKey: ['onboarding'],
    queryFn: () => getJson<OnboardingReport>('/onboarding'),
    refetchInterval: 10_000,
  });

  const projectsQuery = useQuery<{ projects?: Record<string, ProjectInfo>; defaultProjectId?: string }>({
    queryKey: ['projects'],
    queryFn: () => getJson('/projects'),
    staleTime: 30_000,
  });

  const data = onboarding.data;
  const projects = projectsQuery.data;
  const hasProject = Boolean(projects?.defaultProjectId);
  const readyProviders = data?.providers.filter(p => p.ready) ?? [];
  const hasReadyProvider = readyProviders.length > 0;
  const hasAnyProvider = (data?.providers.length ?? 0) > 0;

  // Derive step completion
  const stepDone: Record<Step, boolean> = {
    provider: hasAnyProvider,
    verify: hasReadyProvider,
    project: hasProject,
    chat: hasReadyProvider && hasProject,
  };

  const currentStep = STEPS[stepIndex]!;
  const isLastStep = stepIndex === STEPS.length - 1;

  if (onboarding.isLoading) {
    return <div className="onboarding-page"><div className="onboarding-loading">{t('pages.onboarding.scanning')}</div></div>;
  }

  return (
    <div className="onboarding-page">
      <div className="onboarding-card">
        {/* Progress bar */}
        <div className="onboarding-steps">
          {STEPS.map((step, i) => {
            const done = stepDone[step.id];
            const active = i === stepIndex;
            const Icon = step.icon;
            return (
              <button
                key={step.id}
                type="button"
                className={`onboarding-step ${active ? 'active' : ''} ${done ? 'done' : ''}`}
                onClick={() => setStepIndex(i)}
              >
                <span className="onboarding-step-icon">
                  {done ? <CheckCircle2 size={14} /> : active ? <Circle size={14} fill="currentColor" /> : <Circle size={14} />}
                </span>
                <Icon size={14} />
                <span className="onboarding-step-label">{t(step.label)}</span>
              </button>
            );
          })}
        </div>

        {/* Step content */}
        <div className="onboarding-body">
          {currentStep.id === 'provider' && (
            <ProviderStep
              providers={data?.providers ?? []}
              hasAnyProvider={hasAnyProvider}
            />
          )}

          {currentStep.id === 'verify' && (
            <VerifyStep
              readyProviders={readyProviders}
              hasReadyProvider={hasReadyProvider}
            />
          )}

          {currentStep.id === 'project' && (
            <ProjectStep
              hasProject={hasProject}
              defaultProjectId={projects?.defaultProjectId}
            />
          )}

          {currentStep.id === 'chat' && (
            <ChatStep
              allDone={stepDone.provider && stepDone.verify && stepDone.project}
              onReady={onReady}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="onboarding-nav">
          {stepIndex > 0 ? (
            <button type="button" className="btn-secondary" onClick={() => setStepIndex(i => i - 1)}>
              <ArrowLeft size={14} /> {t('common.back')}
            </button>
          ) : <span />}
          {!isLastStep ? (
            <button type="button" className="btn-primary" onClick={() => setStepIndex(i => i + 1)}>
              {stepDone[currentStep.id] ? t('pages.onboarding.continue') : t('pages.onboarding.skip')} <ArrowRight size={14} />
            </button>
          ) : (
            stepDone.chat ? (
              <button type="button" className="btn-primary" onClick={() => onReady?.()}>
                {t('pages.onboarding.startChatting')} <MessageSquare size={14} />
              </button>
            ) : (
              <span className="onboarding-hint">{t('pages.onboarding.completeStepsHint')}</span>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ── Step: Provider ─────────────────────────────────────

function ProviderStep({ providers, hasAnyProvider }: { providers: ProviderDiscovery[]; hasAnyProvider: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const { t } = useI18n();

  if (hasAnyProvider) {
    return (
      <div className="onboarding-step-content">
        <h2>{t('pages.onboarding.providersDetected')}</h2>
        <p className="onboarding-desc">
          {t('pages.onboarding.providersFound', { count: providers.length, s: providers.length !== 1 ? 's' : '' })}{' '}
          {providers.filter(p => p.ready).length > 0
            ? t('pages.onboarding.atLeastOneReady')
            : t('pages.onboarding.runCompatCheck')}
        </p>
        <ul className="onboarding-provider-list">
          {providers.map(p => (
            <li key={p.name} className={p.ready ? 'ready' : ''}>
              <span className="onboarding-provider-name">{p.displayName ?? p.name}</span>
              <span className={`pill pill-${p.ready ? 'ok' : 'warn'}`}>{p.ready ? t('pages.status.ready') : t('pages.status.pending')}</span>
              {p.blocker ? <span className="onboarding-blocker">{p.blocker}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="onboarding-step-content">
      <h2>{t('pages.onboarding.addProvider')}</h2>
      <p className="onboarding-desc">
        {t('pages.onboarding.addProviderDesc')}
      </p>

      <div className="onboarding-provider-setup">
        <div className="onboarding-setup-card">
          <h3>{t('pages.onboarding.optionEnvVar')}</h3>
          <p>{t('pages.onboarding.envVarHint', { file: '.env' })}</p>
          <div className="onboarding-code-list">
            {[
              { name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', cmd: 'export DEEPSEEK_API_KEY=sk-xxx' },
              { name: 'OpenAI', env: 'OPENAI_API_KEY', cmd: 'export OPENAI_API_KEY=sk-xxx' },
              { name: 'Anthropic', env: 'ANTHROPIC_API_KEY', cmd: 'export ANTHROPIC_API_KEY=sk-xxx' },
            ].map(p => (
              <div key={p.env} className="onboarding-code-item">
                <span className="onboarding-code-label">{p.name}</span>
                <code>{p.cmd}</code>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => { navigator.clipboard.writeText(p.cmd).catch(() => {}); setCopied(p.env); setTimeout(() => setCopied(null), 1500); }}
                >
                  {copied === p.env ? t('pages.onboarding.copied') : t('pages.onboarding.copy')}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="onboarding-setup-card">
          <h3>{t('pages.onboarding.optionAccountFile')}</h3>
          <p>{t('pages.onboarding.accountFileHint', { path: '~/.los/accounts/deepseek.json' })}</p>
          <pre className="onboarding-code-block">{`{
  "provider": "deepseek",
  "api_key": "sk-xxx",
  "model": "deepseek-v4-flash"
}`}</pre>
        </div>

        <div className="onboarding-setup-card">
          <h3>{t('pages.onboarding.optionLocalModel')}</h3>
          <p>{t('pages.onboarding.autoDetect')}</p>
        </div>

        <p className="onboarding-note">
          {t('pages.onboarding.restartHint')}
          <button type="button" className="btn-ghost btn-sm" onClick={() => window.location.reload()}>
            <RefreshCw size={12} /> {t('pages.onboarding.refresh')}
          </button>
        </p>
      </div>
    </div>
  );
}

// ── Step: Verify ───────────────────────────────────────

function VerifyStep({ readyProviders, hasReadyProvider }: { readyProviders: ProviderDiscovery[]; hasReadyProvider: boolean }) {
  const { t } = useI18n();
  if (hasReadyProvider) {
    return (
      <div className="onboarding-step-content">
        <h2>{t('pages.onboarding.providerReady')}</h2>
        <p className="onboarding-desc">
          {t('pages.onboarding.verifiedReady', { count: readyProviders.length, plural: readyProviders.length !== 1 ? 's are' : ' is' })}
        </p>
        <ul className="onboarding-provider-list">
          {readyProviders.map(p => (
            <li key={p.name} className="ready">
              <span className="onboarding-provider-name">{p.displayName ?? p.name}</span>
              <span className="pill pill-ok">{t('pages.status.ready')}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="onboarding-step-content">
      <h2>{t('pages.onboarding.verifyCompatTitle')}</h2>
      <p className="onboarding-desc">
        {t('pages.onboarding.verifyDesc')}
      </p>

      <div className="onboarding-setup-card">
        <h3>{t('pages.onboarding.fromTerminal')}</h3>
        <div className="onboarding-code-list">
          <div className="onboarding-code-item">
            <code>los compat --execute</code>
            <span className="onboarding-code-desc">{t('pages.onboarding.compatAllHint')}</span>
          </div>
          <div className="onboarding-code-item">
            <code>los compat deepseek</code>
            <span className="onboarding-code-desc">{t('pages.onboarding.compatSpecificHint')}</span>
          </div>
        </div>
      </div>

      <div className="onboarding-setup-card">
        <h3>{t('pages.onboarding.orFromProviders')}</h3>
        <p>
          {t('pages.onboarding.goTo')} <button type="button" className="link-btn" onClick={() => window.location.hash = 'providers'}>
            <ExternalLink size={12} /> {t('nav.providers')}
          </button>{' '}
          {t('pages.onboarding.clickCompat')} <strong>{t('pages.onboarding.compat')}</strong>{' '}
          {t('pages.onboarding.compatRowHint')}
        </p>
      </div>
    </div>
  );
}

// ── Step: Project ──────────────────────────────────────

function ProjectStep({ hasProject, defaultProjectId }: { hasProject: boolean; defaultProjectId?: string }) {
  const { t } = useI18n();
  if (hasProject) {
    return (
      <div className="onboarding-step-content">
        <h2>{t('pages.onboarding.projectBound')}</h2>
        <p className="onboarding-desc">
          {t('pages.onboarding.activeProject', { id: defaultProjectId ?? '' })}{' '}
          {t('pages.onboarding.switchProjectsHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-step-content">
      <h2>{t('pages.onboarding.bindProject')}</h2>
      <p className="onboarding-desc">
        {t('pages.onboarding.bindProjectDesc')}
      </p>

      <div className="onboarding-setup-card">
        <h3>{t('pages.onboarding.fromChatPage')}</h3>
        <ol className="onboarding-steps-list">
          <li>{t('pages.onboarding.goTo')} <button type="button" className="link-btn" onClick={() => window.location.hash = 'chat'}>{t('nav.chat')} <ExternalLink size={10} /></button></li>
          <li>{t('pages.onboarding.selectorHint')}</li>
          <li>{t('pages.onboarding.chooseDirHint')}</li>
        </ol>
      </div>

      <div className="onboarding-setup-card">
        <h3>{t('pages.onboarding.orFromSettings')}</h3>
        <p>
          {t('pages.onboarding.goTo')} <button type="button" className="link-btn" onClick={() => window.location.hash = 'settings'}>{t('nav.settings')} <ExternalLink size={10} /></button>
          {' '}{t('pages.onboarding.projectsSectionHint')}
        </p>
      </div>
    </div>
  );
}

// ── Step: Chat ─────────────────────────────────────────

function ChatStep({ allDone, onReady }: { allDone: boolean; onReady?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="onboarding-step-content">
      <h2>{allDone ? t('pages.onboarding.readyToGo') : t('pages.onboarding.almostThere')}</h2>
      <p className="onboarding-desc">
        {allDone
          ? t('pages.onboarding.readyDesc')
          : t('pages.onboarding.almostDesc')}
      </p>

      {allDone ? (
        <div className="onboarding-ready">
          <div className="onboarding-ready-check"><CheckCircle2 size={48} /></div>
          <p>{t('pages.onboarding.everythingReady')}</p>
          <button
            type="button"
            className="btn-primary btn-lg"
            onClick={() => { window.location.hash = 'chat'; onReady?.(); }}
          >
            <MessageSquare size={16} /> {t('pages.onboarding.openChat')}
          </button>
          <p className="onboarding-note">
            {t('pages.onboarding.returnTo')}{' '}
            <button type="button" className="link-btn" onClick={() => window.location.hash = 'setup'}>{t('nav.setup')}</button>
            {' '}{t('pages.onboarding.checkReadiness')}
          </p>
        </div>
      ) : (
        <ul className="onboarding-todo-list">
          {!allDone ? <li>{t('pages.onboarding.todoConfigureProvider')}</li> : null}
          {!allDone ? <li>{t('pages.onboarding.todoVerifyProvider')}</li> : null}
          {!allDone ? <li>{t('pages.onboarding.todoBindProject')}</li> : null}
        </ul>
      )}
    </div>
  );
}
