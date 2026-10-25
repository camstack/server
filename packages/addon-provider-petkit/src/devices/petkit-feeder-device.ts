import { type FeederDevice, isDualHopper as libIsDualHopper } from '@apocaliss92/nodepetkit'
import {
  BaseDevice,
  type DeviceContext,
  DeviceType,
  errMsg,
  type InferNativeProvider,
  type PetFeederStatus,
  petFeederCapability,
} from '@camstack/types'
import {
  coldStartFeederStatus,
  type FeederReading,
  mapFeederToStatus,
} from '../petkit-feeder-mapping.js'
import { petkitConnections } from '../petkit-gateway.js'
import { petkitFeederDeviceSchema } from '../config.js'

const PET_FEEDER_CAP = 'pet-feeder'
/** How long a slice stays "fresh" before a read triggers a re-poll. */
const STALE_MS = 15_000
/** Fallback per-feeder poll cadence (PetKit has no push channel). */
const DEFAULT_POLL_MS = 30_000

/** Read a nested object out of a loose record, or null when absent. */
function nestedObject(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = source[key]
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** Coerce a loose value to a finite number, or null. */
function numOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Coerce a loose 0/1 (or boolean) value to a boolean, or null when absent. */
function boolFrom01(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  const n = numOrNull(value)
  return n === null ? null : n !== 0
}

/** Coerce a loose value to a non-empty trimmed string, or null. */
function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Extract a library-free {@link FeederReading} from a live `FeederDevice`
 * handle. Typed getters carry the food / battery / desiccant / feeding /
 * errorCode readings; the raw settings + power-interface fields (which the
 * library does not expose as getters) are read from the handle's nested
 * `state` / `settings` wire objects at this system boundary.
 */
export function extractFeederReading(feeder: FeederDevice): FeederReading {
  const state = feeder.state
  const inner = nestedObject(state, 'state')
  const settings = nestedObject(state, 'settings')
  const powerMode = numOrNull(inner?.['pim']) ?? numOrNull(state['pim'])
  return {
    online: feeder.online,
    isDualHopper: feeder.isDualHopper,
    feeding: feeder.feeding,
    food: feeder.food ?? null,
    food1: feeder.food1 ?? null,
    food2: feeder.food2 ?? null,
    batteryPower: feeder.batteryPower ?? null,
    desiccantLeftDays: feeder.desiccantLeftDays ?? null,
    errorCode: feeder.errorCode ?? null,
    errorMsg: strOrNull(inner?.['errorMsg']),
    powerMode,
    childLock: boolFrom01(settings?.['manualLock']),
    indicatorLight: boolFrom01(settings?.['lightMode']),
    feedSound: boolFrom01(settings?.['feedSound']),
    volume: numOrNull(settings?.['volume']),
  }
}

/**
 * One PetKit feeder (Fresh Element / Mini / D3 / D4 / D4S / D4H / D4SH) as a
 * CamStack `PetFeeder` device. Registers the `pet-feeder` cap directly (no
 * container / accessory children) and maps the live `@apocaliss92/nodepetkit`
 * `FeederDevice` handle → the cap slice.
 *
 * PetKit exposes no push channel, so the device polls its handle on a cadence
 * and eagerly after every command; reads that find a stale slice trigger a poll
 * too (withhold-until-ready: the slice stays cold-start until the first poll
 * lands). Commands route to the handle: `feed` → `feed(grams | {hopper1,
 * hopper2})`, `cancelFeed`/`resetDesiccant`/`markFoodReplenished`/`callPet`/
 * `playSound` to their library methods, and the four setters to
 * `setChildLock`/`setIndicatorLight`/`setFeedSound`/`setVolume`.
 */
export class PetkitFeederDevice extends BaseDevice<typeof petkitFeederDeviceSchema> {
  readonly features = []

  private readonly petkitDeviceId: string
  private readonly integrationId: string
  private readonly dualHopper: boolean
  private surfaceUnsub: (() => void) | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(ctx: DeviceContext) {
    const persisted = petkitFeederDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, petkitFeederDeviceSchema, { type: DeviceType.PetFeeder })
    this.petkitDeviceId = persisted.petkitDeviceId
    this.integrationId = persisted.integrationId
    this.dualHopper = persisted.isDualHopper ?? libIsDualHopper(persisted.petkitDeviceType)
    this.online = this.resolveHandle() !== null
    void this.updateSourceInfo({ id: this.petkitDeviceId, system: 'petkit' })
  }

  private resolveHandle(): FeederDevice | null {
    return petkitConnections.getDevice(this.integrationId, this.petkitDeviceId)
  }

  private requireHandle(): FeederDevice {
    const handle = this.resolveHandle()
    if (handle === null) {
      throw new Error(
        `PetkitFeederDevice: feeder handle unavailable (petkitDeviceId=${this.petkitDeviceId})`,
      )
    }
    return handle
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCap()
    this.runtimeState.setCapState(PET_FEEDER_CAP, coldStartFeederStatus(this.dualHopper))
    // Re-poll whenever the account surface is (re)published (restore may race
    // the account login, so the handle can be null at activate time).
    this.surfaceUnsub = petkitConnections.onSurface(this.integrationId, () => {
      void this.refreshFromCloud()
    })
    this.pollTimer = setInterval(() => {
      void this.refreshFromCloud()
    }, DEFAULT_POLL_MS)
    void this.refreshFromCloud()
  }

  override async removeDevice(): Promise<void> {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.surfaceUnsub !== null) {
      try {
        this.surfaceUnsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.surfaceUnsub = null
    }
  }

  /** Poll the cloud once and re-map the cap slice. No-op when no handle bound. */
  private async refreshFromCloud(): Promise<void> {
    const handle = this.resolveHandle()
    if (handle === null) return
    try {
      await handle.refresh()
    } catch (err: unknown) {
      this.ctx.logger.warn('petkit feeder: refresh failed', {
        meta: { petkitDeviceId: this.petkitDeviceId, error: errMsg(err) },
      })
      return
    }
    const reading = extractFeederReading(handle)
    this.runtimeState.setCapState(PET_FEEDER_CAP, mapFeederToStatus(reading, Date.now()))
    this.markOnline(reading.online)
  }

  /** Trigger a poll when the slice is missing or older than {@link STALE_MS}. */
  private async ensureFresh(): Promise<void> {
    const slice = this.runtimeState.getCapState<PetFeederStatus>(PET_FEEDER_CAP)
    const fetchedAt = slice?.lastFetchedAt ?? 0
    if (!slice || Date.now() - fetchedAt > STALE_MS) await this.refreshFromCloud()
  }

  private registerCap(): void {
    const provider: InferNativeProvider<typeof petFeederCapability> = {
      getStatus: async ({ deviceId }) => {
        if (deviceId !== this.id) return null
        await this.ensureFresh()
        return (
          this.runtimeState.getCapState<PetFeederStatus>(PET_FEEDER_CAP) ??
          coldStartFeederStatus(this.dualHopper)
        )
      },
      feed: async ({ grams, hopper1, hopper2 }) => {
        const handle = this.requireHandle()
        if (hopper1 !== undefined || hopper2 !== undefined) {
          await handle.feed({
            ...(hopper1 !== undefined ? { hopper1 } : {}),
            ...(hopper2 !== undefined ? { hopper2 } : {}),
          })
        } else if (grams !== undefined) {
          await handle.feed(grams)
        } else {
          throw new Error('petkit feed: one of grams / hopper1 / hopper2 is required')
        }
        await this.refreshFromCloud()
      },
      cancelFeed: async () => {
        await this.requireHandle().cancelFeed()
        await this.refreshFromCloud()
      },
      resetDesiccant: async () => {
        await this.requireHandle().resetDesiccant()
        await this.refreshFromCloud()
      },
      markFoodReplenished: async () => {
        await this.requireHandle().markFoodReplenished()
        await this.refreshFromCloud()
      },
      callPet: async () => {
        await this.requireHandle().callPet()
      },
      playSound: async ({ soundId }) => {
        await this.requireHandle().playSound(soundId)
      },
      setChildLock: async ({ on }) => {
        await this.requireHandle().setChildLock(on)
        await this.refreshFromCloud()
      },
      setIndicatorLight: async ({ on }) => {
        await this.requireHandle().setIndicatorLight(on)
        await this.refreshFromCloud()
      },
      setFeedSound: async ({ on }) => {
        await this.requireHandle().setFeedSound(on)
        await this.refreshFromCloud()
      },
      setVolume: async ({ level }) => {
        await this.requireHandle().setVolume(level)
        await this.refreshFromCloud()
      },
    }
    this.ctx.registerNativeCap(petFeederCapability, provider)
  }
}
