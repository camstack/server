/**
 * The notification centre's per-device setting: **does this device notify at
 * all?**
 *
 * This is [D113](../../../../docs/decisions/adr-0113.md) phase 3 for the
 * `notifications` row. Same shape as the header's three-switch cluster and the
 * same three rules:
 *
 *  - **It writes the AUTHORITY directly** — `notificationRules.setDeviceMuted`,
 *    the notification centre's own `notification-center:device-mutes` rows. The
 *    deprecated `pipelineOrchestrator.setCameraSwitch` shim is never called
 *    from here.
 *  - **It never normalises on mount.** Mounting issues one read. A device muted
 *    through the old switch group — which wrote this same store — renders MUTED
 *    on the first render, not quietly un-muted by the surface that came to
 *    display it.
 *  - **An unknown state is not a control.** A `listDeviceMutes` that failed
 *    draws "unknown" and cannot be clicked.
 *
 * Why the mute needed a surface of its own before the group could go: it is the
 * one member of that group whose OFF state is a durable row the notification
 * centre reads on every event (and the alarm reports as
 * `skippedDevices: 'muted'`). Deleting the group first would have left an
 * indefinite silence nothing could see and nothing could lift.
 */

import {
  useNotificationRulesListDeviceMutes,
  useNotificationRulesSetDeviceMuted,
  Button,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { BellOff, BellRing } from 'lucide-react'
import { useCallback, useState } from 'react'
import {
  type NotificationMuteState,
  notificationMuteWrite,
  resolveNotificationMute,
} from './device-notification-mute'
import { useTranslation } from 'react-i18next'

export interface DeviceNotificationMuteProps {
  readonly deviceId: number
  /** The device is a camera — its copy then names its tracks and recordings. */
  readonly isCamera: boolean
}

/**
 * Narrow the `listDeviceMutes` answer to the one field read here.
 *
 * A guard rather than a cast, and anything unrecognised is `null` — UNKNOWN,
 * never an empty list. An empty list is the positive claim "nothing is muted",
 * and a device the operator silenced must never be reported as notifying.
 */
function readMutedDeviceIds(data: unknown): readonly number[] | null {
  if (data === null || typeof data !== 'object') return null
  const rec: Record<string, unknown> = { ...data }
  const raw = rec['mutedDeviceIds']
  if (!Array.isArray(raw)) return null
  return raw.filter((id): id is number => typeof id === 'number')
}

export function DeviceNotificationMute({ deviceId, isCamera }: DeviceNotificationMuteProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const enabled = Number.isFinite(deviceId)
  const [failure, setFailure] = useState<string | null>(null)
  // The value an in-flight write asked for. Held here rather than patched into
  // the react-query cache: the cache key for a cap query is composed by the
  // generated hook, and a `setQueryData` under a guessed key silently does
  // nothing — an optimistic update that never lands looks exactly like a write
  // the hub refused.
  const [pendingOn, setPendingOn] = useState<boolean | null>(null)

  const mutesQuery = useNotificationRulesListDeviceMutes({}, { enabled })

  const state: NotificationMuteState = resolveNotificationMute({
    mutedDeviceIds: readMutedDeviceIds(mutesQuery.data),
    deviceId,
    isCamera,
    pendingOn,
  })
  const costWhenOff = t(state.costWhenOff.i18nKey, state.costWhenOff.text)

  const setDeviceMuted = useNotificationRulesSetDeviceMuted({
    onError: (err: unknown) => {
      // The revert is invisible unless it is said out loud, and the line
      // carries the numeric deviceId like every other per-device line.
      console.error('[DeviceNotificationMute] mute write failed — reverting', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      setPendingOn(null)
      setFailure(err instanceof Error ? err.message : String(err))
      void queryClient.invalidateQueries({
        queryKey: [['notificationRules', 'listDeviceMutes']],
      })
    },
    onSuccess: () => {
      setFailure(null)
      setPendingOn(null)
      // Re-read the authority rather than trusting the flip: this surface and
      // the notification centre must never be able to disagree about a device
      // that is silent.
      void queryClient.invalidateQueries({ queryKey: [['notificationRules']] })
    },
  })

  const toggle = useCallback((): void => {
    const write = notificationMuteWrite(state, deviceId)
    if (write === null) return
    setPendingOn(!write.muted)
    setDeviceMuted.mutate(write)
  }, [deviceId, setDeviceMuted, state])

  const unknown = state.on === null
  const off = state.on === false
  const Icon = off ? BellOff : BellRing

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          {t('device.deviceNotificationMute.notifications', 'Notifications')}
        </h2>
        {/* An off function is REPORTED off (D113): a device that never
            notifies must not read as a notification centre that is broken. */}
        {off && (
          <span className="rounded bg-warning/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning">
            {t('common.muted')}
          </span>
        )}
      </div>
      <div className="px-4 py-3 flex items-start gap-3">
        <Button
          variant="unstyled"
          type="button"
          role="switch"
          aria-label={state.label}
          aria-checked={state.on === true}
          disabled={!state.available || setDeviceMuted.isPending}
          onClick={toggle}
          title={
            unknown
              ? t(
                  'device.deviceNotificationMute.notificationMuteStateUnknownThe',
                  'Notification mute — state unknown; the notification centre did not answer.',
                )
              : off
                ? t('device.deviceNotificationMute.muted', 'Muted. {{costWhenOff}}', {
                    costWhenOff,
                  })
                : t(
                    'device.deviceNotificationMute.notifyingMutingIt',
                    'Notifying. Muting it: {{costWhenOff}}',
                    { costWhenOff },
                  )
          }
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed ${
            failure !== null
              ? 'border-danger/50 text-danger bg-danger/5'
              : unknown
                ? 'border-dashed border-border text-foreground-subtle/50'
                : off
                  ? 'border-warning/40 text-warning hover:bg-warning/10'
                  : 'border-success/30 text-success hover:bg-success/10'
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          <span>
            {unknown
              ? t('device.deviceNotificationMute.unknown', 'Unknown')
              : off
                ? t('device.deviceNotificationMute.muted2', 'Muted')
                : t('device.deviceNotificationMute.notifying', 'Notifying')}
          </span>
        </Button>
        <p className="flex-1 text-[11px] leading-relaxed text-foreground-subtle">
          {failure !== null
            ? t('device.deviceNotificationMute.writeFailed', 'Write failed: {{failure}}', {
                failure,
              })
            : unknown
              ? t(
                  'device.deviceNotificationMute.theNotificationCentreDidNot',
                  'The notification centre did not answer, so this device’s mute state is unknown.',
                )
              : costWhenOff}
        </p>
      </div>
    </div>
  )
}
