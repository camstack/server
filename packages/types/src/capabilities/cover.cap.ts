import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Window covering / blinds / garage door / valve cap. Models HA
 * `cover.*` entities — anything that moves between an open and a
 * closed state with optional intermediate positioning and tilt.
 *
 * State follows HA's canonical lifecycle: `open` / `opening` /
 * `closing` / `closed` / `stopped`. `position` (0 closed, 100 open)
 * and `tiltPosition` are nullable — some shutters only support
 * full open/close, some Venetian blinds add tilt but no slat
 * positioning, garage doors are usually positionless. Providers
 * populate only what the hardware reports.
 *
 * The cap intentionally does NOT split tilt into a sibling cap:
 * physical hardware that has tilt always has the main position
 * surface too, so the coupling stays inside one slice + one method
 * group rather than spreading across two registrations.
 *
 * Sub-surface gating paired with `DeviceFeature` flags:
 *   - `CoverPositionable` — intermediate `position` slider
 *   - `CoverTilt` — slat-tilt slider
 */

export const CoverStateSchema = z.enum(['open', 'opening', 'closing', 'closed', 'stopped'])
export type CoverState = z.infer<typeof CoverStateSchema>

export const CoverStatusSchema = z.object({
  /** Lifecycle state of the cover. */
  state: CoverStateSchema,
  /** 0 = fully closed, 100 = fully open. Null when the device has
   *  no intermediate position surface. */
  position: z.number().min(0).max(100).nullable(),
  /** 0 = closed slats, 100 = open slats. Null when no tilt support. */
  tiltPosition: z.number().min(0).max(100).nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type CoverStatus = z.infer<typeof CoverStatusSchema>

export const coverCapability = {
  name: 'cover',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Cover],
  methods: {
    open: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    close: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    stop: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setPosition: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        position: z.number().min(0).max(100),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setTiltPosition: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        tiltPosition: z.number().min(0).max(100),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: CoverStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch
   * the slice for live position changes during a move.
   */
  runtimeState: CoverStatusSchema,

  /**
   * Runtime-state durability: **restored** — position survives a restart on the device; the mirror should agree at boot rather than read blank.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. Actuator tier: position keeps every tick of a movement.
   */
  history: {
    fields: {
      position: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type ICoverProvider = InferProvider<typeof coverCapability>
