# Skills Runtime AP11 Notes (PR1)

Date: 2026-08-08  
Scope: configure-surface P0-1 skill runtime core  
Versions: `CONTEXT_STRATEGY_VERSION` 1.1.0 → **1.2.0** (user-turn skill attachment budgeting)

## Prompt-cache impact assessment

| Segment | Placement | Stability |
| --- | --- | --- |
| Identity + base system + memory augment | system prompt | stable-ish per session/project |
| **Active Skills** | **user-turn attachment** prepended to user prompt | high variance (manual/auto per request) |

Skills intentionally **do not** mutate the system prompt prefix. This preserves provider prefix-cache on identity/base/memory while still closing the “skills never run” product lie.

## Flags (ConfigSchema)

| Path | Env | Default |
| --- | --- | --- |
| `agent.skills.runtimeEnabled` | `LOS_SKILLS_RUNTIME` | true |
| `agent.skills.autoInject` | `LOS_SKILLS_AUTO` | **false** |
| `agent.skills.maxAutoSkills` | `LOS_SKILLS_MAX_AUTO` | 3 |
| `agent.skills.maxSkillTokens` | `LOS_SKILLS_MAX_TOKENS` | 2500 |

Rollback: set `LOS_SKILLS_RUNTIME=0` to disable attachment immediately.

## Wiring

- Shared helper: `@los/agent/skill-runtime` → `selectSkillsForRun`
- Applied once in `runScheduledAgentTask` (covers gateway chat + scheduler/work)
- Manual invoke: `/skill name` in prompt and/or `manualSkillIds` on `/chat` body (via metadata)
- Usage: `incrementSkillUsage` per selected skill
- Audit event: `skill.selected` (visibility: audit)

## Focused harness

```bash
pnpm --filter @los/agent exec node --import tsx --import ./src/test-setup.ts --test --test-concurrency 1 \
  src/skill-runtime.test.ts src/skill-frontmatter.test.ts src/session-events-visibility.test.ts
```

## Not in this PR

- Chat skill picker UI (PR2)
- Operator rules inject/gate (PR3)
- Auto inject default ON (requires more cache evidence)
