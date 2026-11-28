/**
 * THEN → "Ping / reachability": does a TCP port on a host answer. The result
 * (`reachable`, `rttMs`, `error`) is written to the variable named in "Save
 * result as", for `{{vars.<name>.reachable}}` in the steps after it.
 */
import {
  type AutomationProbeStep,
  PROBE_TIMEOUT_MAX_S,
  REACH_RETRY_INTERVAL_S,
  REACH_RETRY_MAX_S,
} from '@dominevo/types'
import { Input, Select, DurationInput } from '@dominevo/ui-library'
import { useTranslation } from 'react-i18next'
import { PickerLabel } from './FieldPicker'
import { probeExpect, probeRetry, probeSaveAs, wholeNumber } from './reach-step-model'

export interface ProbeFieldsProps {
  readonly index: number
  readonly step: AutomationProbeStep
  readonly onChange: (next: AutomationProbeStep) => void
}

function expectOf(value: string): AutomationProbeStep['expect'] {
  return value === 'reachable' || value === 'unreachable' ? value : undefined
}

export function ProbeFields({ index, step, onChange }: ProbeFieldsProps) {
  const { t } = useTranslation()
  const at = String(index)
  return (
    <div className="space-y-2" data-testid={`probe-step-${at}`}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1">
          <PickerLabel>{t('automation.reach.host', 'Host or address')}</PickerLabel>
          <Input
            data-testid={`probe-host-${at}`}
            value={step.host}
            spellCheck={false}
            placeholder="192.168.20.158"
            onChange={(e) => onChange({ ...step, host: e.target.value })}
          />
        </label>
        <label className="w-28">
          <PickerLabel>{t('automation.reach.port', 'TCP port')}</PickerLabel>
          <Input
            data-testid={`probe-port-${at}`}
            type="number"
            min={1}
            max={65535}
            value={String(step.port)}
            onChange={(e) => onChange({ ...step, port: wholeNumber(e.target.value) ?? 0 })}
          />
        </label>
        <div>
          <PickerLabel>{t('automation.reach.timeout', 'Timeout (s)')}</PickerLabel>
          <DurationInput
            aria-label={t('automation.reach.timeout', 'Timeout (s)')}
            value={step.timeoutSeconds}
            min={1}
            max={PROBE_TIMEOUT_MAX_S}
            testIdPrefix={`probe-timeout-${at}`}
            onChange={(seconds) => onChange({ ...step, timeoutSeconds: Math.max(1, seconds) })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="w-56">
          <PickerLabel>
            {t('automation.reach.probeExpect', 'The step passes when the host is')}
          </PickerLabel>
          <Select
            data-testid={`probe-expect-${at}`}
            value={step.expect ?? 'reachable'}
            onChange={(e) => onChange(probeExpect(step, expectOf(e.target.value)))}
            options={[
              { value: 'reachable', label: t('automation.reach.reachable', 'Reachable') },
              { value: 'unreachable', label: t('automation.reach.unreachable', 'Unreachable') },
            ]}
          />
        </label>
        <div>
          <PickerLabel>{t('automation.reach.retry', 'Keep trying for (s)')}</PickerLabel>
          <DurationInput
            aria-label={t('automation.reach.retry', 'Keep trying for (s)')}
            value={step.retryUntilSeconds ?? 0}
            max={REACH_RETRY_MAX_S}
            testIdPrefix={`probe-retry-${at}`}
            onChange={(seconds) => onChange(probeRetry(step, seconds > 0 ? seconds : undefined))}
          />
        </div>
        <label className="w-44">
          <PickerLabel>{t('automation.reach.saveAs', 'Save result as')}</PickerLabel>
          <Input
            data-testid={`probe-save-as-${at}`}
            value={step.saveAs ?? ''}
            spellCheck={false}
            placeholder="ccu"
            onChange={(e) => onChange(probeSaveAs(step, e.target.value))}
          />
        </label>
      </div>
      <span className="block text-xs text-foreground-subtle">
        {t(
          'automation.reach.probeHint',
          'Tries to open a TCP connection. With a time to keep trying, it tries again every {{every}} s until the host is as expected; if it never is, the step fails.',
          { every: REACH_RETRY_INTERVAL_S },
        )}
      </span>
    </div>
  )
}
