# los Web Design Tokens

Source of truth: `packages/web/src/styles/tokens.css`  
Loaded first from `main.tsx` before `styles.css`.

## Principles

1. **Token first** — colors, spacing, radius, type use CSS variables; no raw hex in new components.
2. **Dark default** — operator console aesthetic; light is opt-in via `data-theme`.
3. **Daily surfaces quiet** — Inbox / Work / Schedules / Chat hide status noise; Ops can be denser.
4. **Chat is a timeline** — messages append downward; tool results live *inside* turns, not in a top strip.
5. **Decision > evidence** — primary CTA once; ids and raw JSON behind Debug.

## Token groups

| Group | Examples | Use |
|---|---|---|
| Surfaces | `--bg`, `--surface`, `--surface-2/3` | page / panel / inset |
| Borders | `--line`, `--line-strong` | dividers, control chrome |
| Text | `--text`, `--muted`, `--faint` | body / secondary / labels |
| Semantic | `--accent`, `--ok`, `--warn`, `--danger`, `--info` | brand & state |
| Semantic bg | `--ok-bg`, `--warn-bg`, `--err-bg`, `--info-bg` | chips, banners |
| Space | `--space-1` … `--space-12` (4px grid) | padding, gap |
| Radius | `--radius-sm/md/lg/pill` | controls, cards |
| Type | `--text-xs` … `--text-2xl`, `--font-sans/mono` | hierarchy |
| Layout | `--sidebar-width`, `--page-pad` | shell |
| Motion | `--duration-*`, `--ease-out` | transitions |
| Z | `--z-sticky` … `--z-toast` | stacking |

## Themes

| Mode | How |
|---|---|
| `dark` | default `data-theme="dark"` |
| `light` | Settings / `useTheme().setMode('light')` |
| `system` | resolved to dark/light by `ThemeProvider` |

## Component mapping (target)

| Pattern | Classes / notes |
|---|---|
| App shell | `.app-shell`, `.sidebar`, `.main` — sticky nav, content flex |
| Panel | `.panel`, `.panel-head` — card chrome for page sections |
| Buttons | `.btn` primary, `.ghost-btn` secondary, `.tiny-btn` compact, `.btn-danger` |
| Chat timeline | `.chat-timeline` flex column; scroll middle; sticky footer actions |
| Tool row | `.tool-card` inside bubble; no top-of-page approval dump |
| Inbox | `.daily-page` + `.attention-row` + `.inbox-decision` + single `.inbox-primary-cta` |
| Work | `.work-split` list/detail; `.outcome-card`; `.work-create` two-tier form |
| Nav active | `.nav-item[data-active]` uses `--accent-muted` + left accent bar |

## Page polish order

1. Chat timeline (done)
2. Inbox + Work density (done)
3. Schedules split (done)
4. Ops tables / logs density (done)
5. Settings + topbar theme switcher (done — dark/light/system via `useTheme`)

## Anti-patterns

- Hardcoded `#hex` or `rgb()` for theme colors in TSX/CSS of new work
- `column-reverse` chat lists
- Approval / tool history stacked above the transcript
- Multiple primary CTAs on one decision card
