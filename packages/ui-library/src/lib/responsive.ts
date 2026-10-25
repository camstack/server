/**
 * Responsive design tokens — three-tier system.
 *
 * The admin-ui targets three width tiers; every component should pick
 * the right token from this file instead of hand-coding breakpoints.
 * Adopting the tokens uniformly is what makes the app feel consistent
 * across operator devices (mobile / tablet / desktop) and what unlocks
 * targeted tuning (e.g. shrink every label by 1px in one place).
 *
 * Tier definitions (Tailwind breakpoints):
 *
 *   • **L1 — Compact** (`< 640px`, default = mobile portrait)
 *     Single column, tight padding, smallest text, icon-only buttons
 *     where labels can be inferred. The operator can still see every
 *     stat / action — no horizontal scroll, no clipped text. The user
 *     directive: "molta informazione in poco spazio quando la width è
 *     bassa." [a lot of information in little space when the width is low.]
 *
 *   • **L2 — Standard** (`sm` — `640–1023px`, tablet + small laptop)
 *     2-column grids, side panels become visible, button labels return.
 *     Targets ~768px–1024px viewports — the most common operator sizes.
 *
 *   • **L3 — Spacious** (`lg+` — `≥ 1024px`, desktop)
 *     4-column grids, generous padding, full-width header text,
 *     side-by-side composite layouts. The operator has elbow room.
 *
 * Conventions:
 *   - **Always start from L1** — the bare class is always the compact
 *     variant, then `sm:` adds room at 640px, `lg:` at 1024px. No
 *     desktop-first breakpoints; no max-width queries.
 *   - **Token strings are static** — kept as `as const` so callers can
 *     compose them via `cn()` / template literals without running a
 *     class generator at runtime.
 *   - **Pair the token with a comment** — the comment in the file
 *     names every breakpoint it crosses, so a reader can predict the
 *     layout without going to Tailwind docs.
 */

// ---------------------------------------------------------------------------
// Spacing — section / card / row padding + grid gap
// ---------------------------------------------------------------------------

/** Container padding for a card-style section (header + body). */
export const SECTION_CARD = 'rounded-lg border border-border bg-surface overflow-hidden' as const

/** Header strip inside a card (between border-b lines). */
export const SECTION_HEADER = 'border-b border-border px-3 sm:px-4 py-1.5 sm:py-2' as const

/** Body padding for a card-style section. */
export const SECTION_BODY = 'p-2 sm:p-3 lg:p-4' as const

/** Gap between cards in a vertical stack. */
export const STACK_GAP = 'space-y-3 sm:space-y-4' as const

/** Gap between cards in a grid (4 cells / row at lg). */
export const GRID_GAP = 'gap-2 sm:gap-3' as const

/** Row padding inside a divided list (e.g. InfoRow). */
export const LIST_ROW = 'px-3 sm:px-4 py-1.5 sm:py-2' as const

// ---------------------------------------------------------------------------
// Grids — opinionated column counts per tier
// ---------------------------------------------------------------------------

/** 1-up at L1, 2-up at L2, 4-up at L3 — quick-stat row. */
export const GRID_QUICK_STATS = 'grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4' as const

/** Auto-fill media tiles (events, frames, crops) — ~4 across at lg. */
export const MEDIA_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]' as const

/** 1-up at L1, 2-up at L2+ — paired panels (motion + detection rules). */
export const GRID_PAIRED = 'grid grid-cols-1 lg:grid-cols-2' as const

/** Side-by-side layout that stacks below md (canvas + side panel). */
export const SPLIT_PANEL_OUTER = 'flex flex-col-reverse md:flex-row' as const

/** Sidebar narrow lane in a SPLIT_PANEL_OUTER layout. */
export const SPLIT_PANEL_SIDE =
  'w-full md:w-44 lg:w-52 md:flex-shrink-0 border-b md:border-b-0 md:border-l border-border' as const

// ---------------------------------------------------------------------------
// Settings label/value row — the L1 stacking contract
// ---------------------------------------------------------------------------

/**
 * The tier boundary at which a settings label/value row stops stacking.
 *
 * Below it (L1 — compact) the row is ONE column: label on its own line, value
 * on the next at full width. Above it the row is label-left / value-right as
 * before. The two-column form needs `SETTING_ROW_LABEL`'s lane plus a readable
 * value beside it; a phone has neither, and the failure mode is not "cramped"
 * but "the value is the part that gets cut" — the one thing the operator
 * opened the page to read.
 */
export const SETTING_ROW_STACK_BREAKPOINT = 'sm' as const

/** Outer row: single column at L1, label/value columns from `sm` up. */
export const SETTING_ROW =
  'flex min-w-0 flex-col gap-0.5 py-1.5 sm:flex-row sm:items-center' as const

/** Label lane. Full width (and free to wrap) at L1; a fixed lane from `sm` up. */
export const SETTING_ROW_LABEL =
  'min-w-0 text-[11px] leading-tight text-foreground-subtle sm:w-32 sm:shrink-0 sm:pr-2' as const

/**
 * Value lane — the value text plus its trailing affordances (copy / reveal).
 * `w-full` at L1 so the value owns the whole row once the label is above it;
 * `sm:flex-1` makes it share the row again from `sm` up.
 */
export const SETTING_ROW_VALUE = 'flex w-full min-w-0 items-center gap-1 sm:flex-1' as const

/**
 * The value text itself. `break-all` lets an opaque token (a key, a URL) wrap
 * at L1 instead of being cut mid-word; `sm:truncate` restores the single-line
 * desktop form, where the row is wide enough for truncation to be a choice
 * rather than data loss.
 */
export const SETTING_ROW_VALUE_TEXT =
  'min-w-0 break-all text-xs text-foreground sm:truncate' as const

// ---------------------------------------------------------------------------
// Typography — labels, values, sub-text
// ---------------------------------------------------------------------------

/** Section header label (uppercase tracking-wider). */
export const TEXT_SECTION_LABEL =
  'text-[10px] sm:text-[11px] font-semibold text-foreground uppercase tracking-wider' as const

/** Field label inside a row. */
export const TEXT_FIELD_LABEL = 'text-[11px] sm:text-xs text-foreground' as const

/** Sub-label / hint text. */
export const TEXT_HINT = 'text-[10px] text-foreground-subtle' as const

/** Primary value (a metric, badge, …). */
export const TEXT_VALUE = 'text-[11px] sm:text-xs font-medium text-foreground' as const

/** Big metric value (StatCard). */
export const TEXT_METRIC =
  'text-base sm:text-lg font-semibold leading-tight text-foreground' as const

// ---------------------------------------------------------------------------
// Buttons — compact at L1, comfortable at L2+
// ---------------------------------------------------------------------------

/** Default compact button. */
export const BTN_COMPACT =
  'inline-flex items-center justify-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 sm:px-2 sm:py-1 text-[10px] sm:text-[11px] font-medium text-foreground hover:bg-surface-hover transition-colors disabled:opacity-40' as const

/** Primary compact button. */
export const BTN_COMPACT_PRIMARY =
  'inline-flex items-center justify-center gap-1 rounded border border-primary/40 bg-primary/15 px-1.5 py-0.5 sm:px-2 sm:py-1 text-[10px] sm:text-[11px] font-medium text-primary hover:bg-primary/25 transition-colors disabled:opacity-40' as const

/** Danger compact button. */
export const BTN_COMPACT_DANGER =
  'inline-flex items-center justify-center gap-1 rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 sm:px-2 sm:py-1 text-[10px] sm:text-[11px] font-medium text-danger hover:bg-danger/20 transition-colors disabled:opacity-40' as const

/** Warning compact button (e.g. cancel-drawing). */
export const BTN_COMPACT_WARNING =
  'inline-flex items-center justify-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 sm:px-2 sm:py-1 text-[10px] sm:text-[11px] font-medium text-warning hover:bg-warning/20 transition-colors disabled:opacity-40' as const

// ---------------------------------------------------------------------------
// Inputs — height matches the compact button so they line up in a row
// ---------------------------------------------------------------------------

/** Compact text/select/number input. */
export const INPUT_COMPACT =
  'w-full rounded border border-border bg-background px-1.5 py-0.5 sm:px-2 sm:py-1 text-[11px] sm:text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none' as const

/** Chip-style toggle (zone / class selectors in ZoneRulesEditor). */
export const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors' as const

export const CHIP_ACTIVE = 'border-primary/50 bg-primary/15 text-primary' as const

export const CHIP_INACTIVE =
  'border-border bg-surface text-foreground-subtle hover:bg-surface-hover' as const
