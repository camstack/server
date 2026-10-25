/**
 * Pure logic behind the Delivery control of a device-events / system rule
 * (D647) — see `NotificationSystemEventDelivery.tsx`.
 */
import type {
  NcSchedule,
  NcStateSummaryPreview,
  NcStateSummarySplit,
  NcSummarySendTime,
  NcSystemEventDelivery,
} from '@camstack/types'
import i18n from '../../i18n/index'

/** A new send time: every day at 08:00. */
export const DEFAULT_SEND_TIME: NcSummarySendTime = { days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }

export interface WeekdayChoice {
  readonly value: number
  readonly label: string
}

export const WEEKDAY_CHOICES: readonly WeekdayChoice[] = [
  {
    value: 1,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_mon')
    },
  },
  {
    value: 2,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_tue')
    },
  },
  {
    value: 3,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_wed')
    },
  },
  {
    value: 4,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_thu')
    },
  },
  {
    value: 5,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_fri')
    },
  },
  {
    value: 6,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_sat')
    },
  },
  {
    value: 0,
    get label() {
      return i18n.t('helpers.notificationSystemEventDelivery.wd_sun')
    },
  },
]

export function hhmmOf(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function minuteOfHhmm(value: string): number {
  const [h, m] = value.split(':')
  const minute = Number(h) * 60 + Number(m)
  return Number.isFinite(minute) ? Math.max(0, Math.min(1439, minute)) : 0
}

/** What the preview says, as lines. `null` = nothing to show yet. */
export interface SummaryPreviewVerdict {
  readonly lines: readonly string[]
}

/** The tRPC error code on a rejected call, read without a cast. */
function trpcCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data: unknown = error.data
  if (typeof data !== 'object' || data === null || !('code' in data)) return undefined
  return typeof data.code === 'string' ? data.code : undefined
}

function describeDropped(dropped: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(dropped).map(([reason, n]) => `${reason} ${String(n)}`)
  return parts.length > 0
    ? i18n.t('helpers.notificationSystemEventDelivery.dropped', { parts: parts.join(', ') })
    : null
}

/**
 * The preview in words. A preview that FAILED is never read as "nothing to
 * report" (D315): an old hub that has no such method is named as such, any
 * other failure as a failure.
 */
export function previewVerdictOf(
  status: 'idle' | 'pending' | 'success' | 'error',
  data: NcStateSummaryPreview | undefined,
  error: unknown,
  /** The split the DRAFT asks for (D698) — an answer without one is an older hub's. */
  requested: NcStateSummarySplit = 'rule',
): SummaryPreviewVerdict | null {
  if (status === 'error') {
    const code = trpcCodeOf(error)
    if (code === 'NOT_FOUND') {
      return {
        lines: [
          'This hub does not serve summary rules yet — update @camstack/server first. A rule saved now would be stored without its summary, and stay instant.',
        ],
      }
    }
    return {
      lines: [
        `The preview could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  if (status !== 'success' || data === undefined) return null
  const lines: string[] = []
  if (requested === 'section' && data.split === undefined) {
    // An older hub ignores the field: it would store the rule without it and
    // send ONE message — said, never shown as if it were split (D315).
    lines.push(
      'This hub does not send per-category summaries yet — update @camstack/server first. Until then it sends one message.',
    )
  }
  if (data.empty) {
    lines.push('Nothing to report right now — no notification would be sent.')
  } else if (data.split === 'section' && data.rows !== undefined) {
    const n = data.rows.length
    lines.push(
      `${String(n)} notification${n === 1 ? '' : 's'} would be sent now, one per category:`,
    )
    for (const row of data.rows) lines.push(`${row.title}\n${row.text}`)
  } else {
    lines.push(`${String(data.count)} item(s) would be sent now:\n${data.text}`)
  }
  const dropped = describeDropped(data.dropped)
  if (dropped !== null) lines.push(dropped)
  if (data.excludedGroups.includes('backups-exports')) {
    lines.push('Backups and exports are completed jobs, not a state — they are not in a summary.')
  }
  return { lines }
}

/** The summary delivery with a new schedule — its split KEPT (D698). */
export function withSummarySchedule(
  value: Extract<NcSystemEventDelivery, { readonly mode: 'summary' }>,
  schedule: NcSchedule,
): NcSystemEventDelivery {
  return { ...value, schedule }
}

/** The summary delivery with a split; `rule` is stored as ABSENT, the default every rule had. */
export function withSummarySplit(
  value: Extract<NcSystemEventDelivery, { readonly mode: 'summary' }>,
  split: NcStateSummarySplit,
): NcSystemEventDelivery {
  const { split: _previous, ...rest } = value
  return split === 'section' ? { ...rest, split } : rest
}
