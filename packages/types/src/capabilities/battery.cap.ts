import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Battery status snapshot. Emitted by providers whose device is
 * battery-operated (cameras with `DeviceFeature.BatteryOperated`,
 * future sensor/button accessories). Consumers build their own "low
 * battery" alerting on top — the cap deliberately does NOT enforce a
 * threshold.
 */
export const BatteryStatusSchema = z.object({
  /**
   * 0..100 inclusive, firmware-reported. **`null` means NOT YET KNOWN** — the
   * provider has registered the capability but no reading has landed.
   *
   * It is nullable because it was not, and the only value a provider could
   * seed with was `0`. A battery camera behind an NVR therefore announced
   * itself at 0% on every start and corrected itself a moment later, which is
   * indistinguishable from a real flat battery: it fires the low-battery alert
   * every time the hub restarts. Unknown is not empty (D315), and on a battery
   * reading the difference is an alarm.
   *
   * `vacuum-control` and `lawn-mower-control` already model it this way.
   * Consumers must SKIP a null rather than coerce it — `battery-band` already
   * declines to band a non-finite reading, which is the correct shape.
   */
  percentage: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .meta(readingMeta('percentage', { label: 'Charge' })),
  /**
   * Charging source. `'dc'` covers wall/USB adapters; `'solar'` is
   * Reolink-specific for the Solar Panel 2 accessory (will become
   * common on other battery cams). `'none'` means running on battery
   * alone — a NEGATIVE the firmware actually reported.
   *
   * `'unknown'` is the absence of an answer: the provider has not read the
   * power fields yet, or the firmware reported neither. Before it existed,
   * two unreadable fields produced `'none'`, and a camera nobody had reached
   * was drawn "on battery alone" — the same D315 defect `percentage` closed
   * by going nullable. Consumers SKIP it (no charger state published, no
   * glyph, no HomeKit ChargingState) rather than coerce it either way.
   */
  charging: z.enum(['dc', 'solar', 'none', 'unknown']).meta({ label: 'Charging source' }),
  /**
   * True when the camera firmware has gone into low-power mode. Battery
   * providers MUST avoid polling during sleep — reading the battery
   * wakes the camera up and drains charge.
   */
  sleeping: z.boolean().meta({ label: 'Sleeping' }),
  /** Ms epoch of the last observation. Lets consumers reason about freshness. */
  lastUpdated: z.number().meta(readingMeta('none')),
  /**
   * Battery voltage in volts, for a cell the firmware reports as voltage
   * rather than a percentage (Ecowitt capacitor packs). Absent on cameras
   * that only report charge. A second reading on this cap, not a second
   * `numeric-sensor` on the same device.
   */
  volts: z
    .number()
    .nullable()
    .optional()
    .meta(readingMeta('voltage', { label: 'Voltage' })),
  /**
   * Ms epoch of the last time the device PROVED it was reachable — a
   * completed firmware round-trip, an observed wake, or an inbound push
   * (firmware event, email). `0`/absent = never since this slice was born.
   *
   * This is the ONLY input that separates "asleep" from "gone", and it is
   * fed exclusively by PASSIVE signals: nothing may write it by reaching
   * for the radio, because a poll that confirms reachability is the same
   * poll that drains the battery. See {@link deriveBatteryPresence} — the
   * single derivation every consumer must use; no surface computes its own.
   *
   * It is deliberately NOT a clock in the
   * `scripts/check-runtime-state-durability.ts` sense: it is the
   * observation itself, and it is the only thing a 30-hour silence is
   * visible in. Writers quantise it (see `CONTACT_WRITE_QUANTUM_MS` in the
   * Reolink provider) so a value that means "recently" cannot cost a
   * SQLite commit per round-trip.
   */
  lastContactAt: z.number().optional(),
  /**
   * Ms epoch of the last COMPLETE scheduled refresh — every fact the provider
   * holds for the device (level, charging, link, device info, state slices) and
   * its cached snapshot, read together. Absent = never since this slice was
   * born. Unlike `lastUpdated` (any write, even a push of one field) this is
   * the staleness an operator can trust: the provider owns the device fact and
   * so owns the window on its age (D224, D847). Not a clock in the
   * runtime-state-durability sense: it moves once per window and must survive
   * a restart, or every restart would owe the camera a wake.
   */
  lastFullRefreshAt: z.number().optional(),
  /**
   * True when the source is a BINARY low-battery indicator (HA
   * `binary_sensor` device_class=battery / `LOW_BAT`) that has no real
   * charge level — `percentage` is then a coarse stand-in (100 = normal,
   * sub-threshold = low). UI MUST render "Normal"/"Low" instead of a
   * misleading exact percentage. Absent/false → genuine 0–100 % reading.
   */
  binary: z.boolean().optional().meta({ label: 'Binary indicator' }),
})

export type BatteryStatus = z.infer<typeof BatteryStatusSchema>

const BATTERY_DEVICE_TYPES = [
  DeviceType.Camera,
  DeviceType.Sensor,
  DeviceType.Button,
  DeviceType.Switch,
  DeviceType.PetFeeder,
  DeviceType.Container,
  DeviceType.Thermostat,
] as const

/** Generic Customize target for the percentage reading (D936). */
const batteryCustomize = {
  version: 1,
  targets: [
    {
      id: 'percentage',
      cardinality: 'scalar',
      vocabulary: { cap: 'battery', stateField: 'percentage' },
      deviceTypes: BATTERY_DEVICE_TYPES,
      apply: 'add',
      path: 'percentage',
      sources: [
        {
          kind: 'field',
          valueKinds: ['number', 'string'],
          transforms: [
            { kind: 'identity' },
            { kind: 'linear', defaultScale: 1, defaultOffset: 0, clampMin: 0, clampMax: 100 },
          ],
        },
      ],
      companions: [
        { kind: 'constant', path: 'charging', value: 'unknown', when: 'add' },
        { kind: 'constant', path: 'sleeping', value: false, when: 'add' },
        { kind: 'clock', path: 'lastUpdated', when: 'add' },
      ],
      sourceReport: { status: 'assignment-status' },
      advancedExpression: true,
    },
  ],
} as const satisfies CapabilityCustomizeSpec

export const batteryCapability = {
  name: 'battery',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: BATTERY_DEVICE_TYPES,
  methods: {
    /**
     * Explicitly wake the camera from low-power sleep ahead of a
     * streaming session start. Consumers that initiate a stream
     * against a sleeping battery cam (HomeKit Secure Video, Alexa
     * RTCSession, snapshot wrappers) call this with a short timeout
     * before establishing the media pipeline — the broker's own
     * passive wake-on-dial works but adds 5–7 seconds to first-frame,
     * during which the consumer renders a black screen. Pre-waking
     * compresses that gap.
     *
     * Returns `awoke: true` when the firmware acknowledged the wake
     * before `timeoutMs`. Returns `awoke: false` when it timed out OR
     * the cap surface is unavailable (no Baichuan / firmware
     * channel); the caller should still attempt the stream — the
     * passive broker wake remains as fallback.
     */
    wakeForStream: method(
      z.object({
        deviceId: z.number(),
        /** Bound on the wait. Sensible range 3000–10000ms. */
        timeoutMs: z.number().int().min(500).max(30_000).default(8_000),
      }),
      z.object({
        awoke: z.boolean(),
        durationMs: z.number(),
      }),
      { kind: 'mutation' },
    ),
  },
  /**
   * A composed provider (battery ADDED to a pet feeder or container that has
   * no wake surface) answers `wakeForStream` with the same "unavailable"
   * result the contract already defines above: "Returns `awoke: false` when
   * … the cap surface is unavailable." (D663).
   */
  composedMethods: {
    wakeForStream: { kind: 'answer', value: { awoke: false, durationMs: 0 } },
  },
  events: {
    /**
     * Emitted whenever the cached status changes (firmware push OR
     * poll observes a delta). The DeviceEventPropagator mirrors this
     * event on the parent chain — subscribing to a camera's source
     * receives battery events from child accessories automatically.
     */
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: BatteryStatusSchema,
      }),
    },
  },
  status: {
    schema: BatteryStatusSchema,
    kind: 'push',
    // Unknown, never 0 % (D315, D663): the same cold-seed defect this schema's
    // `percentage` doc already explains. No live consumer reads this as a
    // number — `device-aggregation.ts` only checks its presence (D663).
    empty: { percentage: null, charging: 'unknown', sleeping: false, lastUpdated: 0 },
  },
  /**
   * Runtime-state slice — every provider that registers this cap
   * stores the same shape under `device.runtimeState[battery]`.
   * Cross-provider uniformity: a Reolink Argus, a sensor proxy,
   * an ONVIF battery cam all read/write the same keys.
   * Consumers (BatteryBadge, snapshot wrapper sleep gate) read once
   * via `device.runtimeState.getCapState('battery')` regardless of
   * the underlying driver.
   */
  runtimeState: BatteryStatusSchema,

  /**
   * Runtime-state durability: **restored** — a sleeping battery camera may not report for hours; the restored percentage is the only thing the UI and the sleep gate have. Zero churn once `lastUpdated` is excluded — 526 writes, 0 value changes, in 25 minutes.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. The generic capture replaces the `battery` series of `pipeline-analytics:stats-5m`.
   */
  history: {
    fields: {
      percentage: { kind: 'gauge', unit: '%' },
      volts: { kind: 'gauge', unit: 'V' },
    },
  },
  customize: batteryCustomize,
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastUpdated'],
} as const satisfies CapabilityDefinition

export type IBatteryProvider = InferProvider<typeof batteryCapability>
