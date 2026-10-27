/**
 * Pet-feeder controls for a `DeviceType.PetFeeder` device.
 *
 * Reads the `pet-feeder` cap status slice (bowlFood / foodLevel / food1 / food2 /
 * lowFood / batteryPower / eating / feeding / status / error /
 * errorCode / isDualHopper + the four persisted settings) and renders:
 *   - PetFeederInlineControl (device-list row): a compact food-level +
 *     battery readout with a one-tap Feed button (default portion).
 *   - PetFeederHeroCard (device-detail hero): the food-bowl fill gauge
 *     signature, battery readout, a manual-feed portion
 *     stepper honouring the 4-200 g hardware range (per-hopper on
 *     dual-hopper models), a maintenance action row (Call pet /
 *     Mark refilled) and the child-lock / indicator-light /
 *     feed-sound / volume settings. The desiccant is a consumable: the
 *     page's Consumables section draws it, never this card (D915).
 *
 * Mirrors the AC card's `useDeviceCapability` + inferred-cap pattern so
 * the row and hero never diverge. Actions are gated on `available`.
 */
import { useUiText } from '../../contexts/ui-text'
import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  BatteryMedium,
  BatteryWarning,
  Ban,
  Bell,
  CheckCircle2,
  Lightbulb,
  Lock,
  PawPrint,
  UtensilsCrossed,
  Volume2,
  WifiOff,
} from 'lucide-react'
import type { PetFeederStatus } from '@camstack/types'
import { PET_FEEDER_MANUAL_FEED_MAX, PET_FEEDER_MANUAL_FEED_MIN } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability.js'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice.js'
import { cn } from '../../lib/cn.js'
import type { ControlPanelProps } from './types.js'

/** Default one-tap manual-feed portion (grams) — the low end of the
 *  hardware range, a safe snack-sized dispense. */
const DEFAULT_PORTION = 20
const VOLUME_MAX = 9

/** Amber kibble accent for the bowl fill; destructive red when low. */
const KIBBLE = '#f59e0b'
const KIBBLE_LOW = '#ef4444'

function clampPortion(grams: number): number {
  return Math.min(PET_FEEDER_MANUAL_FEED_MAX, Math.max(PET_FEEDER_MANUAL_FEED_MIN, grams))
}

// Scoped keyframes — transform/opacity only (compositor-cheap).
const KEYFRAMES = `
@keyframes pf-eat { 0%,100%{transform:translateY(0)} 50%{transform:translateY(2px)} }
@keyframes pf-pulse { 0%,100%{opacity:.55} 50%{opacity:1} }
@media (prefers-reduced-motion: reduce) {
  .pf-eat, .pf-pulse { animation: none !important; }
}
`

export function PetFeederPanel({
  trpc,
  deviceId,
  layout,
  optimistic,
}: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.petFeeder,
    slice: (d) => d.state.petFeeder,
  })

  const { display, applyOptimistic } = useOptimisticSlice<PetFeederStatus>(slice, {
    enabled: optimistic ?? true,
  })

  const [portion, setPortion] = useState(DEFAULT_PORTION)
  const [hopper1, setHopper1] = useState(DEFAULT_PORTION)
  const [hopper2, setHopper2] = useState(DEFAULT_PORTION)

  if (cap === undefined) return null
  if (display === undefined) return null

  const busy = !available

  // A non-null, non-sentinel `error` is an active device fault; `offline`
  // status is a connectivity fault. Both surface as warnings.
  const faultMsg = display.error && display.error !== 'no_error' ? display.error : null
  const offline = display.status === 'offline'
  const onBatteries = display.status === 'on_batteries'

  // ── Compact layout (device-row inline) ──────────────────────────────────────
  if (layout === 'compact') {
    return (
      <div className="inline-flex items-center gap-2">
        {(faultMsg !== null || offline) && (
          <span
            className="inline-flex items-center text-destructive"
            title={faultMsg ?? t('uiLibrary.petFeeder.offline', 'Offline')}
            aria-label={faultMsg ?? t('uiLibrary.petFeeder.offline', 'Offline')}
          >
            {offline ? (
              <WifiOff className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            )}
          </span>
        )}
        <span
          className={cn(
            'inline-flex items-center gap-1 text-xs tabular-nums font-medium',
            display.lowFood ? 'text-destructive' : 'text-foreground',
          )}
        >
          <UtensilsCrossed className="h-3.5 w-3.5" aria-hidden />
          {display.bowlFood ?? '—'}
        </span>
        {display.batteryPower !== null && (
          <span className="inline-flex items-center gap-0.5 text-xs tabular-nums text-foreground-subtle">
            <BatteryMedium className="h-3.5 w-3.5" aria-hidden />
            {display.batteryPower}%
          </span>
        )}
        <button
          type="button"
          aria-label={t('uiLibrary.petFeeder.feedNow', 'Feed now')}
          disabled={busy || display.feeding}
          onClick={(e) => {
            e.stopPropagation()
            if (busy || display.feeding) return
            applyOptimistic({ feeding: true })
            void cap.feed({ grams: DEFAULT_PORTION })
          }}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover',
            (busy || display.feeding) && 'opacity-40 cursor-not-allowed',
          )}
        >
          <PawPrint className="h-3.5 w-3.5" aria-hidden />
          {t('uiLibrary.petFeeder.feed', 'Feed')}
        </button>
      </div>
    )
  }

  // ── Full layout (hero card) ──────────────────────────────────────────────────
  const feedSingle = (grams: number): void => {
    if (busy || display.feeding) return
    applyOptimistic({ feeding: true })
    void cap.feed({ grams: clampPortion(grams) })
  }

  return (
    <div className="relative flex flex-col items-stretch gap-3 overflow-hidden rounded-lg border border-border bg-surface p-4">
      <style>{KEYFRAMES}</style>

      {/* ── Hero: food-bowl fill gauge + battery / feeding ─────── */}
      <div className="flex items-center gap-4 rounded-lg border border-border/50 bg-surface-subtle/40 p-3">
        <BowlGauge grams={display.bowlFood} low={display.lowFood} eating={display.eating} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-1">
            <span
              className="text-3xl font-bold leading-none tabular-nums"
              style={{ color: display.lowFood ? KIBBLE_LOW : KIBBLE }}
            >
              {display.bowlFood ?? '—'}
            </span>
            <span className="text-sm text-foreground-subtle">
              {t('uiLibrary.petFeeder.inBowl', 'in bowl')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-subtle">
            {display.batteryPower !== null && (
              <Readout
                icon={<BatteryMedium className="h-3.5 w-3.5" />}
                label={`${display.batteryPower}%`}
              />
            )}
            {onBatteries && (
              <span className="inline-flex items-center gap-1 font-medium text-amber-500">
                <BatteryWarning className="h-3.5 w-3.5" aria-hidden />
                {t('uiLibrary.petFeeder.onBattery', 'On battery')}
              </span>
            )}
            {offline ? (
              <span className="inline-flex items-center gap-1 font-medium text-destructive">
                <WifiOff className="h-3.5 w-3.5" aria-hidden />
                {t('uiLibrary.petFeeder.offline', 'Offline')}
              </span>
            ) : display.feeding ? (
              <span
                className="pf-pulse inline-flex items-center gap-1 font-medium text-amber-500"
                style={{ animation: 'pf-pulse 1.2s ease-in-out infinite' }}
              >
                <PawPrint className="h-3.5 w-3.5" aria-hidden />
                {t('uiLibrary.petFeeder.feeding', 'Feeding…')}
              </span>
            ) : display.lowFood ? (
              <span className="inline-flex items-center gap-1 font-medium text-destructive">
                <Ban className="h-3.5 w-3.5" aria-hidden />
                {t('uiLibrary.petFeeder.lowFood', 'Low food')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-medium text-success">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                {t('uiLibrary.petFeeder.ready', 'Ready')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Device fault banner ───────────────────────────────────────────── */}
      {faultMsg !== null && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{faultMsg}</span>
        </div>
      )}

      {/* ── Manual feed (single or per-hopper) ────────────────────────────── */}
      {display.isDualHopper ? (
        <div className="grid grid-cols-2 gap-2">
          <HopperFeed
            label={t('uiLibrary.petFeeder.hopper1', 'Hopper 1')}
            grams={hopper1}
            busy={busy || display.feeding}
            onGrams={setHopper1}
            onFeed={() => {
              if (busy || display.feeding) return
              applyOptimistic({ feeding: true })
              void cap.feed({ hopper1: clampPortion(hopper1) })
            }}
          />
          <HopperFeed
            label={t('uiLibrary.petFeeder.hopper2', 'Hopper 2')}
            grams={hopper2}
            busy={busy || display.feeding}
            onGrams={setHopper2}
            onFeed={() => {
              if (busy || display.feeding) return
              applyOptimistic({ feeding: true })
              void cap.feed({ hopper2: clampPortion(hopper2) })
            }}
          />
        </div>
      ) : (
        <HopperFeed
          label={t('uiLibrary.petFeeder.manualFeed', 'Manual feed')}
          grams={portion}
          busy={busy || display.feeding}
          onGrams={setPortion}
          onFeed={() => feedSingle(portion)}
        />
      )}

      {/* ── Maintenance actions ───────────────────────────────────────────── */}
      <div className="grid auto-cols-fr grid-flow-col gap-2">
        <ActionButton
          icon={<PawPrint className="h-4 w-4" />}
          label={t('uiLibrary.petFeeder.callPet', 'Call pet')}
          busy={busy}
          onClick={() => void cap.callPet({})}
        />
        {display.supportsMarkRefilled && (
          <ActionButton
            icon={<UtensilsCrossed className="h-4 w-4" />}
            label={t('uiLibrary.petFeeder.markRefilled', 'Mark refilled')}
            busy={busy}
            onClick={() => void cap.markFoodReplenished({})}
          />
        )}
      </div>
      {display.feeding && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            applyOptimistic({ feeding: false })
            void cap.cancelFeed({})
          }}
          className={cn(
            'flex items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          <Ban className="h-4 w-4" aria-hidden />
          {t('uiLibrary.petFeeder.cancelFeed', 'Cancel feed')}
        </button>
      )}

      {/* ── Settings ──────────────────────────────────────────────────────── */}
      <Field label={t('uiLibrary.petFeeder.settings', 'Settings')}>
        <div className="grid grid-cols-3 gap-2">
          <SettingToggle
            icon={<Lock className="h-4 w-4" />}
            label={t('uiLibrary.petFeeder.childLock', 'Child lock')}
            on={display.childLock}
            busy={busy}
            onToggle={(next) => {
              applyOptimistic({ childLock: next })
              void cap.setChildLock({ on: next })
            }}
          />
          <SettingToggle
            icon={<Lightbulb className="h-4 w-4" />}
            label={t('uiLibrary.petFeeder.light', 'Light')}
            on={display.indicatorLight}
            busy={busy}
            onToggle={(next) => {
              applyOptimistic({ indicatorLight: next })
              void cap.setIndicatorLight({ on: next })
            }}
          />
          <SettingToggle
            icon={<Bell className="h-4 w-4" />}
            label={t('uiLibrary.petFeeder.feedSound', 'Feed sound')}
            on={display.feedSound}
            busy={busy}
            onToggle={(next) => {
              applyOptimistic({ feedSound: next })
              void cap.setFeedSound({ on: next })
            }}
          />
        </div>
      </Field>

      <Field label={t('uiLibrary.petFeeder.volume', 'Volume')}>
        <div className="flex items-center gap-3">
          <Volume2 className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden />
          <RoundStep
            label={t('uiLibrary.petFeeder.decreaseVolume', 'Decrease volume')}
            symbol="−"
            disabled={busy || display.volume <= 0}
            onClick={() => {
              const next = Math.max(0, display.volume - 1)
              applyOptimistic({ volume: next })
              void cap.setVolume({ level: next })
            }}
          />
          <span className="w-6 text-center text-lg font-semibold tabular-nums text-foreground">
            {display.volume}
          </span>
          <RoundStep
            label={t('uiLibrary.petFeeder.increaseVolume', 'Increase volume')}
            symbol="+"
            disabled={busy || display.volume >= VOLUME_MAX}
            onClick={() => {
              const next = Math.min(VOLUME_MAX, display.volume + 1)
              applyOptimistic({ volume: next })
              void cap.setVolume({ level: next })
            }}
          />
        </div>
      </Field>
    </div>
  )
}

// ── Building blocks ───────────────────────────────────────────────────────────

/** Labelled control group — a small uppercase header above its control. */
function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
        {label}
      </span>
      {children}
    </div>
  )
}

function Readout({ icon, label }: { readonly icon: ReactNode; readonly label: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <span className="text-foreground-subtle">{icon}</span>
      {label}
    </span>
  )
}

/**
 * Signature element — a food bowl whose kibble fills proportionally to the
 * bowl reading (`bowlFood`). Amber when stocked, red when the low-food flag is
 * set; the kibble mound bobs while the pet is eating.
 */
function BowlGauge({
  grams,
  low,
  eating,
}: {
  readonly grams: number | null
  readonly low: boolean
  readonly eating: boolean
}): ReactNode {
  const t = useUiText()
  const frac = Math.min(1, Math.max(0, (grams ?? 0) / PET_FEEDER_MANUAL_FEED_MAX))
  const fill = low ? KIBBLE_LOW : KIBBLE
  // Bowl interior spans y=26..52; kibble surface rises as frac grows.
  const surfaceY = 52 - frac * 24
  return (
    <svg
      width={72}
      height={72}
      viewBox="0 0 72 72"
      role="img"
      aria-label={
        grams === null
          ? t('uiLibrary.petFeeder.levelUnknown', 'Food level unknown')
          : t('uiLibrary.petFeeder.gramsInBowl', '{{grams}} in bowl', { grams })
      }
      className="shrink-0"
    >
      <defs>
        <clipPath id="pf-bowl-clip">
          <path d="M14 26 H58 L52 54 A6 6 0 0 1 46 58 H26 A6 6 0 0 1 20 54 Z" />
        </clipPath>
      </defs>
      {/* Kibble fill (clipped to the bowl interior) */}
      <g
        clipPath="url(#pf-bowl-clip)"
        className={eating ? 'pf-eat' : undefined}
        style={eating ? { animation: 'pf-eat 1.1s ease-in-out infinite' } : undefined}
      >
        <rect x="14" y={surfaceY} width="44" height="34" fill={fill} opacity={0.9} />
        {/* Kibble mound crown */}
        <ellipse cx="36" cy={surfaceY} rx="22" ry="4" fill={fill} />
      </g>
      {/* Bowl outline */}
      <path
        d="M14 26 H58 L52 54 A6 6 0 0 1 46 58 H26 A6 6 0 0 1 20 54 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-border"
      />
      {/* Rim */}
      <rect
        x="11"
        y="22"
        width="50"
        height="6"
        rx="3"
        fill="currentColor"
        className="text-border"
      />
    </svg>
  )
}

interface HopperFeedProps {
  readonly label: string
  readonly grams: number
  readonly busy: boolean
  readonly onGrams: (grams: number) => void
  readonly onFeed: () => void
}

/** Manual-feed portion stepper + Feed button, honouring the 4-200 g range. */
function HopperFeed({ label, grams, busy, onGrams, onFeed }: HopperFeedProps): ReactNode {
  const t = useUiText()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-surface-subtle px-1 py-1">
          <RoundStep
            label={t('uiLibrary.petFeeder.decreasePortion', 'Decrease {{label}} portion', {
              label,
            })}
            symbol="−"
            disabled={busy || grams <= PET_FEEDER_MANUAL_FEED_MIN}
            onClick={() => onGrams(clampPortion(grams - 1))}
          />
          <span className="w-12 text-center text-sm font-semibold tabular-nums text-foreground">
            {grams}
            <span className="text-xs text-foreground-subtle">g</span>
          </span>
          <RoundStep
            label={t('uiLibrary.petFeeder.increasePortion', 'Increase {{label}} portion', {
              label,
            })}
            symbol="+"
            disabled={busy || grams >= PET_FEEDER_MANUAL_FEED_MAX}
            onClick={() => onGrams(clampPortion(grams + 1))}
          />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onFeed}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-amber-400 px-2 py-2 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-300 active:scale-95',
            busy && 'opacity-40 cursor-not-allowed',
          )}
        >
          <PawPrint className="h-4 w-4" aria-hidden />
          {t('uiLibrary.petFeeder.feed', 'Feed')}
        </button>
      </div>
    </div>
  )
}

/** Circular ± button. */
function RoundStep({
  label,
  symbol,
  disabled,
  onClick,
}: {
  readonly label: string
  readonly symbol: string
  readonly disabled: boolean
  readonly onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-base leading-none text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground active:scale-95',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      {symbol}
    </button>
  )
}

/** Neutral maintenance action button (icon over label). */
function ActionButton({
  icon,
  label,
  busy,
  onClick,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly busy: boolean
  readonly onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-lg border border-border/60 bg-surface-subtle px-1 py-2 text-[11px] font-medium text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

interface SettingToggleProps {
  readonly icon: ReactNode
  readonly label: string
  readonly on: boolean
  readonly busy: boolean
  readonly onToggle: (next: boolean) => void
}

/** Setting toggle card — reflects the persisted setting; tap to flip. */
function SettingToggle({ icon, label, on, busy, onToggle }: SettingToggleProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={busy}
      onClick={() => {
        if (!busy) onToggle(!on)
      }}
      className={cn(
        'flex flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-[11px] font-medium transition-colors',
        on
          ? 'border-transparent bg-indigo-400 text-indigo-950 shadow-sm'
          : 'border-border/60 bg-surface-subtle text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

// ── Registry wrappers ─────────────────────────────────────────────────────────

interface DeviceControlProps {
  readonly trpc: ControlPanelProps['trpc']
  readonly deviceId: number
  readonly features: readonly string[] | undefined
  readonly optimistic?: boolean
}

export function PetFeederInlineControl({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  return (
    <PetFeederPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="compact"
      optimistic={optimistic}
    />
  )
}

export function PetFeederHeroCard({
  trpc,
  deviceId,
  features,
  optimistic,
}: DeviceControlProps): ReactNode {
  return (
    <PetFeederPanel
      trpc={trpc}
      deviceId={deviceId}
      features={features}
      layout="full"
      optimistic={optimistic}
    />
  )
}
