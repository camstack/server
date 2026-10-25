import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/** A rise closer than this to the previous one is the same press (D671). */
export const DOORBELL_RISE_DEBOUNCE_MS = 2_000

/** Pulse override: a rising edge advances `lastPressedAt` and the press count. */
const doorbellCustomize = {
  version: 1,
  targets: [
    {
      id: 'pressed',
      cardinality: 'event',
      shape: 'pulse',
      vocabulary: { cap: 'doorbell', eventName: 'onPressed' },
      deviceTypes: [DeviceType.Camera],
      apply: 'add',
      applyAuthority: { kind: 'composition-claim' },
      eventName: 'onPressed',
      edges: ['rising'],
      timestampPath: 'lastPressedAt',
      counterPath: 'pressCountSinceStart',
      highWater: 'composer-advance',
      combine: 'any',
      debounce: {
        kind: 'rising-edge',
        defaultDebounceMs: DOORBELL_RISE_DEBOUNCE_MS,
        changedAtRequired: true,
      },
      sources: [{ kind: 'binary' }, { kind: 'switch' }],
      sourceReport: { status: 'assignment-status' },
      advancedExpression: true,
    },
  ],
} as const satisfies CapabilityCustomizeSpec

export const DoorbellStatusSchema = z.object({
  /** Ms epoch of the last press. null = never observed since this provider started. */
  lastPressedAt: z.number().nullable(),
  /** Counter since provider start. Resets on reboot. Useful for metrics/debug. */
  pressCountSinceStart: z.number(),
})

export type DoorbellStatus = z.infer<typeof DoorbellStatusSchema>

export const DoorbellPressEventSchema = z.object({
  deviceId: z.number(),
  timestamp: z.number(),
})

export type DoorbellPressEvent = z.infer<typeof DoorbellPressEventSchema>

/**
 * Doorbell button cap. Two kinds of provider serve it, and to every consumer
 * they are the same cap:
 *
 *   - **Native** providers, registered per device by a driver addon through
 *     `ctx.registerNativeCap` — a `DeviceType.Button` accessory with
 *     `role: DeviceRole.Doorbell`, or the camera itself (Reolink registers at
 *     camera level). They emit `onPressed` on every firmware ring.
 *   - **A composed doorbell** (D670, D671): a camera's customization gives it
 *     the cap, its `lastPressedAt` rising from the sources the operator
 *     assigned in Customize → Doorbell, and the composer emits `onPressed`
 *     from that field's advance (`fromState`).
 *
 * The DeviceEventPropagator re-emits `onPressed` on the camera parent.
 */
export const doorbellCapability = {
  name: 'doorbell',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Button, DeviceType.Camera],
  methods: {},
  events: {
    /**
     * Fires once per physical press. Reolink delivers via Baichuan
     * push (`ReolinkSimpleEvent.type === 'doorbell'`). There is no
     * release/duration — it's a pulse.
     */
    onPressed: {
      data: DoorbellPressEventSchema,
      fromState: { field: 'lastPressedAt', on: 'advance' },
    },
  },
  status: {
    schema: DoorbellStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — last press timestamp + lifetime press count.
   * Mirrored by the kernel and readable via
   * `device.state.doorbell.value`. UIs can show "last ring 5m ago"
   * without subscribing.
   */
  runtimeState: DoorbellStatusSchema,

  /**
   * Runtime-state durability: **restored** — a monotonic accumulator: the slice IS the record. `lastPressedAt` is content here, not a clock, so it is deliberately NOT volatile.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — `pressCountSinceStart` resets with the addon, so it is not a monotonic meter; presses live in the events ledger.
   */
  history: 'none',
  customize: doorbellCustomize,
} as const satisfies CapabilityDefinition

export type IDoorbellProvider = InferProvider<typeof doorbellCapability>
