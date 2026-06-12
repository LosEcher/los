# agent/provider — Provider Abstraction Spec

## Pre-Development Checklist

- [ ] Is this a new provider integration, model profile change, or transport configuration?
- [ ] Read ADR 0007 (Provider Loop + Model Profiles) and ADR 0017 (Advisory Provider Promotion)
- [ ] Will the change need a compatibility harness update?

## Coding Guidelines

### Model Profiles
- `model-profiles.ts` defines `ModelProfile` with capabilities, transport hints, and tool fidelity
- Profile changes require compatibility harness evidence (ADR 0017)
- `toolUseFidelity` is eval evidence, not a static property — measure, don't assert

### Provider Routing
- `providers/index.ts` (~482 lines) — keep each provider in its own module
- Provider discovery via `@los/infra/discovery` — no hardcoded API keys or URLs
- Fallback behavior: configured transport → effective transport → failure event (Phase D)

### Transport
- Transport is a runtime request preference, not a static config
- Provider-specific fallback when requested transport is unavailable
- Transport failures emit observable events for competitive analysis

### Compatibility Harness
- `compatibility-harness.ts` runs provider/model/tool-policy probes
- Every new provider or model profile requires harness coverage
- Harness results feed into eval backlog and provider promotion decisions

## Quality Check

```bash
pnpm --filter @los/agent test                              # Provider-related tests
pnpm run los:provider:check                                 # Compatibility harness
```
