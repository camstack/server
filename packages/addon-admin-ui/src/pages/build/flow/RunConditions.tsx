/**
 * The conditions of the selected run as a list, wherever the editor draws them:
 * each leaf the run evaluated, with what it read, what it wanted and the
 * result. The same strip the When rows show inline, so a run can be read
 * without matching its rows to the tree.
 */

import type { AutomationRunTrace } from '@camstack/types'
import { useTranslation } from 'react-i18next'
import { ConditionResult } from './TraceResult'
import { traceDetails } from './trace-view'

/** Containers only group their children; their verdict is the children's. */
const CONTAINER_KINDS: ReadonlySet<string> = new Set(['all', 'any', 'not'])

export function RunConditions({ run }: { readonly run: AutomationRunTrace }) {
  const { t } = useTranslation()
  const leaves = traceDetails(run).conditions.filter((n) => !CONTAINER_KINDS.has(n.kind))
  if (leaves.length === 0) return null
  return (
    <section
      className="space-y-2 border-t border-border-subtle px-3 py-2"
      data-testid="run-conditions"
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
        {t('flow.runs.conditionsTitle', 'Conditions')}
      </h4>
      <ul className="space-y-2">
        {leaves.map((node) => (
          <li key={node.path} data-testid="run-condition">
            <ConditionResult node={node} expected={node.expected} observed={node.observed} />
          </li>
        ))}
      </ul>
    </section>
  )
}
