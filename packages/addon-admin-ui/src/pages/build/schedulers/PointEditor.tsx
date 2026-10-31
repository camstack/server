/**
 * One timeline point: when (clock or sun ± offset), what kind (edge, hold,
 * release), its actions through the shared ActionList, and a hold's manual
 * override policy.
 */
import type {
  ActionStep,
  AutomationAction,
  HoldOverride,
  SchedulerIssue,
  SchedulerPoint,
  SchedulerPointMode,
  SunEvent,
} from '@camstack/types'
import { Button, Input, Select } from '@camstack/ui-library'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ActionList } from '../automation/ActionList'
import type { AutomationDevice } from '../automation/automation-data'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import {
  clockText,
  minuteText,
  parseClockText,
  type PointTime,
  type SiteView,
  sunBaseMinute,
  pointMinute,
} from './scheduler-model'

export interface PointEditorProps {
  readonly point: SchedulerPoint
  readonly devices: readonly AutomationDevice[]
  readonly site: SiteView
  readonly localDate: string
  readonly issues: readonly SchedulerIssue[]
  readonly onChange: (next: SchedulerPoint) => void
  readonly onRemove: () => void
}

const SUN_EVENTS: readonly SunEvent[] = ['sunrise', 'sunset', 'dawn', 'dusk']
const GRACE_STEP_MS = 60_000

function isActionStep(action: AutomationAction): action is ActionStep {
  return action.kind === 'cap' || action.kind === 'wait'
}

/** The point after a mode switch: what the new mode cannot carry is dropped. */
export function withMode(point: SchedulerPoint, mode: SchedulerPointMode): SchedulerPoint {
  const kept: SchedulerPoint = {
    id: point.id,
    at: point.at,
    mode,
    steps: mode === 'release' ? [] : point.steps,
    ...(point.conditions === undefined ? {} : { conditions: point.conditions }),
  }
  if (mode !== 'hold') return kept
  return {
    ...kept,
    ...(point.override === undefined ? {} : { override: point.override }),
    ...(point.maxHoldAttempts === undefined ? {} : { maxHoldAttempts: point.maxHoldAttempts }),
  }
}

export function PointEditor({
  point,
  devices,
  site,
  localDate,
  issues,
  onChange,
  onRemove,
}: PointEditorProps) {
  const { t } = useTranslation()
  const at = point.at
  const sunMinute = at.kind === 'sun' ? pointMinute(at, site, localDate) : null
  const base = sunBaseMinute(at, site, localDate)
  const override: HoldOverride = point.override ?? { mode: 'respect' }

  const setAt = (next: PointTime): void => onChange({ ...point, at: next })

  return (
    <div className="space-y-3" data-testid="point-editor">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-foreground-muted">
          <span>{t('schedulers.point.kind', 'Point type')}</span>
          <Select
            aria-label={t('schedulers.point.kind', 'Point type')}
            value={point.mode}
            options={[
              {
                value: 'edge',
                label: t('schedulers.point.edge', 'Edge: run once'),
              },
              {
                value: 'hold',
                label: t('schedulers.point.hold', 'Hold: keep true'),
              },
              {
                value: 'release',
                label: t('schedulers.point.release', 'Release: end the hold'),
              },
            ]}
            onChange={(e) => {
              const value = e.target.value
              if (value === 'edge' || value === 'hold' || value === 'release')
                onChange(withMode(point, value))
            }}
          />
        </label>
        <label className="space-y-1 text-xs text-foreground-muted">
          <span>{t('schedulers.point.when', 'When')}</span>
          <Select
            aria-label={t('schedulers.point.when', 'When')}
            value={at.kind === 'sun' ? 'sun' : 'clock'}
            options={[
              {
                value: 'clock',
                label: t('schedulers.point.clock', 'At a time'),
              },
              {
                value: 'sun',
                label: t('schedulers.point.sun', 'At a sun event'),
              },
            ]}
            onChange={(e) => {
              if (e.target.value === 'sun') setAt({ kind: 'sun', event: 'sunset', offsetMin: 0 })
              else setAt({ kind: 'clock', hh: 12, mm: 0 })
            }}
          />
        </label>
        {at.kind === 'clock' && (
          <label className="space-y-1 text-xs text-foreground-muted">
            <span>{t('schedulers.point.time', 'Time')}</span>
            <Input
              type="time"
              aria-label={t('schedulers.point.time', 'Time')}
              value={clockText(at.hh, at.mm)}
              onChange={(e) => {
                const parsed = parseClockText(e.target.value)
                if (parsed !== null) setAt(parsed)
              }}
            />
          </label>
        )}
        {at.kind === 'sun' && (
          <>
            <label className="space-y-1 text-xs text-foreground-muted">
              <span>{t('schedulers.point.sunEvent', 'Sun event')}</span>
              <Select
                aria-label={t('schedulers.point.sunEvent', 'Sun event')}
                value={at.event}
                options={SUN_EVENTS.map((event) => ({
                  value: event,
                  label: t(`schedulers.sun.${event}`, event),
                }))}
                onChange={(e) => {
                  const event = SUN_EVENTS.find((candidate) => candidate === e.target.value)
                  if (event !== undefined) setAt({ ...at, event })
                }}
              />
            </label>
            <label className="space-y-1 text-xs text-foreground-muted">
              <span>{t('schedulers.point.offset', 'Offset (minutes, negative = before)')}</span>
              <DraftNumberInput
                aria-label={t('schedulers.point.offset', 'Offset (minutes, negative = before)')}
                className="w-28"
                value={at.offsetMin}
                onValue={(value) => {
                  if (value !== null) setAt({ ...at, offsetMin: Math.round(value) })
                }}
              />
            </label>
            <p className="pb-2 text-xs text-foreground-muted" data-testid="sun-computed">
              {sunMinute === null || base === null
                ? t('schedulers.point.sunUnknown', 'No time today: the site location is not set.')
                : t('schedulers.point.sunComputed', 'Today at {{time}} ({{zone}})', {
                    time: minuteText(sunMinute),
                    zone: site.timeZone,
                  })}
            </p>
          </>
        )}
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={onRemove}
          aria-label={t('schedulers.point.remove', 'Remove point')}
        >
          <Trash2 className="h-4 w-4" /> {t('schedulers.point.remove', 'Remove point')}
        </Button>
      </div>

      {point.mode !== 'release' && (
        <ActionList
          actions={point.steps}
          devices={devices}
          allowedKinds={['cap', 'wait']}
          onChange={(steps) => onChange({ ...point, steps: steps.filter(isActionStep) })}
        />
      )}
      {point.mode === 'release' && (
        <p className="text-xs text-foreground-subtle">
          {t(
            'schedulers.point.releaseHint',
            'A release ends the running hold without doing anything to the devices.',
          )}
        </p>
      )}

      {point.mode === 'hold' && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs text-foreground-muted">
            <span>{t('schedulers.point.override', 'If someone changes it by hand')}</span>
            <Select
              aria-label={t('schedulers.point.override', 'If someone changes it by hand')}
              value={override.mode}
              options={[
                {
                  value: 'respect',
                  label: t('schedulers.point.respect', 'Leave it alone'),
                },
                {
                  value: 'reassert',
                  label: t('schedulers.point.reassert', 'Put the hold back after a while'),
                },
              ]}
              onChange={(e) =>
                onChange({
                  ...point,
                  override:
                    e.target.value === 'reassert'
                      ? { mode: 'reassert', graceMs: 10 * GRACE_STEP_MS }
                      : { mode: 'respect' },
                })
              }
            />
          </label>
          {override.mode === 'reassert' && (
            <label className="space-y-1 text-xs text-foreground-muted">
              <span>{t('schedulers.point.grace', 'Wait (minutes)')}</span>
              <DraftNumberInput
                aria-label={t('schedulers.point.grace', 'Wait (minutes)')}
                className="w-24"
                value={override.graceMs / GRACE_STEP_MS}
                onValue={(value) => {
                  if (value !== null)
                    onChange({
                      ...point,
                      override: {
                        mode: 'reassert',
                        graceMs: Math.max(0, Math.round(value * GRACE_STEP_MS)),
                      },
                    })
                }}
              />
            </label>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <ul className="space-y-1 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
