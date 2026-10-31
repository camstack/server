import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Smart-lock cap. Models HA `lock.*` entities — anything with a
 * locked / unlocked binary state plus the four transient lifecycle
 * states (`locking` / `unlocking`) and the `jammed` failure state
 * that low-end deadbolts surface when the motor can't reach the
 * target position.
 *
 * Some HA locks require a PIN code on every lock/unlock operation
 * (workplace keypad locks, hospitality). The optional `code` field
 * on the methods passes it through to the upstream service — the
 * code is NEVER persisted in the runtime slice or any event payload.
 * Locks that REQUIRE a code set `DeviceFeature.LockPinRequired` so
 * the UI gates a code-entry field without a slice fetch.
 *
 * Locks that support a latch-release ("open door") action advertise
 * `DeviceFeature.LockOpen`. The `open` method triggers the latch
 * without a full lock/unlock cycle. Only available when the lock
 * reports `LockEntityFeature.OPEN` (bit value 1) in HA
 * `supported_features`.
 */

/**
 * `door-open` (D984): the linked door contact reads open, so the bolt cannot be
 * thrown. It is the lock's REAL reported state, written into the mirrored slice
 * by the door-contact Customize extension — never a provider's own value, and
 * never a projection a reader has to compute. Precedence: a native `jammed`
 * wins; otherwise an open contact reports `door-open` whatever the native state
 * says (`locked` included); a closed or unknown contact leaves the native state.
 * A `lock()` is refused while the state is `door-open`; `unlock()` never is.
 */
export const LockStateSchema = z.enum([
  'locked',
  'unlocked',
  'locking',
  'unlocking',
  'jammed',
  'door-open',
])
export type LockState = z.infer<typeof LockStateSchema>

export const LockControlStatusSchema = z.object({
  /** Lifecycle state of the lock. `jammed` means the motor reported
   *  failure to reach the target — operator intervention required. */
  state: LockStateSchema,
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type LockControlStatus = z.infer<typeof LockControlStatusSchema>

/**
 * "Door contact" Customize extension (D984): the ONE extension that replaces a
 * native field. `state` is listed in `overridable` for this target, so the
 * validator and the guard accept it and nothing else.
 */
const lockControlCustomize = {
  version: 1,
  overridable: [{ path: 'state', by: 'door-contact' }],
  targets: [
    {
      id: 'door-contact',
      cardinality: 'scalar',
      vocabulary: { cap: 'lock-control', stateField: 'state' },
      deviceTypes: [DeviceType.Lock],
      apply: 'replace',
      path: 'state',
      override: { whenSourceTrue: 'door-open', unlessNative: ['jammed'] },
      sources: [{ kind: 'binary', transforms: [{ kind: 'identity' }] }],
      sourceReport: { status: 'assignment-status' },
    },
  ],
} as const satisfies CapabilityCustomizeSpec

export const lockControlCapability = {
  name: 'lock-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Lock],
  methods: {
    lock: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** Optional PIN code required by some keypad locks. NOT
         *  persisted — passed directly to the upstream service. */
        code: z.string().min(1).optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    unlock: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        code: z.string().min(1).optional(),
        /**
         * Honoured by a helper lock GROUP only (D944): unlocking several doors
         * with one call is refused unless the caller says it was confirmed. A
         * single lock ignores it. The refusal lives in the callee, so no
         * automation or API caller reaches the doors by skipping a dialog.
         */
        confirm: z.boolean().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    open: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: LockControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI lock buttons
   * read `state` and disable themselves during `locking`/`unlocking`
   * transitions.
   */
  runtimeState: LockControlStatusSchema,
  customize: lockControlCustomize,

  /**
   * Runtime-state durability: **restored** — a lock left locked must still read locked.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): the lock's state as an `enum` series — change-only, no
   * floor: a jam or an unlock lasting seconds is the edge an operator looks for.
   */
  history: { fields: { state: { kind: 'enum' } } },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type ILockControlProvider = InferProvider<typeof lockControlCapability>
