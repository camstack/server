/**
 * Whether the quick-detail modal shows a History tab.
 *
 * Hidden until `listSeries` has answered with at least one series. A pending,
 * failed or empty read does not render "no history" and does not flash a tab
 * that would disappear once an empty answer arrives (D315).
 */

export interface HistoryListSnapshot {
  readonly status: 'pending' | 'error' | 'ok'
  readonly error?: string
  readonly data?: readonly unknown[]
}

export function historyTabVisible(
  presence: 'pending' | 'present' | 'absent' | 'unknown',
  list: HistoryListSnapshot,
): boolean {
  return presence === 'present' && list.status === 'ok' && (list.data?.length ?? 0) > 0
}
