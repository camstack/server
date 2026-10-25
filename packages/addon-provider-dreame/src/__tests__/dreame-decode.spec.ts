import type { ConsumableReading, VacuumCapabilities } from '@apocaliss92/nodedreame'
import { MiotError, MiotState, MowerStatus, SuctionLevel } from '@apocaliss92/nodedreame'
import {
  consumablesCapability,
  DeviceRuntimeState,
  DeviceType,
  type VacuumControlStatus,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { classifyDreameModel, controlCapForKind, deviceTypeForKind } from '../dreame-mapping.js'
import {
  buildMowerConsumables,
  isMowerConsumableKey,
  mapMowerStatusToActivity,
} from '../dreame-mower-decode.js'
import {
  buildVacuumConsumableItems,
  clampBatteryLevel,
  clampConsumablePct,
  decodeVacuumTanks,
  mapMiotStateToVacuumState,
  vacuumTankItems,
  nextVacuumControlSlice,
  suctionLevelToken,
  supportedFanSpeedTokens,
  tokenToSuctionLevel,
} from '../dreame-vacuum-decode.js'

describe('mapMiotStateToVacuumState', () => {
  it('maps charging states to docked', () => {
    expect(mapMiotStateToVacuumState(MiotState.Charging)).toBe('docked')
    expect(mapMiotStateToVacuumState(MiotState.ChargingComplete)).toBe('docked')
  })
  it('maps dock-side maintenance (self-wash / emptying / sanitizing) to docked, not cleaning', () => {
    // The robot is parked on the dock — HA reports these as `docked`. Regression
    // guard: previously they fell through the default to "cleaning".
    expect(mapMiotStateToVacuumState(MiotState.CleanWashboardBase)).toBe('docked')
    expect(mapMiotStateToVacuumState(MiotState.AutoEmptying)).toBe('docked')
    expect(mapMiotStateToVacuumState(MiotState.Sanitizing)).toBe('docked')
  })
  it('maps mop / dust-bag drying to the distinct `drying` state', () => {
    expect(mapMiotStateToVacuumState(MiotState.MopDrying)).toBe('drying')
    expect(mapMiotStateToVacuumState(MiotState.DustBagDrying)).toBe('drying')
    expect(mapMiotStateToVacuumState(MiotState.SanitizingWithDry)).toBe('drying')
  })
  it('maps returning states to returning', () => {
    expect(mapMiotStateToVacuumState(MiotState.ReturningToCharge)).toBe('returning')
  })
  it('maps paused states to paused', () => {
    expect(mapMiotStateToVacuumState(MiotState.Paused)).toBe('paused')
    expect(mapMiotStateToVacuumState(MiotState.PausedCleaning)).toBe('paused')
  })
  it('maps standby to idle', () => {
    expect(mapMiotStateToVacuumState(MiotState.Standby)).toBe('idle')
  })
  it('maps active cleaning states to cleaning', () => {
    expect(mapMiotStateToVacuumState(MiotState.Cleaning)).toBe('cleaning')
    expect(mapMiotStateToVacuumState(MiotState.Mopping)).toBe('cleaning')
  })
  it('returns idle for null', () => {
    expect(mapMiotStateToVacuumState(null)).toBe('idle')
  })
})

describe('suction tokens', () => {
  it('lower-cases the enum member name', () => {
    expect(suctionLevelToken(SuctionLevel.Quiet)).toBe('quiet')
    expect(suctionLevelToken(SuctionLevel.Max)).toBe('max')
    expect(suctionLevelToken(null)).toBeNull()
  })
  it('round-trips a token back to its level when supported', () => {
    const supported = [SuctionLevel.Quiet, SuctionLevel.Standard]
    expect(tokenToSuctionLevel('standard', supported)).toBe(SuctionLevel.Standard)
    expect(tokenToSuctionLevel('STANDARD', supported)).toBe(SuctionLevel.Standard)
    // Unsupported level rejected.
    expect(tokenToSuctionLevel('max', supported)).toBeNull()
    expect(tokenToSuctionLevel('nonsense', supported)).toBeNull()
  })
  it('lists supported tokens', () => {
    expect(supportedFanSpeedTokens([SuctionLevel.Quiet, SuctionLevel.Intense])).toEqual([
      'quiet',
      'intense',
    ])
  })
})

describe('clampBatteryLevel', () => {
  it('clamps to 0..100 and rejects non-finite', () => {
    expect(clampBatteryLevel(55)).toBe(55)
    expect(clampBatteryLevel(120)).toBe(100)
    expect(clampBatteryLevel(-5)).toBe(0)
    expect(clampBatteryLevel(null)).toBeNull()
    expect(clampBatteryLevel(NaN)).toBeNull()
  })
})

describe('decodeVacuumTanks', () => {
  /** A capability record with every flag false, overridable per-test. */
  function caps(overrides: Partial<VacuumCapabilities>): VacuumCapabilities {
    return {
      model: 'dreame.vacuum.test',
      verified: false,
      canMop: false,
      canAutoInstallMop: false,
      hasSideBrush: false,
      hasCamera: false,
      hasCarpetSensor: false,
      hasAiObstacleDetection: false,
      canAutoEmpty: false,
      canMopWash: false,
      canMopDry: false,
      canHeatMopWater: false,
      hasDetergentReservoir: false,
      canCleanPerRoom: false,
      supportsVirtualWalls: false,
      supportsNoGoZones: false,
      hasChildLock: false,
      supportsMultiFloor: false,
      canMap: false,
      supportedSuctionLevels: [],
      supportedWaterVolumes: [],
      supportedAiFeatures: [],
      ...overrides,
    }
  }

  it('reports an EXISTING tank as level/status unknown (lib has no fill telemetry)', () => {
    const tanks = decodeVacuumTanks(
      caps({ canMop: true, canMopWash: true, hasDetergentReservoir: true, canAutoEmpty: true }),
    )
    expect(tanks.cleanWater).toEqual({ level: null, status: null })
    expect(tanks.dirtyWater).toEqual({ level: null, status: null })
    expect(tanks.detergent).toEqual({ level: null, status: null })
    expect(tanks.dustBin).toEqual({ level: null, status: null })
  })

  it('reports an ABSENT tank as null (hardware has no such tank)', () => {
    const tanks = decodeVacuumTanks(caps({}))
    expect(tanks.cleanWater).toBeNull()
    expect(tanks.dirtyWater).toBeNull()
    expect(tanks.detergent).toBeNull()
    expect(tanks.dustBin).toBeNull()
  })

  it('derives each tank from its own capability flag independently', () => {
    const tanks = decodeVacuumTanks(caps({ canMop: true, canAutoEmpty: false }))
    expect(tanks.cleanWater).toEqual({ level: null, status: null })
    expect(tanks.dustBin).toBeNull()
  })

  it('returns all-null for a null capability record', () => {
    const tanks = decodeVacuumTanks(null)
    expect(tanks.cleanWater).toBeNull()
    expect(tanks.dirtyWater).toBeNull()
    expect(tanks.detergent).toBeNull()
    expect(tanks.dustBin).toBeNull()
  })

  const allCaps = {
    canMop: true,
    canMopWash: true,
    hasDetergentReservoir: true,
    canAutoEmpty: true,
  }

  it('populates discrete status from the tank-status enum props', () => {
    const tanks = decodeVacuumTanks(caps(allCaps), {
      cleanWaterTankStatus: 2, // LOW_WATER
      waterTank: 1,
      detergentStatus: 2, // LOW_DETERGENT
      dustCollection: 2, // OVER_USE
      dirtyWaterTankStatus: null,
      dustBagStatus: null,
    })
    expect(tanks.cleanWater).toEqual({ level: null, status: 'low' })
    expect(tanks.detergent).toEqual({ level: null, status: 'low' })
    expect(tanks.dustBin).toEqual({ level: null, status: 'full' })
    // 27/2 not reported — dirty-water status stays unknown, never 'ok'.
    expect(tanks.dirtyWater).toEqual({ level: null, status: null })
  })

  // HA Dreame integration (Tasshack dreame-vacuum types.py, dev + v2.0.0b25):
  // DIRTY_WATER_TANK_STATUS = siid 27 piid 2 · 0 INSTALLED · 1 NOT_INSTALLED_OR_FULL;
  // DUST_BAG_STATUS = siid 27 piid 3 · 0 INSTALLED · 1 NOT_INSTALLED · 2 CHECK.
  it('reads the dirty-water tank from 27/2: installed is ok, not-installed-or-full is UNKNOWN', () => {
    const base = {
      cleanWaterTankStatus: null,
      waterTank: null,
      detergentStatus: null,
      dustCollection: null,
      dustBagStatus: null,
    }
    expect(
      decodeVacuumTanks(caps(allCaps), { ...base, dirtyWaterTankStatus: 0 }).dirtyWater,
    ).toEqual({ level: null, status: 'ok' })
    expect(
      decodeVacuumTanks(caps(allCaps), { ...base, dirtyWaterTankStatus: 1 }).dirtyWater,
    ).toEqual({ level: null, status: null }) // a tank lifted out to empty it is not "full"
    // An unknown firmware value is unknown — never 'ok'.
    expect(
      decodeVacuumTanks(caps(allCaps), { ...base, dirtyWaterTankStatus: 7 }).dirtyWater,
    ).toEqual({ level: null, status: null })
  })

  // The unambiguous "full": the robot's own error DirtyWaterTankFull (MiotError 86,
  // siid 2 piid 2 via the library's `errorCode`) — unlike 27/2's NOT_INSTALLED_OR_FULL.
  describe('dirty water from the robot error (MiotError.DirtyWaterTankFull)', () => {
    const noProps = {
      cleanWaterTankStatus: null,
      waterTank: null,
      detergentStatus: null,
      dustCollection: null,
      dirtyWaterTankStatus: null,
      dustBagStatus: null,
    }

    it('error 86 is full — whatever 27/2 says', () => {
      expect(
        decodeVacuumTanks(caps(allCaps), noProps, MiotError.DirtyWaterTankFull).dirtyWater,
      ).toEqual({ level: null, status: 'full' })
      expect(
        decodeVacuumTanks(
          caps(allCaps),
          { ...noProps, dirtyWaterTankStatus: 0 },
          MiotError.DirtyWaterTankFull,
        ).dirtyWater?.status,
      ).toBe('full')
    })

    it('the error cleared is unknown again, unless 27/2 says installed', () => {
      expect(decodeVacuumTanks(caps(allCaps), noProps, null).dirtyWater?.status).toBeNull()
      expect(decodeVacuumTanks(caps(allCaps), noProps, 0).dirtyWater?.status).toBeNull()
      expect(
        decodeVacuumTanks(caps(allCaps), { ...noProps, dirtyWaterTankStatus: 0 }, 0).dirtyWater
          ?.status,
      ).toBe('ok')
    })

    it('another error changes nothing', () => {
      const other = MiotError.CheckMopInstall
      expect(decodeVacuumTanks(caps(allCaps), noProps, other).dirtyWater?.status).toBeNull()
      expect(
        decodeVacuumTanks(caps(allCaps), { ...noProps, dirtyWaterTankStatus: 0 }, other).dirtyWater
          ?.status,
      ).toBe('ok')
      expect(decodeVacuumTanks(caps(allCaps), noProps, other).cleanWater?.status).toBeNull()
    })
  })

  it('a dust bag that is missing or asks to be checked (27/3) never reads ok', () => {
    const base = {
      cleanWaterTankStatus: null,
      waterTank: null,
      detergentStatus: null,
      dirtyWaterTankStatus: null,
      dustCollection: 1, // AVAILABLE
    }
    expect(decodeVacuumTanks(caps(allCaps), { ...base, dustBagStatus: 0 }).dustBin?.status).toBe(
      'ok',
    )
    expect(
      decodeVacuumTanks(caps(allCaps), { ...base, dustBagStatus: 1 }).dustBin?.status,
    ).toBeNull()
    expect(
      decodeVacuumTanks(caps(allCaps), { ...base, dustBagStatus: 2 }).dustBin?.status,
    ).toBeNull()
    // OVER_USE on 15/3 is still full, whatever the bag says.
    expect(
      decodeVacuumTanks(caps(allCaps), { ...base, dustCollection: 2, dustBagStatus: 2 }).dustBin
        ?.status,
    ).toBe('full')
  })

  it('maps installed/available enums to ok', () => {
    const tanks = decodeVacuumTanks(caps(allCaps), {
      cleanWaterTankStatus: 0, // INSTALLED
      waterTank: 1,
      detergentStatus: 0, // INSTALLED
      dustCollection: 1, // AVAILABLE
      dirtyWaterTankStatus: null,
      dustBagStatus: null,
    })
    expect(tanks.cleanWater?.status).toBe('ok')
    expect(tanks.detergent?.status).toBe('ok')
    expect(tanks.dustBin?.status).toBe('ok')
  })

  it('falls back to water-tank (4/6) presence when 27/1 is absent', () => {
    const tanks = decodeVacuumTanks(caps({ canMop: true }), {
      cleanWaterTankStatus: null,
      waterTank: 10, // MOP_INSTALLED
      detergentStatus: null,
      dustCollection: null,
      dirtyWaterTankStatus: null,
      dustBagStatus: null,
    })
    expect(tanks.cleanWater?.status).toBe('ok')
  })

  it('leaves status null for unknown / not-installed / disabled enum values', () => {
    const tanks = decodeVacuumTanks(caps(allCaps), {
      cleanWaterTankStatus: 1, // NOT_INSTALLED
      waterTank: 0, // NOT_INSTALLED
      detergentStatus: 1, // DISABLED
      dustCollection: 3, // NEVER
      dirtyWaterTankStatus: null,
      dustBagStatus: null,
    })
    expect(tanks.cleanWater?.status).toBeNull()
    expect(tanks.detergent?.status).toBeNull()
    expect(tanks.dustBin?.status).toBeNull()
  })

  it('keeps status null when no props are supplied (back-compat)', () => {
    const tanks = decodeVacuumTanks(caps(allCaps))
    expect(tanks.cleanWater).toEqual({ level: null, status: null })
    expect(tanks.dustBin).toEqual({ level: null, status: null })
  })
})

describe('clampConsumablePct', () => {
  it('clamps to 0..100 and rejects non-finite', () => {
    expect(clampConsumablePct(75)).toBe(75)
    expect(clampConsumablePct(0)).toBe(0)
    expect(clampConsumablePct(100)).toBe(100)
    expect(clampConsumablePct(110)).toBe(100)
    expect(clampConsumablePct(-1)).toBe(0)
    expect(clampConsumablePct(null)).toBeNull()
    expect(clampConsumablePct(NaN)).toBeNull()
    expect(clampConsumablePct(Infinity)).toBeNull()
  })
})

describe('buildVacuumConsumableItems (presence-driven)', () => {
  const FULL: readonly ConsumableReading[] = [
    { key: 'main-brush', label: 'Main Brush', leftPct: 80, resettable: true },
    { key: 'filter', label: 'Filter', leftPct: 40, resettable: true },
    { key: 'mop-pad', label: 'Mop Pad', leftPct: 30, resettable: true },
    { key: 'dust-bag', label: 'Dust Bag', leftPct: 90, resettable: false },
  ]

  it('surfaces exactly the consumables the model reports (no hardcoded set)', () => {
    const items = buildVacuumConsumableItems(FULL)
    expect(items.map((i) => i.key)).toEqual(['main-brush', 'filter', 'mop-pad', 'dust-bag'])
  })

  it('is empty when the model reports no consumables', () => {
    expect(buildVacuumConsumableItems([])).toEqual([])
  })

  it('maps remaining percentages onto the level field, with no verdict', () => {
    const items = buildVacuumConsumableItems(FULL)
    expect(items.find((i) => i.key === 'main-brush')?.level).toBe(80)
    expect(items.find((i) => i.key === 'mop-pad')?.level).toBe(30)
    expect(items.every((i) => i.status === null)).toBe(true)
  })

  it('clamps an out-of-range percentage', () => {
    const items = buildVacuumConsumableItems([
      { key: 'filter', label: 'Filter', leftPct: 140, resettable: true },
    ])
    expect(items[0]?.level).toBe(100)
  })

  it('passes the per-item resettable flag through (reset action presence)', () => {
    const items = buildVacuumConsumableItems(FULL)
    expect(items.find((i) => i.key === 'main-brush')?.resettable).toBe(true)
    expect(items.find((i) => i.key === 'dust-bag')?.resettable).toBe(false)
  })
})

describe('mapMowerStatusToActivity', () => {
  it('maps the mower lifecycle', () => {
    expect(mapMowerStatusToActivity(MowerStatus.Mowing)).toBe('mowing')
    expect(mapMowerStatusToActivity(MowerStatus.Paused)).toBe('paused')
    expect(mapMowerStatusToActivity(MowerStatus.PausedDueToErrors)).toBe('error')
    expect(mapMowerStatusToActivity(MowerStatus.Charging)).toBe('docked')
    expect(mapMowerStatusToActivity(MowerStatus.Standby)).toBe('idle')
    expect(mapMowerStatusToActivity(null)).toBe('idle')
  })
})

describe('buildMowerConsumables / isMowerConsumableKey', () => {
  it('maps CMS readings to consumable items with labels + resettable', () => {
    const items = buildMowerConsumables([
      { key: 'blade', usedMinutes: 1842, totalMinutes: 6000, remainingPercent: 69.3 },
      { key: 'brush', usedMinutes: 10950, totalMinutes: 30000, remainingPercent: 63.5 },
      { key: 'maintenance', usedMinutes: 1840, totalMinutes: 3600, remainingPercent: 48.9 },
    ])
    expect(items.map((i) => i.key)).toEqual(['blade', 'brush', 'maintenance'])
    expect(items.map((i) => i.label)).toEqual(['Blade', 'Brush', 'Maintenance'])
    expect(items.map((i) => i.level)).toEqual([69.3, 63.5, 48.9])
    expect(items.every((i) => i.resettable)).toBe(true)
    expect(items.every((i) => i.status === null)).toBe(true)
  })

  it('gives no verdict of its own — the notification rule owns the threshold', () => {
    const items = buildMowerConsumables([
      { key: 'blade', usedMinutes: 5500, totalMinutes: 6000, remainingPercent: 8.3 },
      { key: 'brush', usedMinutes: 100, totalMinutes: 30000, remainingPercent: 99.7 },
    ])
    expect(items.map((i) => i.status)).toEqual([null, null])
    expect(items[0]?.level).toBe(8.3)
  })

  it('recognises only the three canonical consumable keys', () => {
    expect(isMowerConsumableKey('blade')).toBe(true)
    expect(isMowerConsumableKey('brush')).toBe(true)
    expect(isMowerConsumableKey('maintenance')).toBe(true)
    expect(isMowerConsumableKey('robot')).toBe(false) // alias not exposed by the cap
    expect(isMowerConsumableKey('filter')).toBe(false)
  })
})

describe('dreame model classification', () => {
  it('classifies vacuum / mower / unsupported', () => {
    expect(classifyDreameModel('dreame.vacuum.r2228')).toBe('vacuum')
    expect(classifyDreameModel('dreame.mower.p2255')).toBe('mower')
    expect(classifyDreameModel('dreame.light.x')).toBe('unsupported')
  })
  it('maps kind to device type + control cap', () => {
    expect(deviceTypeForKind('vacuum')).toBe(DeviceType.Vacuum)
    expect(deviceTypeForKind('mower')).toBe(DeviceType.LawnMower)
    expect(controlCapForKind('vacuum')).toBe('vacuum-control')
    expect(controlCapForKind('mower')).toBe('lawn-mower-control')
  })
})

// ─── Bug-1 guard: consumables schema must be registered before the first write ──
//
// Before the fix, DreameChildDevice.onActivate called super.onActivate() first,
// which ran registerControlCap() → recomputeSlice() (writing to 'consumables')
// BEFORE registerConsumablesCap() ever ran. DeviceRuntimeState.applyCapWrite
// throws "no schema registered for cap" when the schema isn't present. The fix
// moves registerConsumablesCap() into registerControlCap() so it always runs
// before recomputeSlice().
//
// This test exercises the exact runtime-state invariant: installCapSchema MUST
// precede setCapState on the same cap name.
describe('consumables runtimeState ordering invariant (guard for Bug 1)', () => {
  function makeRuntimeState(): DeviceRuntimeState {
    return DeviceRuntimeState.fromInitial({}, async () => {
      /* no-op writer */
    })
  }

  it('throws when setCapState is called before installCapSchema (the pre-fix symptom)', () => {
    const rs = makeRuntimeState()
    expect(() =>
      rs.setCapState('consumables', { items: [], lastChangedAt: 0, lastFetchedAt: 0 }),
    ).toThrow(/no schema registered for cap "consumables"/)
  })

  it('does NOT throw when installCapSchema is called first (the post-fix behaviour)', () => {
    const rs = makeRuntimeState()
    // Simulate what registerNativeCap does: install the cap's runtimeState schema.
    rs.installCapSchema('consumables', consumablesCapability.runtimeState)
    // Now a write with the correct shape (including lastFetchedAt) must succeed.
    expect(() =>
      rs.setCapState('consumables', { items: [], lastChangedAt: 0, lastFetchedAt: 0 }),
    ).not.toThrow()
  })

  it('rejects a write that omits lastFetchedAt even after schema registration (guard for Bug 2)', () => {
    const rs = makeRuntimeState()
    rs.installCapSchema('consumables', consumablesCapability.runtimeState)
    // A payload missing lastFetchedAt fails Zod validation on the runtimeState schema.
    expect(() => rs.setCapState('consumables', { items: [], lastChangedAt: 0 })).toThrow()
  })
})

describe('nextVacuumControlSlice — write on change only', () => {
  const base: VacuumControlStatus = {
    state: 'docked',
    batteryLevel: 100,
    fanSpeed: 'standard',
    availableFanSpeeds: ['quiet', 'standard'],
    progressPercent: null,
    errorCode: null,
    errorLabel: null,
    lastChangedAt: 100,
  }

  it('a push that changed nothing but the clock writes nothing', () => {
    expect(
      nextVacuumControlSlice(base, {
        ...base,
        availableFanSpeeds: ['quiet', 'standard'],
        lastChangedAt: 999,
      }),
    ).toBeNull()
  })

  it('a state that moved is a change', () => {
    const next: VacuumControlStatus = { ...base, state: 'cleaning', lastChangedAt: 999 }
    expect(nextVacuumControlSlice(base, next)).toEqual(next)
  })

  it('the first write always happens', () => {
    expect(nextVacuumControlSlice(undefined, base)).toEqual(base)
  })
})

describe('vacuumTankItems — the tanks as consumables items (D915)', () => {
  it('turns every PRESENT tank into a supply or waste item, in a fixed order', () => {
    const items = vacuumTankItems({
      cleanWater: { level: null, status: 'low' },
      dirtyWater: { level: null, status: 'ok' },
      detergent: null,
      dustBin: { level: 40, status: null },
    })
    expect(items).toEqual([
      {
        key: 'cleanWater',
        label: 'Clean water tank',
        level: null,
        status: 'low',
        kind: 'supply',
        form: 'tank',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'dirtyWater',
        label: 'Dirty water tank',
        level: null,
        status: 'ok',
        kind: 'waste',
        form: 'tank',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'dustBin',
        label: 'Dust bin',
        level: 40,
        status: null,
        kind: 'waste',
        form: 'bin',
        lastResetAt: null,
        resettable: false,
      },
    ])
  })

  it('every item validates against the consumables cap', () => {
    const items = vacuumTankItems({
      cleanWater: { level: null, status: 'low' },
      dirtyWater: { level: null, status: 'full' },
      detergent: { level: null, status: null },
      dustBin: { level: null, status: 'full' },
    })
    const parsed = consumablesCapability.status.schema.safeParse({ items, lastChangedAt: 1 })
    expect(parsed.success).toBe(true)
  })

  it('names each item’s form: water tanks are tanks, detergent a product, the dust bin a bin', () => {
    const items = vacuumTankItems({
      cleanWater: { level: null, status: 'ok' },
      dirtyWater: { level: null, status: 'ok' },
      detergent: { level: null, status: 'ok' },
      dustBin: { level: null, status: 'ok' },
    })
    expect(items.map((i) => [i.key, i.form])).toEqual([
      ['cleanWater', 'tank'],
      ['dirtyWater', 'tank'],
      ['detergent', 'product'],
      ['dustBin', 'bin'],
    ])
  })

  it('a robot with no tank reports none', () => {
    expect(
      vacuumTankItems({ cleanWater: null, dirtyWater: null, detergent: null, dustBin: null }),
    ).toEqual([])
  })
})
