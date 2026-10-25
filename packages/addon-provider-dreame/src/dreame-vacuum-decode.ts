import { MiotError, MiotState, SuctionLevel } from '@apocaliss92/nodedreame'
import type { ConsumableReading, MiotProp, VacuumCapabilities } from '@apocaliss92/nodedreame'
import type {
  ConsumableForm,
  ConsumableItem,
  ConsumableKind,
  VacuumControlStatus,
  VacuumState,
} from '@camstack/types'

/**
 * Pure decode helpers for the Dreame vacuum. Translate the library's MIoT enum
 * values into the camstack `vacuum-control` slice shape. Unit-tested in
 * isolation (no facade, no network) — mirrors `homematic-decode.ts`.
 */

/**
 * Map a Dreame {@link MiotState} (siid 2 piid 1) onto the camstack canonical
 * `VacuumState` lifecycle (`idle` / `cleaning` / `paused` / `returning` /
 * `docked` / `error`). A `null` state (not yet observed) settles on `idle`.
 *
 * The MIoT state space is large (~50 values); we collapse it onto the six
 * canonical states by family. Anything unrecognised falls through to `idle`
 * (the safe neutral) so a firmware-added code never throws.
 */
export function mapMiotStateToVacuumState(state: MiotState | null): VacuumState {
  if (state === null) return 'idle'
  switch (state) {
    // ── Docked / on the charger ──────────────────────────────────────────
    case MiotState.Charging:
    case MiotState.ChargingComplete:
    case MiotState.IntelligentCharging:
    // Dock-side maintenance: the robot is PARKED on the dock running a station
    // routine (self-wash, auto-empty, draining, sanitizing). HA reports the
    // vacuum as `docked` for these — without them they fell through to the
    // `cleaning` default, showing "Cleaning" while parked.
    case MiotState.CleanWashboardBase:
    case MiotState.AutoRepairBase:
    case MiotState.WaterSupplyDrainTest:
    case MiotState.CleanMopRefillWater:
    case MiotState.AutoEmptying:
    case MiotState.Emptying:
    case MiotState.Draining:
    case MiotState.AutoWaterDraining:
    case MiotState.Sanitizing:
      return 'docked'
    // ── Drying (mop / dust-bag drying on the dock) ───────────────────────
    case MiotState.MopDrying:
    case MiotState.DustBagDrying:
    case MiotState.SanitizingWithDry:
      return 'drying'
    // ── Returning to base / dock ─────────────────────────────────────────
    case MiotState.ReturningToCharge:
    case MiotState.ReturningToWash:
    case MiotState.ReturnInstallMop:
    case MiotState.ReturnRemoveMop:
    case MiotState.ReturnToEmpty:
    case MiotState.ReturningToDrain:
      return 'returning'
    // ── Paused (any flavour) ─────────────────────────────────────────────
    case MiotState.Paused:
    case MiotState.PausedAlt:
    case MiotState.PausedCleaning:
    case MiotState.DustBagDryingPaused:
    case MiotState.CameraMonitoringPaused:
    case MiotState.FindingPetPaused:
    case MiotState.InitialDeepCleanPaused:
    case MiotState.ChangingMopPaused:
    case MiotState.FloorMaintainingPaused:
      return 'paused'
    // ── Standby / idle ───────────────────────────────────────────────────
    case MiotState.Standby:
    case MiotState.WaitingForTask:
      return 'idle'
    // ── Everything active (cleaning / mopping / mapping / …) ──────────────
    default:
      return 'cleaning'
  }
}

/**
 * The camstack `fanSpeed` token for a Dreame {@link SuctionLevel} — the enum
 * member NAME, lower-cased (`Quiet` → `'quiet'`). Returns `null` for an
 * unobserved / unknown level.
 */
export function suctionLevelToken(level: SuctionLevel | null): string | null {
  if (level === null) return null
  const name = SuctionLevel[level]
  return typeof name === 'string' ? name.toLowerCase() : null
}

/**
 * Resolve a camstack `fanSpeed` token back to the Dreame {@link SuctionLevel}
 * enum value, validated against the model's `supported` levels. Returns null
 * when the token doesn't match a supported level (the caller rejects the set).
 */
export function tokenToSuctionLevel(
  token: string,
  supported: readonly SuctionLevel[],
): SuctionLevel | null {
  const wanted = token.trim().toLowerCase()
  for (const level of supported) {
    if (suctionLevelToken(level) === wanted) return level
  }
  return null
}

/** The list of accepted `fanSpeed` tokens for a model's supported suction set. */
export function supportedFanSpeedTokens(supported: readonly SuctionLevel[]): string[] {
  const tokens: string[] = []
  for (const level of supported) {
    const token = suctionLevelToken(level)
    if (token !== null) tokens.push(token)
  }
  return tokens
}

/**
 * Clamp a raw battery reading (already a 0..100 percentage from the library)
 * to the `vacuum-control` slice's `batteryLevel` field. Returns null for a
 * null/NaN/out-of-band reading so the slice stays valid (the schema rejects
 * a number outside 0..100).
 */
export function clampBatteryLevel(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/** Clamp a 0..100 percentage (progress, coverage, …), null-safe. */
export function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/**
 * Raw MIoT enum ints for the six tank-status properties, read from the live
 * vacuum handle via `getProperty(siid, piid).value`. Each is `null` when the
 * device does not report that property. Used to populate the discrete tank
 * `status` (the library still exposes no numeric FILL level).
 */
export interface VacuumTankProps {
  /** clean-water-tank-status (27/1): 0 INSTALLED · 1 NOT_INSTALLED · 2 LOW_WATER · 3 CHECKING. */
  cleanWaterTankStatus: number | null
  /** water-tank (4/6): 0 NOT_INSTALLED · 1 INSTALLED · 10 MOP_INSTALLED · 99 MOP_IN_STATION. */
  waterTank: number | null
  /** detergent-status (27/4): 0 INSTALLED · 1 DISABLED · 2 LOW_DETERGENT. */
  detergentStatus: number | null
  /** dust-collection (15/3): 0 NOT_AVAILABLE · 1 AVAILABLE · 2 OVER_USE · 3 NEVER. */
  dustCollection: number | null
  /** dirty-water-tank-status (27/2 — unmeasured, see VACUUM_TANK_PROPS): 0 INSTALLED · 1 NOT_INSTALLED_OR_FULL. */
  dirtyWaterTankStatus: number | null
  /** dust-bag-status (27/3 — unmeasured, see VACUUM_TANK_PROPS): 0 INSTALLED · 1 NOT_INSTALLED · 2 CHECK. */
  dustBagStatus: number | null
}

/**
 * Where each {@link VacuumTankProps} field lives (siid/piid). Property ids and
 * enum values are the HA Dreame integration's (Tasshack `dreame-vacuum`
 * `types.py`, `DreameVacuumProperty` → siid/piid map; same on `dev` and
 * v2.0.0b25, checked 2026-09-26). 27/1 and 27/4 were already read here; 27/2 and
 * 27/3 are their neighbours on the same station service. The robot pushes them
 * on change; the consumables refresh also re-reads them from the shadow.
 */
export const VACUUM_TANK_PROPS = {
  cleanWaterTankStatus: { siid: 27, piid: 1 },
  waterTank: { siid: 4, piid: 6 },
  detergentStatus: { siid: 27, piid: 4 },
  dustCollection: { siid: 15, piid: 3 },
  // UNMEASURED: HA integration map only (Tasshack types.py), not observed on any
  // fleet robot. Ids AND enum meanings are the integration's; confirm on a live
  // read before trusting either.
  dirtyWaterTankStatus: { siid: 27, piid: 2 },
  dustBagStatus: { siid: 27, piid: 3 },
} as const satisfies Record<keyof VacuumTankProps, MiotProp>

/**
 * One tank as the robot reports it: a numeric fill (never, today — see
 * {@link decodeVacuumTanks}) and a discrete status. Both `null` = the tank
 * exists but its state is unknown.
 */
export interface VacuumTank {
  readonly level: number | null
  readonly status: 'ok' | 'low' | 'full' | null
}

/** The four tanks; `null` = the hardware has no such tank. */
export interface VacuumTanks {
  readonly cleanWater: VacuumTank | null
  readonly dirtyWater: VacuumTank | null
  readonly detergent: VacuumTank | null
  readonly dustBin: VacuumTank | null
}

type TankStatusFlag = VacuumTank['status']

/**
 * Clean-water tank `status`: prefer the richer clean-water-tank-status (27/1),
 * fall back to the coarser water-tank presence (4/6). `null` when neither maps
 * to a known good/low reading (NOT_INSTALLED / CHECKING / unknown). Pure.
 */
function cleanWaterTankStatus(props: VacuumTankProps): TankStatusFlag {
  if (props.cleanWaterTankStatus !== null) {
    if (props.cleanWaterTankStatus === 0) return 'ok' // INSTALLED
    if (props.cleanWaterTankStatus === 2) return 'low' // LOW_WATER
    return null // NOT_INSTALLED / CHECKING
  }
  if (props.waterTank === 1 || props.waterTank === 10) return 'ok' // INSTALLED / MOP_INSTALLED
  return null
}

/** Detergent tank `status` from detergent-status (27/4). Pure. */
function detergentTankStatus(value: number | null): TankStatusFlag {
  if (value === 0) return 'ok' // INSTALLED
  if (value === 2) return 'low' // LOW_DETERGENT
  return null // DISABLED / unknown
}

/**
 * Dust-bin `status` from dust-collection (15/3); OVER_USE reads as `full`. A dust
 * bag that is missing or asks to be checked (27/3 NOT_INSTALLED / CHECK) is never
 * `ok` — the enum does not say "full" either, so it is unknown. Pure.
 */
function dustBinTankStatus(dustCollection: number | null, dustBag: number | null): TankStatusFlag {
  if (dustCollection === 2) return 'full' // OVER_USE
  if (dustBag !== null && dustBag !== 0) return null // NOT_INSTALLED / CHECK / unknown
  if (dustCollection === 1) return 'ok' // AVAILABLE
  return null // NOT_AVAILABLE / NEVER / unknown
}

/**
 * Dirty-water tank `status` from dirty-water-tank-status (27/2). The robot has
 * ONE value for "not installed or full" and cannot tell them apart; lifting the
 * tank out to EMPTY it reads exactly like a full one, so that value is unknown
 * (`null`) — never `full`, which would raise a false "tank full" at the moment
 * someone is fixing it (controller ruling 2026-09-26). Absent or any other
 * value is unknown too, never `ok`.
 *
 * The unambiguous "full" is the robot's own error `MiotError.DirtyWaterTankFull`
 * (86, the library's `errorCode`, siid 2 piid 2): while it is raised the tank is
 * `full` whatever 27/2 says; once it clears, 27/2 decides again. Pure.
 */
function dirtyWaterTankStatus(value: number | null, errorCode: number | null): TankStatusFlag {
  if (errorCode === MiotError.DirtyWaterTankFull) return 'full'
  if (value === 0) return 'ok' // INSTALLED
  return null // 1 NOT_INSTALLED_OR_FULL / unknown
}

/**
 * The four tanks (clean-water / dirty-water / detergent / dust-bin) decoded from the model's {@link VacuumCapabilities}, with the
 * discrete `status` populated from the live MIoT enum props when supplied. Pure.
 *
 * The nodedreame library exposes NO tank FILL-LEVEL telemetry — the cloud shadow
 * (verified against a real `dreame.vacuum.r2538z`) carries only the water-VOLUME
 * *setting* (a mop-flow level, NOT a tank fill). We therefore never fabricate a
 * `level`; `level` is always `null`. The cap contract is honoured on PRESENCE,
 * with `status` derived from the tank-status enums:
 *
 *   - a field is `null` when the hardware HAS NO such tank (capability flags), and
 *   - `{ level: null, status }` when the tank EXISTS — `status` from the enum
 *     prop ('ok' / 'low' / 'full'), or `null` when the device reports none.
 *
 * Presence is derived from the capability record:
 *   - clean-water  ← `canMop` (a mopping robot carries a clean-water reservoir)
 *   - dirty-water  ← `canMopWash` (a self-wash dock has a recovery/dirty tank)
 *   - detergent    ← `hasDetergentReservoir`
 *   - dust-bin     ← `canAutoEmpty` (an auto-empty robot has an onboard dust bin)
 */
export function decodeVacuumTanks(
  caps: VacuumCapabilities | null,
  props?: VacuumTankProps,
  errorCode: number | null = null,
): VacuumTanks {
  const tank = (present: boolean, status: TankStatusFlag): VacuumTank | null =>
    present ? { level: null, status } : null
  return {
    cleanWater: tank(Boolean(caps?.canMop), props ? cleanWaterTankStatus(props) : null),
    dirtyWater: tank(
      Boolean(caps?.canMopWash),
      dirtyWaterTankStatus(props?.dirtyWaterTankStatus ?? null, errorCode),
    ),
    detergent: tank(
      Boolean(caps?.hasDetergentReservoir),
      props ? detergentTankStatus(props.detergentStatus) : null,
    ),
    dustBin: tank(
      Boolean(caps?.canAutoEmpty),
      props ? dustBinTankStatus(props.dustCollection, props.dustBagStatus) : null,
    ),
  }
}

/** How each tank is named and what it is, in the order the panel lists them. */
const TANK_ITEMS: ReadonlyArray<{
  readonly key: keyof VacuumTanks
  readonly label: string
  readonly kind: ConsumableKind
  readonly form: ConsumableForm
}> = [
  { key: 'cleanWater', label: 'Clean water tank', kind: 'supply', form: 'tank' },
  { key: 'dirtyWater', label: 'Dirty water tank', kind: 'waste', form: 'tank' },
  { key: 'detergent', label: 'Detergent', kind: 'supply', form: 'product' },
  { key: 'dustBin', label: 'Dust bin', kind: 'waste', form: 'bin' },
]

/**
 * The tanks as `consumables` items (D915): every PRESENT tank becomes a
 * `supply` (clean water, detergent) or `waste` (dirty water, dust bin) item
 * keyed by its old field name, drawn as a `tank` (the two water tanks), a
 * `product` (detergent) or a `bin` (the dust bin) — the key the notification centre's tank
 * episodes were built on, so an open episode carries on. A tank is never
 * resettable: emptying or refilling it is the reset. Pure.
 */
export function vacuumTankItems(tanks: VacuumTanks): ConsumableItem[] {
  return TANK_ITEMS.flatMap(({ key, label, kind, form }) => {
    const tank = tanks[key]
    if (tank === null) return []
    return [
      {
        key,
        label,
        level: tank.level,
        status: tank.status,
        kind,
        form,
        lastResetAt: null,
        resettable: false,
      },
    ]
  })
}

/**
 * Clamp a raw consumable percentage to `[0, 100]`, or return `null` when the
 * value is absent / non-finite. The library reports remaining life as a 0..100
 * integer; we clamp defensively so an out-of-range firmware value never violates
 * the cap schema.
 */
export function clampConsumablePct(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

/**
 * The `consumables` cap items for the consumables a vacuum REPORTS.
 *
 * PRESENCE-driven (mirrors HA): the library's `supportedConsumables` enumerates
 * ONLY the consumables this model reports (a present MIoT life property), each
 * with its remaining-life % and whether a reset action exists. No hardcoded
 * per-model list: a consumable the device does not expose never appears.
 *
 * `status` is `null` — the provider reports the level, the notification rule
 * decides what is low. The slice clocks are `nextConsumablesSlice`'s job. Pure.
 */
export function buildVacuumConsumableItems(
  readings: readonly ConsumableReading[],
): ConsumableItem[] {
  return readings.map((c) => ({
    key: c.key,
    label: c.label,
    level: clampConsumablePct(c.leftPct),
    status: null,
    lastResetAt: null,
    resettable: c.resettable,
    // A brush, a filter, a mop pad: a part that wears.
    form: 'part' as const,
  }))
}

/** Structural equality of two JSON-shaped values, key order ignored. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonEqual(v, b[i]))
    )
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => jsonEqual(Reflect.get(a, k), Reflect.get(b, k)))
}

/**
 * The `vacuum-control` slice to write, or `null` when only the clock moved.
 * `recomputeSlice` runs on EVERY push; without this each one was a write (and a
 * `device.state-changed`) even when nothing the robot reported had changed. Pure.
 */
export function nextVacuumControlSlice(
  prev: VacuumControlStatus | undefined,
  next: VacuumControlStatus,
): VacuumControlStatus | null {
  if (prev === undefined) return next
  const { lastChangedAt: _prevAt, ...prevContent } = prev
  const { lastChangedAt: _nextAt, ...nextContent } = next
  return jsonEqual(prevContent, nextContent) ? null : next
}
