/**
 * Environment handed to external runtimes (claude-code / codex / grok).
 *
 * Those CLIs legitimately need provider credentials, so this is not a "strip
 * every secret" filter. It is a **fail-closed allowlist**: the child gets the
 * shell basics, provider-credential-looking variables, and anything a caller
 * passes explicitly. los control-plane secrets (`LOS_*`, `EXECUTOR_*`, `DSH_*`)
 * never pass, even when their name looks like a provider key.
 *
 * Why: `run_runtime_task` runs the CLI in the gateway process — outside the
 * agent sandbox — and the spawn used to inherit `process.env` wholesale, so an
 * external agent could read the executor key and operator tokens from its own
 * environment.
 */

const PASSTHROUGH = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'PWD',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
]);

const PROVIDER_PREFIXES = [
  'ANTHROPIC_',
  'OPENAI_',
  'DEEPSEEK_',
  'XAI_',
  'GROK_',
  'GEMINI_',
  'GOOGLE_',
  'MOONSHOT_',
  'KIMI_',
  'OPENROUTER_',
  'AZURE_OPENAI_',
  'VERTEX_',
];

/** Provider credentials live under many names; this covers the common shapes. */
const PROVIDER_SUFFIX = /_(API_KEY|BASE_URL|AUTH_TOKEN|MODEL|PROJECT_ID)$/;

/** Never forwarded, even if a provider rule would otherwise match. */
const DENIED_PREFIXES = ['LOS_', 'EXECUTOR_', 'DSH_'];

function isAllowed(key: string): boolean {
  if (DENIED_PREFIXES.some(prefix => key.startsWith(prefix))) return false;
  if (PASSTHROUGH.has(key)) return true;
  if (PROVIDER_PREFIXES.some(prefix => key.startsWith(prefix))) return true;
  return PROVIDER_SUFFIX.test(key);
}

export function sanitizedRuntimeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!isAllowed(key)) continue;
    result[key] = value;
  }
  return result;
}

/** Sanitized base plus explicit caller overrides (the caller owns those). */
export function runtimeChildEnv(
  extra: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result = sanitizedRuntimeEnv(base);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
