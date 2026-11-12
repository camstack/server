/**
 * Dishwasher controls for a `DeviceType.Dishwasher` device.
 *
 * Reads the `dishwasher` cap status slice and renders the device-list row
 * (`DishwasherInlineControl`). The device-detail hero is the device card
 * (`composites/device-card`, `ConnectedDishwasherCard`).
 *
 * Salt and rinse aid are not here: they are items of the device's `consumables`
 * cap, shown by the page's Consumables section like every device's (D915).
 *
 * UNKNOWN IS NOT OFF. The slice carries `null` for everything the appliance has not
 * reported, and this view renders that as "—" / a disabled control, never as an unchecked
 * box or a zero. It also does not echo a command before the appliance confirms it: the
 * slice moves when the appliance says so.
 */
import { useUiText, defaultUiText, type UiTextFn } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { DoorOpen, Pause, Play, Timer } from 'lucide-react'
import { type DishwasherOperationState, type DishwasherStatus, NOT_REPORTED } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

interface DishwasherCap {
  readonly start: (input: Record<string, never>) => Promise<void>
  readonly pause: (input: Record<string, never>) => Promise<void>
  readonly resume: (input: Record<string, never>) => Promise<void>
  readonly stop: (input: Record<string, never>) => Promise<void>
  readonly setProgram: (input: { program: string }) => Promise<void>
  readonly setPower: (input: { on: boolean }) => Promise<void>
  readonly setHalfLoad: (input: { on: boolean }) => Promise<void>
  readonly setHygienePlus: (input: { on: boolean }) => Promise<void>
  readonly setExtraDry: (input: { on: boolean }) => Promise<void>
  readonly setIntensiveZone: (input: { on: boolean }) => Promise<void>
  readonly setVarioSpeedPlus: (input: { on: boolean }) => Promise<void>
  readonly setChildLock: (input: { on: boolean }) => Promise<void>
}

export interface DishwasherStateMeta {
  readonly label: string
  readonly tone: string
}

/** What the operation state is called to a person, and how it is toned. */
export function dishwasherOperationMeta(
  operationState: DishwasherOperationState | null,
  t: UiTextFn = defaultUiText,
): DishwasherStateMeta {
  switch (operationState) {
    case 'Run':
      return {
        label: t('uiLibrary.dishwasher.op.run', 'Running'),
        tone: 'text-primary',
      }
    case 'Pause':
      return {
        label: t('uiLibrary.dishwasher.op.pause', 'Paused'),
        tone: 'text-warning',
      }
    case 'Finished':
      return {
        label: t('uiLibrary.dishwasher.op.finished', 'Finished'),
        tone: 'text-success',
      }
    case 'Error':
      return {
        label: t('uiLibrary.dishwasher.op.error', 'Error'),
        tone: 'text-danger',
      }
    case 'Aborting':
      return {
        label: t('uiLibrary.dishwasher.op.aborting', 'Stopping'),
        tone: 'text-warning',
      }
    case 'ActionRequired':
      return {
        label: t('uiLibrary.dishwasher.op.actionRequired', 'Action required'),
        tone: 'text-warning',
      }
    case 'DelayedStart':
      return {
        label: t('uiLibrary.dishwasher.op.delayedStart', 'Delayed start'),
        tone: 'text-primary',
      }
    case 'Ready':
      return {
        label: t('uiLibrary.dishwasher.op.ready', 'Ready'),
        tone: 'text-foreground',
      }
    case 'Inactive':
      return {
        label: t('uiLibrary.dishwasher.op.inactive', 'Inactive'),
        tone: 'text-foreground-subtle',
      }
    case null:
      return {
        label: NOT_REPORTED.en,
        tone: 'text-foreground-subtle',
      }
  }
}

/** The headline for the whole slice: the appliance's state, or why there is none. */
export function dishwasherHeadline(
  status: DishwasherStatus,
  t: UiTextFn = defaultUiText,
): DishwasherStateMeta {
  switch (status.availability) {
    case 'offline':
      return {
        label: t('uiLibrary.dishwasher.offline', 'Offline'),
        tone: 'text-foreground-subtle',
      }
    case 'description-missing':
      return {
        label: t('uiLibrary.dishwasher.descriptionMissing', 'Waiting for the appliance profile'),
        tone: 'text-warning',
      }
    case 'available':
      return dishwasherOperationMeta(status.operationState, t)
  }
}

/** Last segment of a feature key, spaced out: `Dishcare.Dishwasher.Program.Eco50` -> `Eco50`. */
export function featureLabel(key: string): string {
  const short = key.split('.').pop() ?? key
  return short.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}
/** Whole seconds as a short duration: `1 h 24 min`, `42 min`, `30 s`. */
export function formatDuration(seconds: number, t: UiTextFn = defaultUiText): string {
  if (seconds < 60) return t('uiLibrary.dishwasher.durationSeconds', '{{n}} s', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60)
    return t('uiLibrary.dishwasher.durationMinutes', '{{n}} min', {
      n: minutes,
    })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? t('uiLibrary.dishwasher.durationHours', '{{n}} h', { n: hours })
    : t('uiLibrary.dishwasher.durationHoursMinutes', '{{h}} h {{m}} min', {
        h: hours,
        m: rest,
      })
}

function useDishwasher(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<DishwasherCap, DishwasherStatus>({
    trpc,
    deviceId,
    cap: (d) => d.dishwasher as DishwasherCap | undefined,
    slice: (d) => d.state.dishwasher,
  })
}

interface IconButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function DishwasherIconButton({
  label,
  busy,
  active,
  onClick,
  children,
}: IconButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
        active && 'bg-primary text-primary-foreground',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

function DishwasherPanel({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDishwasher(trpc, deviceId)

  if (cap === undefined) return null
  if (slice === undefined) return null

  const display = slice
  const link = display.availability === 'available'
  // Nothing is actionable while the appliance is unreachable or undecodable.
  const busy = !available || !link
  const meta = dishwasherHeadline(display, t)
  const running = display.operationState === 'Run'
  const paused = display.operationState === 'Pause'
  const startable = display.remoteStartAllowed === true && display.selectedProgram !== null

  const press = (fn: () => Promise<void>): void => {
    if (busy) return
    void fn()
  }

  return (
    <div className="inline-flex items-center gap-1.5 max-w-full">
      {display.doorOpen === true && (
        <span
          className="inline-flex text-warning shrink-0"
          title={t('uiLibrary.dishwasher.doorOpen', 'Door open')}
          aria-label={t('uiLibrary.dishwasher.doorOpen', 'Door open')}
        >
          <DoorOpen className="h-3.5 w-3.5" />
        </span>
      )}
      <span className={cn('text-xs font-medium tabular-nums shrink-0', meta.tone)}>
        {meta.label}
      </span>
      {display.program != null && (
        <span
          className="text-xs text-foreground-subtle truncate max-w-[7rem]"
          title={display.program}
        >
          {featureLabel(display.program)}
        </span>
      )}
      {display.remaining != null && (
        <span className="inline-flex items-center gap-0.5 text-xs text-foreground-subtle tabular-nums shrink-0">
          <Timer className="h-3 w-3" />
          {formatDuration(display.remaining, t)}
        </span>
      )}
      <DishwasherIconButton
        label={t('uiLibrary.dishwasher.start', 'Start')}
        busy={busy || !startable}
        active={running}
        onClick={() => press(() => cap.start({}))}
      >
        <Play className="h-3 w-3" />
      </DishwasherIconButton>
      <DishwasherIconButton
        label={
          paused
            ? t('uiLibrary.dishwasher.resume', 'Resume')
            : t('uiLibrary.dishwasher.pause', 'Pause')
        }
        busy={busy || !(running || paused)}
        active={paused}
        onClick={() => press(() => (paused ? cap.resume({}) : cap.pause({})))}
      >
        <Pause className="h-3 w-3" />
      </DishwasherIconButton>
    </div>
  )
}

export function DishwasherInlineControl(props: DeviceControlProps): ReactNode {
  return <DishwasherPanel {...props} />
}
