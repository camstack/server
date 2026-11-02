/**
 * The side panel of the preview grid: what the selected button does — its
 * target, the command it calls, a summary of the code, how often it repeats —
 * and a Test button. Test is always an explicit click and sends the SAVED
 * command once.
 */
import type { RemoteBinding } from '@camstack/types'
import { Button } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AutomationDevice } from '../../pages/build/automation/automation-data'
import { summarizeBinding, targetLabel } from './binding-summary'
import { isCompleteAction } from './remote-config-model'

export interface BindingPanelProps {
  readonly name: string
  readonly binding: RemoteBinding | undefined
  readonly devices: readonly AutomationDevice[]
  readonly testable: boolean
  readonly testResult: string | null
  readonly onTest: () => void
}

export function BindingPanel({
  name,
  binding,
  devices,
  testable,
  testResult,
  onTest,
}: BindingPanelProps): ReactNode {
  const { t } = useTranslation()
  const complete = binding !== undefined && isCompleteAction(binding.action)
  const summary = binding === undefined ? null : summarizeBinding(binding.action)
  return (
    <aside
      className="space-y-2 rounded border border-border bg-surface p-3"
      data-testid="binding-panel"
      aria-label={t('remote.panel.title', { name })}
    >
      <h4 className="text-sm font-medium text-foreground">{name}</h4>
      {binding === undefined || summary === null || !complete ? (
        <p className="text-xs text-foreground-muted">{t('remote.bindings.native')}</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-foreground-subtle">{t('remote.panel.target')}</dt>
          <dd className="text-foreground">
            {targetLabel(binding.action.deviceId, devices, `#${binding.action.deviceId}`)}
          </dd>
          <dt className="text-foreground-subtle">{t('remote.panel.command')}</dt>
          <dd className="break-all text-foreground">{summary.call}</dd>
          {summary.timings !== null && (
            <>
              <dt className="text-foreground-subtle">{t('remote.panel.code')}</dt>
              <dd className="text-foreground" data-testid="panel-code">
                {summary.carrierHz === null
                  ? t('remote.panel.timings', { count: summary.timings })
                  : t('remote.panel.timingsCarrier', {
                      count: summary.timings,
                      khz: Math.round(summary.carrierHz / 1000),
                    })}
              </dd>
            </>
          )}
          <dt className="text-foreground-subtle">{t('remote.panel.repeat')}</dt>
          <dd className="text-foreground">{t('remote.panel.repeatValue')}</dd>
        </dl>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!testable || !complete}
        title={testable ? undefined : t('remote.bindings.saveToTest')}
        onClick={onTest}
        data-testid="panel-test"
      >
        {t('remote.bindings.test')}
      </Button>
      {testResult !== null && (
        <p role="status" className="text-xs text-foreground-muted" data-testid="panel-result">
          {testResult}
        </p>
      )}
    </aside>
  )
}
