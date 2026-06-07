/**
 * @los/cli/provider — Provider management commands.
 *
 *   los provider list            Show readiness summary with promotion states
 *   los provider promote <name>  Interactive setup guidance for a blocked provider
 */
// ── Types ───────────────────────────────────────────────

type ParsedArgs = {
  values: Record<string, string | boolean | number>;
  positionals: string[];
};

// ── Minimal arg parser (independent of index.ts) ────────

function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string | boolean | number> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        const key = arg.slice(2, eqIdx);
        values[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          values[key] = next;
          i++;
        } else {
          values[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        values[key] = next;
        i++;
      } else {
        values[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

interface DiscoveredProvider {
  name: string;
  hasApiKey?: boolean;
  ready?: boolean;
  available?: boolean;
  importable?: boolean;
  source?: string;
  defaultModel?: string;
  promotionState?: string;
  credentialClass?: string;
  setupAction?: string | null;
  compatibilityEvidence?: Array<Record<string, unknown>>;
  readiness?: {
    configuredKey?: boolean;
    ready?: boolean;
    promotionState?: string;
    credentialClass?: string;
    setupAction?: string | null;
  };
}

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function providerCommand(_globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const subcommand = parsed.positionals[0];

  if (!subcommand || subcommand === 'help') {
    printProviderHelp();
    return;
  }

  if (subcommand === 'list') {
    await listProviders(parsed);
    return;
  }

  if (subcommand === 'promote') {
    const name = parsed.positionals[1];
    if (!name) {
      console.error('los provider promote: provider name is required');
      console.error('Usage: los provider promote <name>');
      process.exit(2);
    }
    await promoteProvider(name, parsed);
    return;
  }

  console.error(`Unknown provider subcommand: ${subcommand}`);
  printProviderHelp();
  process.exit(2);
}

async function listProviders(parsed: ParsedArgs): Promise<void> {
  const gateway = stringFlag(parsed, 'gateway') ?? stringFlag(parsed, 'g') ?? DEFAULT_GATEWAY;
  const json = hasFlag(parsed, 'json');

  try {
    const response = await fetch(`${gateway}/onboarding`);
    if (!response.ok) {
      throw new Error(`Gateway returned ${response.status}`);
    }
    const report = await response.json() as Record<string, unknown>;
    const providers = (report.providers ?? []) as DiscoveredProvider[];

    if (json) {
      console.log(JSON.stringify(providers, null, 2));
      return;
    }

    console.log('Provider Readiness');
    console.log('─'.repeat(72));

    let ready = 0;
    let blocked = 0;

    for (const p of providers) {
      // Use readiness object if available, fallback to top-level fields
      const r = p.readiness;
      const isReady = r?.ready ?? p.ready ?? (p.hasApiKey && p.importable && p.available);
      const status = isReady ? '✓' : '✗';
      const state = r?.promotionState ?? p.promotionState ?? (isReady ? 'advisory' : 'blocked');
      const tier = `[${state}]`;
      const model = p.defaultModel ?? '(default)';
      if (isReady) ready++; else blocked++;

      console.log(
        `  ${status} ${p.name.padEnd(14)} ${tier.padEnd(20)} ` +
        `model=${model.padEnd(22)} source=${p.source ?? '?'}`,
      );

      const setupAction = r?.setupAction ?? p.setupAction;
      if (setupAction) {
        console.log(`    → ${setupAction}`);
      }
      const evidence = Array.isArray(p.compatibilityEvidence) ? p.compatibilityEvidence : [];
      if (evidence.length > 0) {
        for (const item of evidence.slice(0, 3)) {
          const id = stringValue(item.id) ?? '?';
          const probe = stringValue(item.probeId) ?? '?';
          const task = stringValue(item.taskRunId) ?? 'task?';
          const run = stringValue(item.runSpecId);
          const tokens = typeof item.totalTokens === 'number' ? item.totalTokens : 0;
          console.log(`    evidence ${id} probe=${probe} task=${task}${run ? ` run=${run}` : ''} tokens=${tokens}`);
        }
      } else if (isReady) {
        console.log(`    evidence none; verify with: los compat --execute --target ${p.name} --probe read-context --workspace .`);
      }
    }

    console.log('─'.repeat(72));
    console.log(`  ${ready} ready, ${blocked} blocked`);
    if (blocked > 0) {
      console.log('  Set up with: los provider promote <name>');
    }
  } catch (err) {
    console.error(`Failed to query providers: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Is the gateway running? Try: pnpm start');
    process.exit(1);
  }
}

async function promoteProvider(name: string, parsed: ParsedArgs): Promise<void> {
  const gateway = stringFlag(parsed, 'gateway') ?? stringFlag(parsed, 'g') ?? DEFAULT_GATEWAY;

  console.log(`Provider setup: ${name}`);
  console.log('─'.repeat(50));

  // 1. Check current state
  let provider: DiscoveredProvider | undefined;
  try {
    const response = await fetch(`${gateway}/onboarding`);
    const report = await response.json() as Record<string, unknown>;
    const providers = (report.providers ?? []) as DiscoveredProvider[];
    provider = providers.find(p => p.name === name);
  } catch {
    console.error('Failed to query gateway. Is it running?');
    process.exit(1);
  }

  if (!provider) {
    console.error(`Provider '${name}' not discovered. Run 'los provider list' to see available providers.`);
    process.exit(1);
  }

  const r = provider.readiness;
  const isReady = r?.ready ?? provider.ready ?? (provider.hasApiKey && provider.importable && provider.available);
  const state = r?.promotionState ?? provider.promotionState ?? (isReady ? 'advisory' : 'blocked');
  const credClass = r?.credentialClass ?? provider.credentialClass ?? 'unknown';

  console.log(`  Current state: ${state}`);
  console.log(`  Credential class: ${credClass}`);
  console.log(`  Source: ${provider.source ?? 'unknown'}`);

  if (isReady) {
    console.log(`  ${name} is already configured and ready.`);
    console.log('  This command does not promote providers into required gates.');
    console.log('  To verify it with a live compatibility run:');
    console.log(`    los compat --execute --target ${name} --probe read-context --workspace .`);
    return;
  }

  // 2. Show setup instructions
  const setupAction = r?.setupAction ?? provider.setupAction;
  if (setupAction) {
    console.log(`\n  Setup: ${setupAction}`);
  }

  // 3. Interactive: prompt user to enter key
  const keyEnv = providerKeyEnv(name);
  console.log(`\n  Enter your ${keyEnv} value (input is visible in this terminal):`);

  const key = await readVisibleLine(`  > `);
  if (!key || key.trim().length === 0) {
    console.log('  Cancelled. No key entered.');
    return;
  }

  console.log(`  Key received (${key.trim().length} chars).`);

  // 4. Verify by calling onboarding again and checking
  // The key is set via env var for the current process; a production
  // implementation would persist to ~/.los/accounts/<name>.json
  console.log(`\n  To persist this key, add to your shell profile or ~/.los/accounts/${name}.json:`);
  console.log(`    export ${keyEnv}="${'*'.repeat(Math.min(key.trim().length, 8))}..."`);

  // 5. Suggest next step
  console.log(`\n  After setting ${keyEnv}, restart the gateway and run:`);
  console.log(`    pnpm restart`);
  console.log(`    los compat --execute --target ${name} --probe read-context --workspace .`);
  console.log('\n  A successful compat run marks this provider as verified_advisory.');
}

function providerKeyEnv(name: string): string {
  const map: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    minimax: 'MINIMAX_API_KEY',
  };
  return map[name] ?? `${name.toUpperCase()}_API_KEY`;
}

async function readVisibleLine(prompt: string): Promise<string> {
  const readline = await import('node:readline');
  const { stdin, stdout } = await import('node:process');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  return new Promise<string>(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function stringFlag(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    if (parsed.values[name] !== undefined) return String(parsed.values[name]);
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.values[name] === true || parsed.values[name] === 'true';
}

function printProviderHelp(): void {
  console.log(`los provider

Manage provider configuration and setup guidance.

Usage:
  los provider list [--gateway URL] [--json]
  los provider promote <name> [--gateway URL]

Commands:
  list      Show all discovered providers with readiness and promotion state
  promote   Interactive setup guidance for a blocked provider (API key entry)

Examples:
  los provider list
  los provider promote anthropic
  los provider promote openai --gateway http://localhost:8080
`);
}
