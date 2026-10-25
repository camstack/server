import {
  contactCapability,
  floodCapability,
  smokeCapability,
  carbonMonoxideCapability,
  gasCapability,
  tamperCapability,
  vibrationCapability,
  connectivityCapability,
  binaryCapability,
  motionCapability,
  type DeviceContext,
  type InferNativeProvider,
  type DeviceRole,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { haChangeStamp, type HaStatePushContext } from '../ha-change-stamp.js'
import type { HaEntityState } from '../ha-types.js'

const SUPPORTED_CAP_NAMES = [
  'contact',
  'flood',
  'smoke',
  'carbon-monoxide',
  'gas',
  'tamper',
  'vibration',
  'connectivity',
  'binary',
  'motion',
] as const
type SupportedCapName = (typeof SUPPORTED_CAP_NAMES)[number]

/** A cap slice as the runtime state holds it. */
type CapSlice = Readonly<Record<string, unknown>>

/**
 * Generic HA binary-sensor child device. Hosts every Phase B B1 cap
 * plus the existing `motion` cap when HA reports `binary_sensor.*`
 * with `device_class: motion`. The cap to host is picked from
 * `persistedConfig.capabilities[0]` at construction.
 *
 * Each cap uses a differently-named boolean field on its slice
 * (`entryOpen`, `flooded`, `detected`, `tampered`, `connected`, `on`)
 * — the per-cap slice-build dispatch lives inside `handleStatePush`.
 */
export class HaBinarySensorDevice extends HaBaseChildDevice {
  private readonly capName: SupportedCapName

  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as {
      capabilities?: readonly string[]
      role?: DeviceRole
    }
    const capName = pickSupportedBinaryCap(persisted.capabilities)
    if (!capName) {
      throw new Error(
        `HaBinarySensorDevice: no supported binary-sensor cap in persisted config (id=${ctx.id})`,
      )
    }
    super(ctx, persisted.role !== undefined ? { role: persisted.role } : {})
    this.capName = capName

    this.registerCap(capName)
    // The seed is written OVER the slice hydrated from the persisted runtime
    // state (the schema was installed by `registerCap`, so a stored slice is
    // already validated). Keep the stored LEVEL when present: inventing
    // `false` over a stored `true` is a false falling edge that re-arms every
    // one-shot consumer (composer `rose`, sensor markers) when HA then pushes
    // the real `on` after a provider restart. A stored motion rise timestamp
    // is still a fact either way (`motion.cap.ts`).
    const stored = this.runtimeState.getCapState(capName)
    const seededActive = storedActiveLevel(capName, stored) ?? false
    const seededChangedAt = storedChangedAt(capName, stored) ?? 0
    this.runtimeState.setCapState(
      this.capName,
      buildSlice(capName, seededActive, seededChangedAt, stored),
    )
  }

  protected override handleStatePush(state: HaEntityState, push: HaStatePushContext): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const active = state.state === 'on'
    const prior = this.runtimeState.getCapState(this.capName)
    // A recovery to the level it already held is not a transition (`ha-change-stamp.ts`):
    // HA's fresh `last_changed` after `unavailable → on` is the outage, not the door.
    const stamp = haChangeStamp({
      sameValue: storedActiveLevel(this.capName, prior) === active,
      priorChangedAt: storedChangedAt(this.capName, prior),
      haChangedAt: Date.parse(state.last_changed) || Date.now(),
      afterOutage: push.afterOutage,
    })
    if (stamp.kind === 'seeded') {
      this.deviceLogger.info('HA→device recovery with no known prior value — no change time', {
        meta: { entityId: this.entityId, cap: this.capName, value: state.state },
      })
    }
    this.runtimeState.setCapState(this.capName, buildSlice(this.capName, active, stamp.at, prior))
  }

  private registerCap(name: SupportedCapName): void {
    switch (name) {
      case 'contact': {
        const provider: InferNativeProvider<typeof contactCapability> = {
          getStatus: async () =>
            this.readSlice<{ entryOpen: boolean; lastChangedAt: number }>({
              entryOpen: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(contactCapability, provider)
        return
      }
      case 'flood': {
        const provider: InferNativeProvider<typeof floodCapability> = {
          getStatus: async () =>
            this.readSlice<{ flooded: boolean; lastChangedAt: number }>({
              flooded: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(floodCapability, provider)
        return
      }
      case 'smoke': {
        const provider: InferNativeProvider<typeof smokeCapability> = {
          getStatus: async () =>
            this.readSlice<{ detected: boolean; lastChangedAt: number }>({
              detected: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(smokeCapability, provider)
        return
      }
      case 'carbon-monoxide': {
        const provider: InferNativeProvider<typeof carbonMonoxideCapability> = {
          getStatus: async () =>
            this.readSlice<{ detected: boolean; lastChangedAt: number }>({
              detected: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(carbonMonoxideCapability, provider)
        return
      }
      case 'gas': {
        const provider: InferNativeProvider<typeof gasCapability> = {
          getStatus: async () =>
            this.readSlice<{ detected: boolean; lastChangedAt: number }>({
              detected: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(gasCapability, provider)
        return
      }
      case 'tamper': {
        const provider: InferNativeProvider<typeof tamperCapability> = {
          getStatus: async () =>
            this.readSlice<{ tampered: boolean; lastChangedAt: number }>({
              tampered: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(tamperCapability, provider)
        return
      }
      case 'vibration': {
        const provider: InferNativeProvider<typeof vibrationCapability> = {
          getStatus: async () =>
            this.readSlice<{ detected: boolean; lastChangedAt: number }>({
              detected: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(vibrationCapability, provider)
        return
      }
      case 'connectivity': {
        const provider: InferNativeProvider<typeof connectivityCapability> = {
          getStatus: async () =>
            this.readSlice<{ connected: boolean; lastChangedAt: number }>({
              connected: false,
              lastChangedAt: 0,
            }),
        }
        this.ctx.registerNativeCap(connectivityCapability, provider)
        return
      }
      case 'binary': {
        const provider: InferNativeProvider<typeof binaryCapability> = {
          getStatus: async () =>
            this.readSlice<{ on: boolean; lastChangedAt: number }>({ on: false, lastChangedAt: 0 }),
        }
        this.ctx.registerNativeCap(binaryCapability, provider)
        return
      }
      case 'motion': {
        const provider: InferNativeProvider<typeof motionCapability> = {
          // `autoClearAfterMs: null` — a `Sensor` device (D475): HA pushes the
          // real falling edge itself, so there is no episode-close delay to
          // report. `MOTION_CLOSE_AFTER_MS` is written only by `Camera`
          // devices whose motion state the phase machine (or, here, nothing)
          // must infer a close for.
          getStatus: async () =>
            this.readSlice<{
              detected: boolean
              lastDetectedAt: number | null
              autoClearAfterMs: number | null
            }>({ detected: false, lastDetectedAt: null, autoClearAfterMs: null }),
          isDetected: async () => {
            const slice = this.runtimeState.getCapState<{ detected: boolean }>('motion')
            return slice?.detected === true
          },
        }
        this.ctx.registerNativeCap(motionCapability, provider)
        return
      }
    }
  }

  private readSlice<T extends Record<string, unknown>>(fallback: T): T {
    return this.runtimeState.getCapState<T>(this.capName) ?? fallback
  }
}

/**
 * The motion slice's last rise, carried across a fall. `null` only while no
 * rise was ever observed — never a time taken from an `off` state, whose HA
 * `last_changed` is the FALL, not the rise.
 */
function priorLastDetectedAt(prior: CapSlice | undefined): number | null {
  const raw = prior?.['lastDetectedAt']
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null
}

/** The boolean field this cap's slice uses as "active". */
function activeFieldName(capName: SupportedCapName): string {
  switch (capName) {
    case 'contact':
      return 'entryOpen'
    case 'flood':
      return 'flooded'
    case 'tamper':
      return 'tampered'
    case 'connectivity':
      return 'connected'
    case 'binary':
      return 'on'
    case 'smoke':
    case 'carbon-monoxide':
    case 'gas':
    case 'vibration':
    case 'motion':
      return 'detected'
  }
}

function storedActiveLevel(
  capName: SupportedCapName,
  stored: CapSlice | undefined,
): boolean | undefined {
  if (stored === undefined) return undefined
  const raw = stored[activeFieldName(capName)]
  return typeof raw === 'boolean' ? raw : undefined
}

function storedChangedAt(
  capName: SupportedCapName,
  stored: CapSlice | undefined,
): number | undefined {
  if (stored === undefined) return undefined
  if (capName === 'motion') {
    const rise = priorLastDetectedAt(stored)
    return rise ?? undefined
  }
  const raw = stored['lastChangedAt']
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined
}

function buildSlice(
  capName: SupportedCapName,
  active: boolean,
  lastChangedAt: number,
  prior: CapSlice | undefined,
): Record<string, unknown> {
  switch (capName) {
    case 'contact':
      return { entryOpen: active, lastChangedAt }
    case 'flood':
      return { flooded: active, lastChangedAt }
    case 'smoke':
      return { detected: active, lastChangedAt }
    case 'carbon-monoxide':
      return { detected: active, lastChangedAt }
    case 'gas':
      return { detected: active, lastChangedAt }
    case 'tamper':
      return { tampered: active, lastChangedAt }
    case 'vibration':
      return { detected: active, lastChangedAt }
    case 'connectivity':
      return { connected: active, lastChangedAt }
    case 'binary':
      return { on: active, lastChangedAt }
    case 'motion':
      // `autoClearAfterMs: null`, always — a `Sensor` device pushes the real
      // falling edge itself, so there is no episode-close delay to report
      // (D475). `lastDetectedAt` is the LAST RISE and survives the fall:
      // `null` means "never detected" (`motion.cap.ts`), and erasing it on
      // every `off` made a sensor that fired a minute ago read as dead.
      return {
        detected: active,
        lastDetectedAt: active ? lastChangedAt : priorLastDetectedAt(prior),
        autoClearAfterMs: null,
      }
  }
}

function pickSupportedBinaryCap(
  capabilities: readonly string[] | undefined,
): SupportedCapName | null {
  if (!capabilities) return null
  for (const cap of capabilities) {
    if (SUPPORTED_CAP_NAMES.includes(cap as SupportedCapName)) {
      return cap as SupportedCapName
    }
  }
  return null
}

/** Exposed for the class factory. */
export function hostsBinarySensor(capabilities: readonly string[]): boolean {
  return capabilities.some((c) => SUPPORTED_CAP_NAMES.includes(c as SupportedCapName))
}
