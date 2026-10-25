/**
 * The panel as it is NOW: its state, the arm and disarm buttons, a refused
 * arm's blockers with the Arm anyway bound to that refusal, and the sensors
 * the panel is currently ignoring.
 *
 * Arming goes through the Notification Center's own bridge actions
 * (`nc.armAlarm` / `nc.armAlarmAnyway` / `nc.disarmAlarm` on
 * `pipeline-analytics`), not `alarm-panel.arm`: the cap answers `void` and can
 * only THROW a refusal, so its id — which Arm anyway must carry — would be lost.
 * The bridge returns the refusal as a result.
 *
 * Every press awaits its answer and shows what came back. A refusal is not an
 * error, it is the panel telling the operator which door is open.
 */

import type { AlarmArmMode } from '@camstack/types'
import { Button, Card, ErrorBox, useSystem } from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { hubDeviceName, refusalHeadline } from './alarm-nonblocking.helpers'
import {
  alarmIsActive,
  alarmModeLabel,
  alarmStateLabel,
  exclusionPhaseLabel,
  type NcAlarmArmOutcomeView,
  type NcAlarmLiveView,
  type NcAlarmOpenDeviceView,
  parseArmOutcome,
  rejectReasonLabel,
} from './notification-alarm.helpers'
import { useTranslation } from 'react-i18next'

const NC_ADDON_ID = 'pipeline-analytics'
const UNREADABLE = 'The hub answered something this build cannot read — refresh after updating.'

interface RefusalView {
  readonly refusalId: string
  readonly blocking: readonly NcAlarmOpenDeviceView[]
}

interface AlarmLiveCardProps {
  /** Undefined when the hub answered WITHOUT `live` — not "nothing going on". */
  readonly live: NcAlarmLiveView | undefined
  /** Re-reads the panel after every press, whatever it came to. */
  readonly onChanged: () => Promise<void>
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function devicesLine(devices: readonly NcAlarmOpenDeviceView[]): string {
  return devices.map((d) => `${hubDeviceName(d)} (${d.state})`).join(', ')
}

export function AlarmLiveCard({ live, onChanged }: AlarmLiveCardProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [refusal, setRefusal] = useState<RefusalView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const callNc = (action: string, input: object): Promise<unknown> =>
    system.trpcClient.addons.custom.mutate({ addonId: NC_ADDON_ID, action, input })

  const applyOutcome = (outcome: NcAlarmArmOutcomeView | null): void => {
    if (outcome === null) {
      setProblem(UNREADABLE)
      return
    }
    if (outcome.outcome === 'refused') {
      // A second refusal REPLACES the first: its id is the only one the panel
      // will still honour, and its blockers are what is open now.
      setRefusal({ refusalId: outcome.refusalId, blocking: outcome.blocking })
      return
    }
    setRefusal(null)
    if (outcome.outcome === 'rejected') {
      setProblem(`Arm anyway was not accepted: ${rejectReasonLabel(outcome.reason)}.`)
      return
    }
    if (outcome.outcome === 'outside-schedule') {
      setProblem("Outside this mode's activation schedule — arm during an allowed window.")
      return
    }
    const verb = outcome.outcome === 'armed' ? 'Armed' : 'Arming'
    setNotice(
      outcome.excluded.length === 0
        ? `${verb}.`
        : `${verb} — excluded: ${devicesLine(outcome.excluded)}.`,
    )
  }

  const begin = (): void => {
    setProblem(null)
    setNotice(null)
  }

  const arm = useMutation({
    mutationFn: async (mode: AlarmArmMode) =>
      parseArmOutcome(await callNc('nc.armAlarm', { mode })),
    onMutate: begin,
    onSuccess: applyOutcome,
    onError: (err: unknown) => setProblem(errorText(err)),
    onSettled: onChanged,
  })

  const armAnyway = useMutation({
    mutationFn: async (refusalId: string) =>
      parseArmOutcome(await callNc('nc.armAlarmAnyway', { refusalId })),
    onMutate: begin,
    onSuccess: applyOutcome,
    onError: (err: unknown) => setProblem(errorText(err)),
    onSettled: onChanged,
  })

  const disarm = useMutation({
    mutationFn: async () => callNc('nc.disarmAlarm', {}),
    onMutate: () => {
      begin()
      setRefusal(null)
    },
    onSuccess: () => setNotice('Disarmed.'),
    onError: (err: unknown) => setProblem(errorText(err)),
    onSettled: onChanged,
  })

  if (live === undefined) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-1">{t('system.alarmLiveCard.panel', 'Panel')}</h3>
        <p className="text-sm text-foreground-subtle">
          {t(
            'system.alarmLiveCard.thisHubDoesNotReport',
            "This hub does not report the panel's live state yet — update it to arm from here.",
          )}
        </p>
      </Card>
    )
  }

  const busy = arm.isPending || armAnyway.isPending || disarm.isPending

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('system.alarmLiveCard.panel', 'Panel')}</h3>
          <p className="text-lg font-medium" data-testid="alarm-state">
            {alarmStateLabel(live)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {live.availableModes.map((mode) => (
            <Button
              key={mode}
              type="button"
              size="md"
              variant="outline"
              disabled={busy}
              onClick={() => arm.mutate(mode)}
              data-testid={`alarm-arm-${mode}`}
            >
              {t('system.alarmLiveCard.arm', { mode: alarmModeLabel(mode) })}
            </Button>
          ))}
          <Button
            type="button"
            size="md"
            variant={alarmIsActive(live.state) ? 'danger' : 'secondary'}
            disabled={busy}
            onClick={() => disarm.mutate()}
            data-testid="alarm-disarm"
          >
            {t('system.alarmLiveCard.disarm', 'Disarm')}
          </Button>
        </div>
      </div>

      {problem !== null ? (
        <div className="mt-3">
          <ErrorBox
            title={t('system.alarmLiveCard.thePanelDidNotDo', 'The panel did not do that')}
            message={problem}
          />
        </div>
      ) : null}
      {notice !== null ? <p className="mt-3 text-sm text-foreground-subtle">{notice}</p> : null}

      {refusal !== null ? (
        <div className="mt-3 rounded border border-warning p-3" data-testid="alarm-refused">
          <p className="text-sm font-medium">{refusalHeadline(refusal.blocking.length)}</p>
          {refusal.blocking.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {refusal.blocking.map((d) => (
                <li key={d.deviceId}>
                  {hubDeviceName(d)} <span className="text-foreground-subtle">({d.state})</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="md"
              variant="danger"
              disabled={busy}
              onClick={() => armAnyway.mutate(refusal.refusalId)}
            >
              {t('system.alarmLiveCard.armAnyway', 'Arm anyway')}
            </Button>
            <span className="text-xs text-foreground-subtle">
              {t(
                'system.alarmLiveCard.eachOpenDeviceIsIgnored',
                'Each open device is ignored until it closes, then monitored again.',
              )}
            </span>
          </div>
        </div>
      ) : null}

      <div className="mt-4" data-testid="alarm-exclusions">
        <h4 className="text-xs font-semibold uppercase text-foreground-subtle">
          {t('system.alarmLiveCard.excludedSensors', 'Excluded sensors')}
        </h4>
        {live.exclusions.length === 0 ? (
          <p className="text-sm text-foreground-subtle">
            {t('system.alarmLiveCard.noSensorIsExcluded', 'No sensor is excluded.')}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {live.exclusions.map((x) => (
              <li key={x.deviceId}>
                {hubDeviceName(x)} —{' '}
                <span className="text-foreground-subtle">{exclusionPhaseLabel(x.phase)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
