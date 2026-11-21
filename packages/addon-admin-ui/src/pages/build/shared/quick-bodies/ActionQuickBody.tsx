/**
 * Action quick body: what it does (steps, the devices it names), a Run button,
 * and its last executions. The editor cannot select a run from a link, so the
 * rows carry no per-run link.
 */
import type { ActionEntry } from '@camstack/types'
import { Badge, Button, useActionsGetTraces, useActionsRun } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { actionDeviceIds } from '../action-devices'
import {
  type QuickFact,
  QuickDeviceLinks,
  QuickFacts,
  QuickRunList,
  QuickSection,
} from '../QuickParts'

const TRACES_POLL_MS = 10_000

export interface ActionQuickBodyProps {
  readonly entry: ActionEntry
}

export function ActionQuickBody({ entry }: ActionQuickBodyProps): ReactNode {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const run = useActionsRun({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['actions']] }),
  })
  const traces = useActionsGetTraces({ actionId: entry.id }, { refetchInterval: TRACES_POLL_MS })
  const facts: QuickFact[] = [
    {
      key: t('build.quickModal.source', 'Source'),
      value: entry.readOnly ? (
        <Badge variant="info">{entry.addonId}</Badge>
      ) : (
        t('actions.source.internal', 'Internal')
      ),
    },
    {
      key: t('build.quickModal.steps', 'Steps'),
      value: t('build.quickModal.stepCount', '{{count}} steps', {
        count: (entry.steps ?? []).length,
      }),
    },
    {
      key: t('build.quickModal.devices', 'Devices'),
      value: (
        <QuickDeviceLinks
          ids={actionDeviceIds(entry.steps ?? [])}
          empty={t('build.quickModal.noDevices', 'No device named directly')}
        />
      ),
    },
  ]
  return (
    <>
      <QuickSection title={t('build.quickModal.summary', 'Summary')}>
        <QuickFacts items={facts} />
        {entry.status.lastError !== null && (
          <p className="mt-2 text-xs text-danger">{entry.status.lastError}</p>
        )}
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={run.isPending || entry.status.isRunning}
            data-testid="quick-action-run"
            onClick={() => run.mutate({ actionId: entry.id })}
          >
            <Play className="h-4 w-4" /> {t('actions.list.run', 'Run')}
          </Button>
        </div>
      </QuickSection>
      <QuickSection title={t('build.quickModal.lastExecutions', 'Last executions')}>
        <QuickRunList
          traces={traces.data?.traces}
          failed={traces.error !== null && traces.error !== undefined}
          emptyLabel={t('actions.status.neverRan', 'Never ran')}
          kind="run"
        />
      </QuickSection>
    </>
  )
}
