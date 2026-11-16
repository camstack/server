/**
 * Which optional columns a `LogStream` table offers and shows.
 *
 * Two optional columns exist beyond time / level / message: the friendly name
 * of the integration that emitted the line, and the name of the device the
 * line is about. The CODE decides which are available and which start visible
 * (`LogStreamProps.columns`); the viewer's own toggles are a per-viewer
 * convenience on top, kept in `localStorage`.
 *
 * Both columns are OFF unless a page opts in through `columns`. A stream
 * locked to an addon never offers the integration column (every row would say
 * the same), and one locked to a device never offers the device column, even
 * when the page lists them.
 */
export const LOG_COLUMN_IDS = ['integration', 'device'] as const
export type LogColumnId = (typeof LOG_COLUMN_IDS)[number]

export interface LogColumnConfig {
  /** Columns the toolbar may offer. Absent: none — a page opts in. */
  readonly available?: readonly LogColumnId[]
  /** Columns shown until the viewer chooses otherwise. Absent: none. */
  readonly defaultVisible?: readonly LogColumnId[]
}

export interface LogColumnScope {
  readonly addonId?: string | undefined
  readonly deviceId?: number | undefined
}

export function isLogColumnId(value: unknown): value is LogColumnId {
  return LOG_COLUMN_IDS.some((id) => id === value)
}

export function availableLogColumns(
  scope: LogColumnScope,
  config: LogColumnConfig | undefined,
): readonly LogColumnId[] {
  return (config?.available ?? []).filter((id) => {
    if (id === 'integration') return scope.addonId === undefined
    return scope.deviceId === undefined
  })
}

/** What the viewer's own choices are stored as: a column id → shown or not. */
export type StoredLogColumns = Readonly<Partial<Record<LogColumnId, boolean>>>

export function parseStoredLogColumns(raw: string | null): StoredLogColumns {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Partial<Record<LogColumnId, boolean>> = {}
    for (const id of LOG_COLUMN_IDS) {
      const value: unknown = Reflect.get(parsed, id)
      if (typeof value === 'boolean') out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

/** The visible columns: the viewer's choice wins, else the code's default; never an unavailable one. */
export function visibleLogColumns(input: {
  readonly available: readonly LogColumnId[]
  readonly config: LogColumnConfig | undefined
  readonly stored: StoredLogColumns
}): readonly LogColumnId[] {
  const defaults = input.config?.defaultVisible ?? []
  return input.available.filter((id) => input.stored[id] ?? defaults.includes(id))
}
