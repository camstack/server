/**
 * The Last runs tab of an automation or an action. Each component owns its
 * ledger query, and the shell mounts it only while the tab is open: nothing is
 * requested at modal open.
 */
import { useActionsGetTraces, useCoreBlocksGetTraces } from '@dominevo/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { QuickRunList } from '../QuickParts'

const TRACES_POLL_MS = 10_000

export function AutomationLastRuns({
  blockId,
  onOpenRun,
}: {
  readonly blockId: string
  /** Opens the editor on the run. */
  readonly onOpenRun: (runId: string) => void
}): ReactNode {
  const { t } = useTranslation()
  const traces = useCoreBlocksGetTraces({ blockId }, { refetchInterval: TRACES_POLL_MS })
  return (
    <QuickRunList
      traces={traces.data?.traces}
      failed={traces.error !== null && traces.error !== undefined}
      emptyLabel={t('automation.automationList.neverRan', 'Never ran')}
      kind="run"
      onOpenRun={onOpenRun}
    />
  )
}

export function ActionLastRuns({ actionId }: { readonly actionId: string }): ReactNode {
  const { t } = useTranslation()
  const traces = useActionsGetTraces({ actionId }, { refetchInterval: TRACES_POLL_MS })
  return (
    <QuickRunList
      traces={traces.data?.traces}
      failed={traces.error !== null && traces.error !== undefined}
      emptyLabel={t('actions.status.neverRan', 'Never ran')}
      kind="run"
    />
  )
}
