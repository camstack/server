/**
 * A history SELECTION — which series a chart overlays — and its two
 * spellings: the History page URL (`?s=` repeated) and the account
 * preference row of saved panels (`admin.history-panels`, D894).
 *
 * A series is (subject, key, scope). The subject is a device (by numeric id)
 * or a node (by id); the scope `''` is the series' aggregate.
 */
import { z } from 'zod'
import { HISTORY_WINDOW_IDS, type HistoryWindowId } from './history-window'

export type HistorySubject =
  | { readonly kind: 'device'; readonly deviceId: number }
  | { readonly kind: 'node'; readonly nodeId: string }

export interface HistorySeriesRef {
  readonly subject: HistorySubject
  readonly key: string
  readonly scope: string
}

// The schemas are typed AS the interfaces (the library emits isolated
// declarations, so an exported `z.infer` alias is not available here); a
// drift between the two fails to compile.
const HistorySubjectSchema: z.ZodType<HistorySubject> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), deviceId: z.number().int() }),
  z.object({ kind: z.literal('node'), nodeId: z.string().min(1) }),
])

const HistorySeriesRefSchema: z.ZodType<HistorySeriesRef> = z.object({
  subject: HistorySubjectSchema,
  key: z.string().min(1),
  scope: z.string(),
})

/** The most series one overlay may carry — one `queryMany` batch. */
export const HISTORY_SELECTION_MAX = 24

/** Stable identity of a series ref (React key, dedup, colour slot). */
export function seriesRefId(ref: HistorySeriesRef): string {
  const subject =
    ref.subject.kind === 'device' ? `d:${String(ref.subject.deviceId)}` : `n:${ref.subject.nodeId}`
  return `${subject}|${ref.key}|${ref.scope}`
}

/** One `?s=` value: `d,<deviceId>,<key>,<scope>` or `n,<nodeId>,<key>,<scope>`, each part URI-encoded. */
export function encodeSeriesRef(ref: HistorySeriesRef): string {
  const head =
    ref.subject.kind === 'device' ? ['d', String(ref.subject.deviceId)] : ['n', ref.subject.nodeId]
  return [...head, ref.key, ref.scope].map((p) => encodeURIComponent(p)).join(',')
}

export function decodeSeriesRef(raw: string): HistorySeriesRef | null {
  const parts = raw.split(',')
  if (parts.length !== 4) return null
  let decoded: string[]
  try {
    decoded = parts.map((p) => decodeURIComponent(p))
  } catch {
    return null
  }
  const [kind, id, key, scope] = decoded
  if (key === undefined || key === '' || scope === undefined || id === undefined) return null
  if (kind === 'd') {
    const deviceId = Number(id)
    if (!Number.isInteger(deviceId)) return null
    return { subject: { kind: 'device', deviceId }, key, scope }
  }
  if (kind === 'n' && id !== '') return { subject: { kind: 'node', nodeId: id }, key, scope }
  return null
}

/** Unique refs, in order, capped at {@link HISTORY_SELECTION_MAX}. */
export function normalizeSelection(refs: readonly HistorySeriesRef[]): readonly HistorySeriesRef[] {
  const seen = new Set<string>()
  const out: HistorySeriesRef[] = []
  for (const r of refs) {
    const id = seriesRefId(r)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(r)
    if (out.length >= HISTORY_SELECTION_MAX) break
  }
  return out
}

/** The History page path showing `refs` over `window`. */
export function historyPageHref(
  refs: readonly HistorySeriesRef[],
  window?: HistoryWindowId,
): string {
  const params = new URLSearchParams()
  for (const r of normalizeSelection(refs)) params.append('s', encodeSeriesRef(r))
  if (window !== undefined && window !== 'custom') params.set('window', window)
  return `${HISTORY_PAGE_PATH}?${params.toString()}`
}

/** The cross-device History page's route. */
export const HISTORY_PAGE_PATH = '/system/history'

// ── Saved panels (account preferences) ─────────────────────────────────

/** The account preference namespace that holds saved panels and hidden charts. */
export const HISTORY_PANELS_NAMESPACE = 'admin.history-panels'

const WindowIdSchema = z.enum(HISTORY_WINDOW_IDS)

export interface HistoryPanel {
  readonly id: string
  readonly name: string
  readonly window: HistoryWindowId
  readonly selection: readonly HistorySeriesRef[]
}

export interface HistoryPanelsValue {
  readonly version: 1
  readonly panels: readonly HistoryPanel[]
  /** Chart ids an operator hid on a device's History tab, per device id. */
  readonly hidden: Readonly<Record<string, readonly string[]>>
}

const HistoryPanelSchema: z.ZodType<HistoryPanel> = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  window: WindowIdSchema,
  selection: z.array(HistorySeriesRefSchema).max(HISTORY_SELECTION_MAX),
})

const HistoryPanelsValueSchema: z.ZodType<HistoryPanelsValue> = z.object({
  version: z.literal(1),
  panels: z.array(HistoryPanelSchema).max(50),
  hidden: z.record(z.string(), z.array(z.string()).max(200)),
})

export const EMPTY_HISTORY_PANELS: HistoryPanelsValue = { version: 1, panels: [], hidden: {} }

/**
 * Read a stored row's value. A row this client cannot read (another
 * version, a hand edit) is answered as empty rather than throwing — and the
 * caller must not write over it blindly: `parsed: false` says so.
 */
export function readHistoryPanels(value: unknown): {
  readonly value: HistoryPanelsValue
  readonly parsed: boolean
} {
  if (value === undefined || value === null) return { value: EMPTY_HISTORY_PANELS, parsed: true }
  const r = HistoryPanelsValueSchema.safeParse(value)
  return r.success
    ? { value: r.data, parsed: true }
    : { value: EMPTY_HISTORY_PANELS, parsed: false }
}

/** A copy of `value` with chart `chartId` hidden (or shown again) on device `deviceId`. */
export function withHiddenChart(
  value: HistoryPanelsValue,
  deviceId: number,
  chartId: string,
  hidden: boolean,
): HistoryPanelsValue {
  const key = String(deviceId)
  const current = value.hidden[key] ?? []
  const next = hidden
    ? current.includes(chartId)
      ? current
      : [...current, chartId]
    : current.filter((c) => c !== chartId)
  const rest = Object.fromEntries(Object.entries(value.hidden).filter(([k]) => k !== key))
  return { ...value, hidden: next.length > 0 ? { ...rest, [key]: next } : rest }
}

/** A copy of `value` with `panel` saved (replacing one with the same id). */
export function withPanel(value: HistoryPanelsValue, panel: HistoryPanel): HistoryPanelsValue {
  const others = value.panels.filter((p) => p.id !== panel.id)
  return { ...value, panels: [...others, panel] }
}

export function withoutPanel(value: HistoryPanelsValue, panelId: string): HistoryPanelsValue {
  return { ...value, panels: value.panels.filter((p) => p.id !== panelId) }
}
