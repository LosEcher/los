export function printHelp(defaultGateway: string): void {
  console.log(`los client

Usage:
  los setup [--gateway URL] [--json]
  los chat [options] <prompt>
  los run [options] <prompt>
  los run <inspect|state|recover|verify|approve|revise-plan|replay> <run-id> [options]
  los compat [options] [provider[:model]...]
  los provider <list|promote> [options]
  los evals <list|summary|compare|record> [options]
  los governance <todo-reconcile|runtime-cleanup|status-constraints> [options]
  los external-summaries <list|import> [options]
  los artifacts <list|put|get|delete> [options]
  los nodes <list|commands|command> [options]
  los workspaces <plan|apply|list|inspect|backup|release> [options]
  los sessions [--gateway URL] [--json]
  los tasks [--gateway URL] [--json]
  los health [--gateway URL] [--json]
  los mcp serve [--gateway URL]

Global:
  --gateway, -g URL       Gateway URL, default ${defaultGateway}
  --auth-token, -t TOKEN  Gateway token, default LOS_AUTH_TOKEN
  --operator-token TOKEN  Operator token for gated writes, default LOS_OPERATOR_TOKEN
  --json                  Emit JSON lines or raw JSON

Setup:
  Inspect runtime readiness without printing credentials. From a source
  checkout, run "pnpm run setup" to check prerequisites and start los first.

Chat:
  --provider, -p NAME     Provider endpoint, e.g. deepseek or openai
  --model NAME            Model override for the selected provider
  --fallback-target LIST  Ordered provider:model targets, comma-separated
  --fallback-on LIST      transport, rate_limit, provider_unavailable
  --fallback-max-switches N  Maximum provider switches, 1-4
  --fallback-without-compat-evidence  Disable the default evidence gate
  --workspace, -w PATH    Workspace root for tools
  --tool-mode MODE        read-only, project-write, or all
  --session, -s ID        Continue writing to a session
  --resume ID             Alias for --session
  --max-loops N           Agent loop limit
  --timeout-ms N          Task timeout
  --trace-id ID           Trace id
  --dedupe-key KEY        Active task dedupe key

Run operations:
  inspect RUN_ID          Print runtime evidence graph counts and warnings
  state RUN_ID            Print recovery-grade run phase, next action, and blockers
  approve RUN_ID          Approve the plan_approved phase transition for a run
  recover RUN_ID          Print tool recovery decision; add --apply to transition cancel/operator-attention
  verify RUN_ID           Run required verification records
  --stale-ms N            Recovery stale threshold
  --cwd PATH              Verification working directory
  --output-limit N        Verification output summary limit
  --skip-failed           Do not rerun failed verification records

Compat:
  --target NAME[:MODEL]   Target provider/model, repeat with comma or positional args
  --probe ID              Probe id, default all built-in probes
  --execute               Execute probes through the gateway; default is dry-run
  --trace-prefix ID       Prefix for per-run trace ids
  --dedupe-prefix KEY     Prefix for per-run dedupe keys
  Default target is the required DeepSeek compatibility gate; pass --target for advisory providers.

Artifacts:
  list | put | get | delete
  Run "los artifacts --help" for artifact transfer options.

External summaries:
  list | import --file summary.json
  Import redacted external tool summaries without making them runtime replay evidence.

Evals:
  list | summary | compare | record --run RUN_ID --success true|false
  Record, list, summarize, or compare run quality eval metrics.

Governance:
  todo-reconcile         Dry-run compare code todo seeds with the DB todo ledger
  runtime-cleanup        Dry-run report illegal statuses and stale fixture runs
  status-constraints     Report status CHECK constraints and invalid row counts

Nodes:
  list | commands | command
  Run "los nodes --help" for node registry and command options.

Workspaces:
  plan | apply | list | inspect | backup | release
  Managed jj workspace writes require LOS_OPERATOR_TOKEN. Release requires an
  exact --confirm value and creates an artifact-backed diff first.

MCP:
  serve                  Expose LOS run/state/replay/operator tools over stdio
  LOS_MCP_TENANT_ID      Request tenant, default local
  LOS_MCP_USER_ID        Request user, default mcp-client
  Project id is required on every MCP tool call. Runs default to read-only;
  project-write and operator control require LOS_OPERATOR_TOKEN.
`);
}

export function printChatHelp(): void {
  console.log(`los chat

Examples:
  los chat --provider deepseek --workspace . "inspect this repo"
  los chat --provider deepseek --model deepseek-v4-flash "inspect this repo"
  los chat --provider openai --tool-mode all "run tests and summarize failures"
  los chat --fallback-target deepseek:deepseek-v4-flash,xai:grok-4.3 "inspect this repo"
  los chat --resume session-123 "continue with the next fix"
  echo "review current structure" | los chat --provider deepseek
`);
}
