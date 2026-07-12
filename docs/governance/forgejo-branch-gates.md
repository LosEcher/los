# Forgejo Branch And Merge Gates

Forgejo `los/los` is the primary repository. The local `origin` remote must
point to Forgejo; an optional GitHub backup uses the `github` remote name.

## Repository CI

`.forgejo/workflows/ci.yml` runs on pushes to `main`, pull requests targeting
`main`, and manual dispatch. It provides:

1. `gate-fast`: typecheck, security, structure, coupling, state-machine,
   contracts, delete-safety, and wiring checks;
2. `gate-test`: the real root `pnpm test` path, which uses Turbo concurrency to
   run every package test script once against PostgreSQL 16;
3. `gate-drift`: migration-versus-ensure-store schema drift verification.

`.forgejo/workflows/audit.yml` runs the dependency audit daily and manually.

Runner requirements are Linux, Git, Bash, Node 22+, Corepack, pnpm 9, service
containers, and outbound access to the package registry. The PostgreSQL service
user must be able to create the temporary drift databases.

## Required Server Policy

Configure Forgejo `main` protection to:

1. reject deletion and non-fast-forward updates;
2. require a pull request for normal changes;
3. require successful `gate-fast`, `gate-test`, and `gate-drift` checks;
4. reject merges while required checks are pending or stale;
5. restrict bypass permission to an explicitly audited emergency operator.

The exact server-side rule must be verified in the Forgejo UI or authenticated
API. Repository YAML cannot create branch protection by itself.

## Merge Evidence

Before merging:

```bash
bash tools/branch-closeout.sh
```

The closeout script treats `origin` as primary and queries Forgejo Actions when
the remote uses HTTP(S). Private repositories require `FORGEJO_TOKEN` for API
evidence. A local gate does not substitute for a green clean-checkout Forgejo
run on the exact PR head.

After merging:

```bash
jj git fetch --remote origin
jj log -r 'main@origin' -n 1
bash tools/branch-prune-origin.sh
```

Use `--apply` for branch deletion only with explicit operator approval.

## GitHub Independence

No build or deterministic test requires GitHub. GitHub Actions, rulesets, `gh`,
and GitHub PR state are optional mirror services and must not be included in the
Forgejo completion gate.
