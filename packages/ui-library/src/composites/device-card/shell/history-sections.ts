/**
 * The History view's sections. Values are the landing page. Interactions
 * exist only when this device can list actuations, or when the card still
 * carries the older event list. One section shows at a time.
 */

export type HistoryPane = 'values' | 'interactions'

export interface HistoryPaneInput {
  readonly hasValues: boolean
  readonly hasEvents: boolean
  /** The device-transitions capability is not known to be absent. */
  readonly actuationsOffered: boolean
}

/** Values first. A single pane means no switch. */
export function historyPanes(input: HistoryPaneInput): readonly HistoryPane[] {
  const panes: HistoryPane[] = []
  if (input.hasValues) panes.push('values')
  if (input.actuationsOffered || input.hasEvents) panes.push('interactions')
  return panes
}

/** The chosen pane when it is still offered, otherwise the landing pane. */
export function shownHistoryPane(panes: readonly HistoryPane[], chosen: HistoryPane): HistoryPane {
  if (panes.includes(chosen)) return chosen
  return panes[0] ?? 'values'
}
