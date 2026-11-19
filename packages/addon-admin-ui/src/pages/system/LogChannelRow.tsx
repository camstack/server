/**
 * One declared log channel on Logs → Diagnostics.
 *
 * A `diagnostic` channel is ARMED for a window (`system.setLoggingSettings`);
 * a `debug` channel is WATCHED (`system.debugWatch`) for chosen cameras. The
 * row shows the kind, the deadline, and — only when the channel can honestly
 * honour it — a camera picker.
 *
 * A channel declared `perDevice: false` says so and offers no picker: its
 * lines carry the device in `meta` rather than in `tags: { deviceId }`, so a
 * per-camera narrowing would select none of them, and an operator who narrowed
 * and saw nothing would conclude the code path was never taken. The server
 * refuses such a patch too; the UI does not offer the lie in the first place.
 */
import { useState, type ReactElement } from 'react'
import { Camera, Square, TimerReset } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, DeviceValuePicker, deviceIdsOf, pickedFromDeviceIds } from '@camstack/ui-library'
import {
  DeviceType,
  type DebugWatchState,
  type LogChannelDescriptor,
  type LogChannelWindowState,
} from '@camstack/types'
import { formatRemaining, watchCountdown } from './log-watch.helpers'

/** Offered arm windows. The server clamps; these are the useful shapes. */
const ARM_CHOICES_MS: readonly number[] = [120_000, 300_000, 600_000, 1_800_000]

/** A channel follows cameras only, and at most this many. */
const CAMERA_TYPES: readonly string[] = [DeviceType.Camera]
const MAX_CAMERAS = 8

export interface LogChannelRowProps {
  readonly channel: LogChannelDescriptor
  /** The armed window of a diagnostic channel, when the hub reports one. */
  readonly armed: LogChannelWindowState | undefined
  /** The live watch of a debug channel, when one is running. */
  readonly watch: DebugWatchState | undefined
  readonly nowMs: number
  readonly busy: boolean
  /** `deviceIds: null` = every camera. */
  readonly onArm: (armMs: number, deviceIds: readonly number[] | null) => void
  readonly onStartWatch: (deviceIds: readonly number[]) => void
  readonly onStopWatch: () => void
}

const BADGE = 'rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground-subtle'
const WARN_BADGE =
  'inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold text-warning'
const ARM_BUTTON =
  'rounded border border-border px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground disabled:opacity-50'

export function LogChannelRow(props: LogChannelRowProps): ReactElement {
  const { channel, armed, watch, nowMs, busy } = props
  const { t } = useTranslation()
  const [cameras, setCameras] = useState<readonly number[]>([])
  const isDebug = channel.kind === 'debug'
  const isArmed = armed?.armed === true
  const left = watch === undefined ? undefined : watchCountdown(watch, nowMs)

  return (
    <div className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{channel.name}</span>
          <span className={BADGE}>
            {t(`logging.diagnostics.kind.${channel.kind}`, channel.kind)}
          </span>
          {isDebug && left !== undefined && (
            <span className={WARN_BADGE}>
              <TimerReset className="h-3 w-3" />
              {t('logging.diagnostics.endsIn', { left: formatRemaining(left.windowMs) })}
            </span>
          )}
          {!isDebug && isArmed && (
            <span className={WARN_BADGE}>
              <TimerReset className="h-3 w-3" />
              {t('logging.diagnostics.expiresIn', {
                left: formatRemaining(armed?.remainingMs ?? 0),
              })}
            </span>
          )}
          {!isDebug && !isArmed && (
            <span className={BADGE}>{t('logging.diagnostics.disarmed', 'disarmed')}</span>
          )}
          {!isDebug && isArmed && armed?.deviceIds != null && (
            <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <Camera className="h-3 w-3" />
              {armed.deviceIds.join(', ')}
            </span>
          )}
          {isDebug && watch !== undefined && (
            <span className="text-[11px] text-foreground-subtle">
              #{watch.deviceIds.join(', #')}
              {left !== undefined &&
                ` · ${t('logging.diagnostics.capIn', { left: formatRemaining(left.capMs) })}`}
            </span>
          )}
          {!channel.perDevice && (
            <span className={BADGE}>
              {t('logging.diagnostics.notPerCamera', 'not filterable per camera')}
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-2xl text-[11px] text-foreground-subtle">{channel.description}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-1 lg:items-end">
        {channel.perDevice && (
          <div className="w-full lg:w-72">
            <DeviceValuePicker
              multiple
              pick="device"
              noun="camera"
              fixedTypes={CAMERA_TYPES}
              maxItems={MAX_CAMERAS}
              recentKey="log-channel-cameras"
              testId={`log-channel-cameras-${channel.name}`}
              value={pickedFromDeviceIds(cameras)}
              onChange={(next) => setCameras(deviceIdsOf(next))}
            />
          </div>
        )}
        {isDebug ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              disabled={busy || cameras.length === 0}
              title={
                cameras.length === 0
                  ? t(
                      'logging.diagnostics.pickCamerasToWatch',
                      'Pick at least one camera to start a watch.',
                    )
                  : undefined
              }
              onClick={() => props.onStartWatch(cameras)}
            >
              {t('logging.diagnostics.watchStart', 'Start watching')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || watch === undefined}
              onClick={props.onStopWatch}
            >
              <Square className="mr-1 h-3.5 w-3.5" />
              {t('logging.diagnostics.watchStop', 'Stop')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            {ARM_CHOICES_MS.map((ms) => (
              <Button
                variant="unstyled"
                key={ms}
                type="button"
                disabled={busy}
                onClick={() => props.onArm(ms, cameras.length > 0 ? cameras : null)}
                className={ARM_BUTTON}
              >
                {formatRemaining(ms)}
              </Button>
            ))}
            <Button
              variant="unstyled"
              type="button"
              disabled={busy || !isArmed}
              onClick={() => props.onArm(0, null)}
              className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
            >
              {t('logging.diagnostics.disarm', 'Disarm')}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

export { ARM_BUTTON, ARM_CHOICES_MS }
