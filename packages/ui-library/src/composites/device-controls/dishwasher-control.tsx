/**
 * Dishwasher controls for a `DeviceType.Dishwasher` device.
 *
 * Reads the `dishwasher` cap status slice and renders inline + hero surfaces
 * mirroring vacuum-control / pet-feeder patterns.
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
import { AlertTriangle, DoorOpen, Pause, Play, Power, Square, Timer, Waves } from 'lucide-react'
import type { DishwasherOperationState, DishwasherStatus } from '@camstack/types'
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
      return { label: t('uiLibrary.dishwasher.op.run', 'Running'), tone: 'text-primary' }
    case 'Pause':
      return { label: t('uiLibrary.dishwasher.op.pause', 'Paused'), tone: 'text-warning' }
    case 'Finished':
      return { label: t('uiLibrary.dishwasher.op.finished', 'Finished'), tone: 'text-success' }
    case 'Error':
      return { label: t('uiLibrary.dishwasher.op.error', 'Error'), tone: 'text-danger' }
    case 'Aborting':
      return { label: t('uiLibrary.dishwasher.op.aborting', 'Stopping'), tone: 'text-warning' }
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
      return { label: t('uiLibrary.dishwasher.op.ready', 'Ready'), tone: 'text-foreground' }
    case 'Inactive':
      return {
        label: t('uiLibrary.dishwasher.op.inactive', 'Inactive'),
        tone: 'text-foreground-subtle',
      }
    case null:
      return { label: t('uiLibrary.dishwasher.unknown', 'Unknown'), tone: 'text-foreground-subtle' }
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

/**
 * Salt and rinse aid are consumable items (D915). Their events must not
 * reappear on the hero — the Consumables section is the only surface.
 */
export function isConsumableDishwasherEvent(event: string): boolean {
  const short = (event.split('.').pop() ?? event).toLowerCase()
  return short.includes('salt') || short.includes('rinse')
}

/** Raised events the hero may name. Consumable events are dropped. */
export function visibleDishwasherEvents(events: readonly string[]): readonly string[] {
  return events.filter((event) => !isConsumableDishwasherEvent(event))
}

/** Whole seconds as a short duration: `1 h 24 min`, `42 min`, `30 s`. */
export function formatDuration(seconds: number, t: UiTextFn = defaultUiText): string {
  if (seconds < 60) return t('uiLibrary.dishwasher.durationSeconds', '{{n}} s', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('uiLibrary.dishwasher.durationMinutes', '{{n}} min', { n: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? t('uiLibrary.dishwasher.durationHours', '{{n}} h', { n: hours })
    : t('uiLibrary.dishwasher.durationHoursMinutes', '{{h}} h {{m}} min', { h: hours, m: rest })
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

function DishwasherGraphic({
  running,
  progressPercent,
}: {
  readonly running: boolean
  readonly progressPercent: number | null
}): ReactNode {
  const pct =
    progressPercent != null ? Math.max(0, Math.min(100, progressPercent)) : running ? 40 : 0
  return (
    <div
      aria-hidden="true"
      className="relative w-28 h-36 rounded border-2 border-border bg-gradient-to-b from-surface-hover to-surface overflow-hidden flex-shrink-0"
    >
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 bg-primary/25 transition-[height] duration-500',
          running && 'animate-pulse',
        )}
        style={{ height: `${pct}%` }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-foreground-subtle">
        <Waves className="h-10 w-10 opacity-70" />
      </div>
    </div>
  )
}

function DishwasherPanel({
  trpc,
  deviceId,
  layout,
}: DeviceControlProps & { readonly layout: 'compact' | 'full' }): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDishwasher(trpc, deviceId)

  if (cap === undefined) return null
  if (slice === undefined) return null

  const display = slice
  const link = display.availability === 'available'
  // Nothing is actionable while the appliance is unreachable or undecodable.
  const busy = !available || !link
  const optionTogglesLocked = display.childLock === true
  const meta = dishwasherHeadline(display, t)
  const running = display.operationState === 'Run'
  const paused = display.operationState === 'Pause'
  const startable = display.remoteStartAllowed === true && display.selectedProgram !== null

  const press = (fn: () => Promise<void>): void => {
    if (busy) return
    void fn()
  }

  if (layout === 'compact') {
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
        {display.remainingSeconds != null && (
          <span className="inline-flex items-center gap-0.5 text-xs text-foreground-subtle tabular-nums shrink-0">
            <Timer className="h-3 w-3" />
            {formatDuration(display.remainingSeconds, t)}
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

  const programs = display.availablePrograms

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-4">
        <DishwasherGraphic running={running} progressPercent={display.progressPercent} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-3xl font-semibold', meta.tone)}>{meta.label}</span>
            {display.powerOn === false && (
              <span className="text-xs font-medium text-foreground-subtle">
                {t('uiLibrary.dishwasher.powerOff', 'Power off')}
              </span>
            )}
          </div>
          {display.program != null && (
            <span className="text-sm text-foreground-subtle" title={display.program}>
              {featureLabel(display.program)}
            </span>
          )}
          {display.remainingSeconds != null && (
            <span className="inline-flex items-center gap-1 text-sm text-foreground-subtle tabular-nums">
              <Timer className="h-3.5 w-3.5" />
              {t('uiLibrary.dishwasher.remaining', '{{time}} left', {
                time: formatDuration(display.remainingSeconds, t),
              })}
            </span>
          )}
          {display.delayedStartSeconds != null && display.delayedStartSeconds > 0 && (
            <span className="text-xs text-foreground-subtle tabular-nums">
              {t('uiLibrary.dishwasher.startsIn', 'Starts in {{time}}', {
                time: formatDuration(display.delayedStartSeconds, t),
              })}
            </span>
          )}
          {display.progressPercent != null && (
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded bg-surface-hover overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, display.progressPercent))}%` }}
                />
              </div>
              <span className="tabular-nums text-xs text-foreground-subtle">
                {Math.round(display.progressPercent)}%
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {display.doorOpen === true && (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <DoorOpen className="h-3.5 w-3.5" />
                {t('uiLibrary.dishwasher.doorOpen', 'Door open')}
              </span>
            )}
            {visibleDishwasherEvents(display.activeEvents).map((event) => (
              <span key={event} className="text-xs text-warning" title={event}>
                {featureLabel(event)}
              </span>
            ))}
          </div>
          {display.operationState === 'Error' && (
            <div className="inline-flex items-center gap-1 text-xs text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>
                {display.errorLabel != null
                  ? featureLabel(display.errorLabel)
                  : display.errorCode != null
                    ? t('uiLibrary.dishwasher.errorCode', 'Error {{code}}', {
                        code: display.errorCode,
                      })
                    : t('uiLibrary.dishwasher.op.error', 'Error')}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <DishwasherIconButton
              label={t('uiLibrary.dishwasher.start', 'Start')}
              busy={busy || !startable}
              active={running}
              onClick={() => press(() => cap.start({}))}
            >
              <Play className="h-4 w-4" />
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
              <Pause className="h-4 w-4" />
            </DishwasherIconButton>
            <DishwasherIconButton
              label={t('uiLibrary.dishwasher.stop', 'Stop')}
              busy={busy || !(running || paused)}
              active={false}
              onClick={() => press(() => cap.stop({}))}
            >
              <Square className="h-3.5 w-3.5" />
            </DishwasherIconButton>
            <DishwasherIconButton
              label={t('uiLibrary.dishwasher.power', 'Power')}
              busy={busy || display.powerOn === null}
              active={display.powerOn === true}
              onClick={() => {
                const next = display.powerOn !== true
                press(() => cap.setPower({ on: next }))
              }}
            >
              <Power className="h-4 w-4" />
            </DishwasherIconButton>
          </div>
        </div>
      </div>

      {programs.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span className="w-16 shrink-0">{t('uiLibrary.dishwasher.program', 'Program')}</span>
          <select
            aria-label={t('uiLibrary.dishwasher.program', 'Program')}
            value={display.selectedProgram ?? ''}
            disabled={busy}
            onChange={(e) => {
              const program = e.target.value
              if (!program) return
              void cap.setProgram({ program })
            }}
            onClick={(e) => {
              e.stopPropagation()
            }}
            className="flex-1 rounded border border-border bg-surface px-2 py-1 text-foreground disabled:opacity-50"
          >
            {display.selectedProgram == null && <option value="">—</option>}
            {programs.map((p) => (
              <option key={p} value={p}>
                {featureLabel(p)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="flex flex-wrap gap-4 text-xs">
        <ToggleRow
          label={t('uiLibrary.dishwasher.halfLoad', 'Half load')}
          checked={display.halfLoad}
          shown={link}
          busy={busy || optionTogglesLocked}
          onChange={(on) => void cap.setHalfLoad({ on })}
        />
        <ToggleRow
          label={t('uiLibrary.dishwasher.hygienePlus', 'Hygiene plus')}
          checked={display.hygienePlus}
          shown={link}
          busy={busy || optionTogglesLocked}
          onChange={(on) => void cap.setHygienePlus({ on })}
        />
        <ToggleRow
          label={t('uiLibrary.dishwasher.extraDry', 'Extra dry')}
          checked={display.extraDry}
          shown={link}
          busy={busy || optionTogglesLocked}
          onChange={(on) => void cap.setExtraDry({ on })}
        />
        <ToggleRow
          label={t('uiLibrary.dishwasher.intensiveZone', 'Intensive zone')}
          checked={display.intensiveZone}
          shown={link}
          busy={busy || optionTogglesLocked}
          onChange={(on) => void cap.setIntensiveZone({ on })}
        />
        <ToggleRow
          label={t('uiLibrary.dishwasher.varioSpeedPlus', 'VarioSpeed+')}
          checked={display.varioSpeedPlus}
          shown={link}
          busy={busy || optionTogglesLocked}
          onChange={(on) => void cap.setVarioSpeedPlus({ on })}
        />
        <ToggleRow
          label={t('uiLibrary.dishwasher.childLock', 'Child lock')}
          checked={display.childLock}
          shown={link}
          busy={busy}
          onChange={(on) => void cap.setChildLock({ on })}
        />
      </div>
    </div>
  )
}

/**
 * One boolean setting. `checked === null` is "the appliance has not said": on a reachable
 * appliance that means it does not offer the setting (hidden); on an unreachable one the
 * setting is shown but disabled and marked unknown — never as an unchecked box.
 */
function ToggleRow({
  label,
  checked,
  shown,
  busy,
  onChange,
}: {
  readonly label: string
  readonly checked: boolean | null
  /** True while the link is up and the appliance is decodable. */
  readonly shown: boolean
  readonly busy: boolean
  readonly onChange: (on: boolean) => void
}): ReactNode {
  const t = useUiText()
  if (checked === null && shown) return null
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked === true}
        aria-checked={checked === null ? 'mixed' : checked}
        disabled={busy || checked === null}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
        onClick={(e) => {
          e.stopPropagation()
        }}
        className="rounded border-border"
      />
      <span>{label}</span>
      {checked === null && (
        <span className="text-foreground-subtle">
          {t('uiLibrary.dishwasher.unknownValue', '—')}
        </span>
      )}
    </label>
  )
}

export function DishwasherInlineControl(props: DeviceControlProps): ReactNode {
  return <DishwasherPanel {...props} layout="compact" />
}

export function DishwasherHeroCard(props: DeviceControlProps): ReactNode {
  return <DishwasherPanel {...props} layout="full" />
}
