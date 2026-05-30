# Legacy Reference Notes

This folder is for short, topic-based notes extracted from historical codebases.
It is not a copy area and not a second source of truth.

## Purpose

Use this area when a legacy repo contains a behavior, shape, or boundary that
`los` may want to adopt, but the idea is not yet ready for an ADR or code
change.

Keep the note small and concrete:

1. What problem the reference helps solve in `los`.
2. Which legacy file or module was inspected.
3. What behavior, contract, or data shape was observed.
4. What should be borrowed into `los`.
5. What should not be borrowed.
6. Where the result should land in `los` if it is accepted.
7. How the result will be verified.

## File Shape

Use one file per topic, named after the borrowed concern:

- `provider-loop.md`
- `tool-capability.md`
- `executor-heartbeat.md`
- `memory-ledger.md`

Keep each note readable in one pass. Do not paste full legacy modules here.
Short excerpts are acceptable only when they are needed to preserve exact
shape or naming.

## Recommended Template

```md
# Topic

## Problem

## Legacy sources

- `projects/<legacy>/...`

## Observed behavior

## Borrow into los

## Do not borrow

## los target

## Verification
```

## Promotion Rule

Move the note into one of these forms when the reference becomes a decision:

1. ADR if it changes architecture, boundaries, or public contracts.
2. Test if the important part is behavior preservation.
3. TODO or backlog item if the work is known but not yet scheduled.
4. Code only after the reference has been narrowed to a concrete `los`
   implementation target.

## Suggested Use

Start with the higher-frequency reference areas already named in workspace
docs:

- provider loop and model profiles
- tool capability and approval policy
- executor and sandbox boundaries
- memory ledger and event projection
- structure-map or code-fact extraction

When a note becomes stale, update or delete it. Do not keep parallel copies of
the same decision in this folder and in `docs/adr/`.
