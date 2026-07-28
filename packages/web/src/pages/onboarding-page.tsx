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
  { id: 'provider', label: 'Provider', icon: Brain },
  { id: 'verify', label: 'Verify', icon: Play },
  { id: 'project', label: 'Project', icon: FolderOpen },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
];

// ── Component ──────────────────────────────────────────

export function OnboardingPage({ onReady }: { onReady?: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);

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
    return <div className="onboarding-page"><div className="onboarding-loading">Scanning environment…</div></div>;
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
                <span className="onboarding-step-label">{step.label}</span>
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
              <ArrowLeft size={14} /> Back
            </button>
          ) : <span />}
          {!isLastStep ? (
            <button type="button" className="btn-primary" onClick={() => setStepIndex(i => i + 1)}>
              {stepDone[currentStep.id] ? 'Continue' : 'Skip'} <ArrowRight size={14} />
            </button>
          ) : (
            stepDone.chat ? (
              <button type="button" className="btn-primary" onClick={() => onReady?.()}>
                Start Chatting <MessageSquare size={14} />
              </button>
            ) : (
              <span className="onboarding-hint">Complete the steps above to continue.</span>
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

  if (hasAnyProvider) {
    return (
      <div className="onboarding-step-content">
        <h2>Providers detected</h2>
        <p className="onboarding-desc">
          los found {providers.length} provider{providers.length !== 1 ? 's' : ''}.
          {providers.filter(p => p.ready).length > 0
            ? ' At least one is ready to use.'
            : ' Run a compatibility check to verify they work.'}
        </p>
        <ul className="onboarding-provider-list">
          {providers.map(p => (
            <li key={p.name} className={p.ready ? 'ready' : ''}>
              <span className="onboarding-provider-name">{p.displayName ?? p.name}</span>
              <span className={`pill pill-${p.ready ? 'ok' : 'warn'}`}>{p.ready ? 'ready' : 'pending'}</span>
              {p.blocker ? <span className="onboarding-blocker">{p.blocker}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="onboarding-step-content">
      <h2>Add a provider</h2>
      <p className="onboarding-desc">
        los needs at least one AI provider to work. Set an API key environment
        variable and restart, or add an account file.
      </p>

      <div className="onboarding-provider-setup">
        <div className="onboarding-setup-card">
          <h3>Option 1: Environment variable</h3>
          <p>Set one of these in your <code>.env</code> file or environment:</p>
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
                  {copied === p.env ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="onboarding-setup-card">
          <h3>Option 2: Account file</h3>
          <p>Create a JSON file at <code>~/.los/accounts/deepseek.json</code>:</p>
          <pre className="onboarding-code-block">{`{
  "provider": "deepseek",
  "api_key": "sk-xxx",
  "model": "deepseek-v4-flash"
}`}</pre>
        </div>

        <div className="onboarding-setup-card">
          <h3>Option 3: Local model</h3>
          <p>los auto-detects Ollama (port 11434), LM Studio (1234), and vLLM (8000).</p>
        </div>

        <p className="onboarding-note">
          After configuring a provider, restart los and return here.
          <button type="button" className="btn-ghost btn-sm" onClick={() => window.location.reload()}>
            <RefreshCw size={12} /> Refresh
          </button>
        </p>
      </div>
    </div>
  );
}

// ── Step: Verify ───────────────────────────────────────

function VerifyStep({ readyProviders, hasReadyProvider }: { readyProviders: ProviderDiscovery[]; hasReadyProvider: boolean }) {
  if (hasReadyProvider) {
    return (
      <div className="onboarding-step-content">
        <h2>Provider ready</h2>
        <p className="onboarding-desc">
          {readyProviders.length} provider{readyProviders.length !== 1 ? 's are' : ' is'} verified and ready:
        </p>
        <ul className="onboarding-provider-list">
          {readyProviders.map(p => (
            <li key={p.name} className="ready">
              <span className="onboarding-provider-name">{p.displayName ?? p.name}</span>
              <span className="pill pill-ok">ready</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="onboarding-step-content">
      <h2>Verify provider compatibility</h2>
      <p className="onboarding-desc">
        Run a compatibility check to confirm your provider works with los.
      </p>

      <div className="onboarding-setup-card">
        <h3>From the terminal</h3>
        <div className="onboarding-code-list">
          <div className="onboarding-code-item">
            <code>los compat --execute</code>
            <span className="onboarding-code-desc">Run compatibility checks on all configured providers</span>
          </div>
          <div className="onboarding-code-item">
            <code>los compat deepseek</code>
            <span className="onboarding-code-desc">Check a specific provider</span>
          </div>
        </div>
      </div>

      <div className="onboarding-setup-card">
        <h3>Or from the Providers page</h3>
        <p>
          Go to <button type="button" className="link-btn" onClick={() => window.location.hash = 'providers'}>
            <ExternalLink size={12} /> Providers
          </button> and click <strong>Compat</strong> on a provider row.
        </p>
      </div>
    </div>
  );
}

// ── Step: Project ──────────────────────────────────────

function ProjectStep({ hasProject, defaultProjectId }: { hasProject: boolean; defaultProjectId?: string }) {
  if (hasProject) {
    return (
      <div className="onboarding-step-content">
        <h2>Project bound</h2>
        <p className="onboarding-desc">
          Active project: <strong>{defaultProjectId}</strong>.
          You can switch projects from the Chat page.
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-step-content">
      <h2>Bind a project</h2>
      <p className="onboarding-desc">
        Projects are workspace directories where los reads and writes files.
        Bind a project to give the agent access to your code.
      </p>

      <div className="onboarding-setup-card">
        <h3>From the Chat page</h3>
        <ol className="onboarding-steps-list">
          <li>Go to <button type="button" className="link-btn" onClick={() => window.location.hash = 'chat'}>Chat <ExternalLink size={10} /></button></li>
          <li>Click the project selector dropdown (top of chat panel)</li>
          <li>Choose a directory to bind as your project workspace</li>
        </ol>
      </div>

      <div className="onboarding-setup-card">
        <h3>Or from Settings</h3>
        <p>
          Go to <button type="button" className="link-btn" onClick={() => window.location.hash = 'settings'}>Settings <ExternalLink size={10} /></button>
          {' '}&rarr; Projects section to manage bound projects.
        </p>
      </div>
    </div>
  );
}

// ── Step: Chat ─────────────────────────────────────────

function ChatStep({ allDone, onReady }: { allDone: boolean; onReady?: () => void }) {
  return (
    <div className="onboarding-step-content">
      <h2>{allDone ? 'Ready to go!' : 'Almost there'}</h2>
      <p className="onboarding-desc">
        {allDone
          ? 'Your los agent is configured and ready. Start chatting!'
          : 'Finish the remaining steps above, then start chatting with your agent.'}
      </p>

      {allDone ? (
        <div className="onboarding-ready">
          <div className="onboarding-ready-check"><CheckCircle2 size={48} /></div>
          <p>Provider verified, project bound — everything is ready.</p>
          <button
            type="button"
            className="btn-primary btn-lg"
            onClick={() => { window.location.hash = 'chat'; onReady?.(); }}
          >
            <MessageSquare size={16} /> Open Chat
          </button>
          <p className="onboarding-note">
            You can always return to{' '}
            <button type="button" className="link-btn" onClick={() => window.location.hash = 'setup'}>Setup</button>
            {' '}to check readiness.
          </p>
        </div>
      ) : (
        <ul className="onboarding-todo-list">
          {!allDone ? <li>Configure a provider on Step 1</li> : null}
          {!allDone ? <li>Verify the provider on Step 2</li> : null}
          {!allDone ? <li>Bind a project on Step 3</li> : null}
        </ul>
      )}
    </div>
  );
}
