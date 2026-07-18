# Grok External Account And Quota Probe

Date: 2026-07-18

## Scope

This record verifies whether a current Grok Build sign-in can inform LOS
provider-account and quota design without copying or taking ownership of the
Grok credential.

It does not authorize a new credential backend, provider route, quota
dependency, database migration, provider promotion, dead-letter replay, or
automatic account selection.

## Current Surfaces

The probe kept these truth surfaces separate:

| Surface | Evidence | Result |
| --- | --- | --- |
| Installed clients | `grok --version`; Orca bundle metadata | Grok `0.2.101 (5bc4b5dfadcf)` and Orca `1.4.144` [E] |
| Grok credential file | schema-only inspection of `~/.grok/auth.json`; POSIX mode check | Preferred xAI OIDC entry present; file mode `0600` [E] |
| LOS credential file | in-memory comparison with `~/.los/auth.json` | LOS and Grok tokens are distinct sessions [E] |
| Account identity | equality-only comparison; identifiers were not printed | principal, team, and OIDC client match [E] |
| Quota | whitelisted fields from a live billing response | HTTP 200; weekly credit usage was 41 percent [E] |
| Provider compatibility | no compatibility task was executed | Unverified by this probe [U] |

No access token, refresh token, email, user id, team id, principal id, raw auth
record, or raw billing response was printed or persisted.

## Orca Behavior

The installed Orca bundle at
`/Applications/Orca.app/Contents/Resources/app.asar` contains the following
Grok account and quota behavior:

1. `readGrokAuthSession()` reads `~/.grok/auth.json` and prefers entries whose
   key is `https://auth.x.ai` or begins with `https://auth.x.ai::`. [E]
2. `sessionFromAuthEntry()` treats the entry's `key` field as the short-lived
   access token and retains non-secret account provenance such as user, team,
   expiry, and OIDC client metadata in memory. [E]
3. `isGrokAccessTokenFresh()` applies a five-minute expiry skew. [E]
4. Orca does not refresh the Grok credential. An expired session returns a
   delegated-refresh diagnostic instructing the operator to run Grok. [E]
5. `fetchGrokRateLimits()` calls
   `https://cli-chat-proxy.grok.com/v1/billing?format=credits` with bearer auth,
   `X-XAI-Token-Auth: xai-grok-cli`, and `x-userid` when available. [E]
6. Orca normalizes a weekly credit percentage and reset time. If weekly credit
   data is absent, it tries the default billing response for monthly usage. [E]

This is a read-only observer pattern. Orca neither copies the Grok session into
its own credential store nor becomes the refresh owner.

## Grok Build Behavior

The installed Grok binary and the source review already recorded by ADR 0030
agree on these boundaries:

1. Grok owns OIDC login, silent refresh, file locking, rotated-token writes,
   and `~/.grok/auth.json`. [E]
2. Grok session auth targets `https://cli-chat-proxy.grok.com/v1`, not the LOS
   public xAI API route `https://api.x.ai/v1`. [E]
3. CLI proxy requests identify the credential class with
   `X-XAI-Token-Auth: xai-grok-cli` and include Grok client metadata. [E]
4. `grok agent stdio` is the supported process boundary for integrating the
   complete Grok agent runtime. [E]

Relevant reviewed references remain the Grok Build source commit
`c1b5909ec707c069f1d21a93917af044e71da0d7` named by ADR 0030 and the installed
binary's embedded source paths such as
`crates/codegen/xai-grok-shell/src/auth/manager.rs` and
`crates/codegen/xai-grok-shell/src/extensions/billing.rs`.

## Live Probe

The live request used the preferred xAI entry from `~/.grok/auth.json` in
memory, an explicit local HTTP proxy, and a 15-second timeout:

```text
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
Authorization: Bearer <redacted>
X-XAI-Token-Auth: xai-grok-cli
x-userid: <redacted>
Accept: application/json
```

Only a fixed output allowlist was emitted:

```json
{
  "httpStatus": 200,
  "authFreshByFile": true,
  "payloadHasConfig": true,
  "creditUsagePercent": 41,
  "periodEnd": "2026-07-19T03:43:05.787070+00:00",
  "subscriptionTierPresent": false
}
```

The period end corresponds to 2026-07-19 11:43 in Asia/Shanghai. This proves
that the current Grok session can produce advisory quota evidence. It does not
establish a supported public xAI quota contract or authorize LOS to depend on
the internal billing endpoint. [E]

The LOS/Grok session comparison returned:

```json
{
  "bothPresent": true,
  "sameAccessToken": false,
  "samePrincipal": true,
  "sameTeam": true,
  "sameOidcClient": true,
  "losAuthMode": "oauth_pkce",
  "grokAuthMode": "oidc"
}
```

This supports the inference that both sessions belong to the same account and
entitlement context while retaining separate credential ownership. [I]

## Judgment

LOS should reuse the external-reference pattern, not the token itself as an
implicitly interchangeable credential.

1. Do not add `~/.grok/auth.json` to `scanXaiOAuth()` as another importable xAI
   OAuth source. The current `DiscoveredProvider` shape cannot represent stable
   account identity, node-local secret scope, credential generation, or route
   provenance. Doing so would also collapse Grok CLI proxy readiness into
   public xAI API readiness.
2. After ADR 0030 Phase 1 exists, a Grok sign-in can be represented as a
   node-local external `secret_ref`. PostgreSQL stores only the opaque reference
   and non-secret account metadata. It must never store the auth file contents.
3. LOS may read a fresh external session for an explicitly selected adapter,
   but Grok remains the only login and refresh owner. Expiry produces a bounded
   delegated-refresh diagnostic instead of an LOS refresh attempt.
4. Quota collection belongs in ADR 0030 Phase 2 as an account-scoped advisory
   snapshot. The collector must normalize only approved fields, preserve source
   and freshness, and discard the raw response.
5. The current internal billing endpoint is suitable for a fixture and an
   explicitly classified `cli_adapter` experiment. It is not yet suitable as a
   required or unattended LOS dependency.
6. If LOS needs the complete Grok agent behavior, evaluate `grok agent stdio`
   under ADR 0018. Do not approximate that runtime by routing the Grok session
   token through the existing OpenAI-compatible xAI provider.

## Placement

The owning design remains
`docs/adr/0030-provider-account-credential-and-quota-boundary.md`:

1. Phase 1 owns `provider_accounts`, opaque external references, node scope,
   state, and credential generation.
2. Phase 2 owns normalized `provider_quota_snapshots`, freshness, source, and
   advisory derived state.
3. Phase 3 carries the effective account id into task, provider-call,
   compatibility, and scheduler evidence.
4. Phase 4 adds explicit operator account selection without automatic failover.

No new pre-Phase-1 credential scanner or token-copy path is justified by this
probe.

## Remaining Gates

1. Phase 1 requires explicit package-level operator approval before an infra
   migration or a new file under `packages/infra/`.
2. Phase 2 requires fixtures for weekly, monthly, missing, malformed, expired,
   unauthorized, stale, and multi-bucket responses.
3. The internal billing endpoint needs an independently approved stability and
   ownership decision before it becomes a maintained adapter.
4. Follow-up evidence in
   `2026-07-18-xai-dead-letter-model-routing-probe.md` passed the exact composer
   target through the separate LOS xAI provider path. The Grok CLI model list
   remains different, and the 16 `unrecoverable_error` rows remain untouched
   until replacement results are verified.
5. A future Grok ACP spike must separately prove read-context, cancellation,
   tool denial, event projection, and credential provenance.
