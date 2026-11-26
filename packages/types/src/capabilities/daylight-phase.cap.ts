import { z } from 'zod'
import { DaylightPhaseReadingSchema, DaylightSettingsSchema } from '../time/daylight-phase.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * daylight-phase - the ONE authority on whether it is day or night (planning#736).
 *
 * Source `sun` (the default): sunrise and sunset at the site, as every
 * consumer read them before. Source `sensor`: one device reading decides, with
 * a dark threshold, a hysteresis band and a minimum dwell. When the sensor
 * cannot be read the authority answers with the sun and SAYS so
 * (`fallbackReason`); it never keeps a stale sensor verdict.
 *
 * `getPhase` is the truth. A transition is also published as an event
 * (`daylight.phase-changed`), but events are telemetry (D8): a consumer that
 * must be right reads `getPhase` (at boot, on that event, and on its own
 * bounded re-check), never a value it kept from an event.
 *
 * Provided by the core-blocks builtin on the hub, beside `schedulers`, the
 * first consumer. The settings are a cluster-wide singleton row.
 */
export const DaylightStatusSchema = z.object({
  /** The phase in force and when it began; null when the sun is the source and the site has no location. */
  phase: DaylightPhaseReadingSchema.nullable(),
  /** What the operator configured (it may differ from `phase.source` during a fallback). */
  configured: DaylightSettingsSchema,
  /** Why the sun answers although a sensor is configured; null when nothing is wrong. */
  fallbackReason: z.string().nullable(),
  /** When this answer was judged, epoch ms. */
  checkedAt: z.number(),
})
export type DaylightStatus = z.infer<typeof DaylightStatusSchema>

export const daylightPhaseCapability = {
  name: 'daylight-phase',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** The phase now, when it began, and which source decided it. */
    getPhase: method(z.object({}), DaylightStatusSchema),
    /** The configured source (and sensor, threshold, hysteresis, dwell). */
    getSettings: method(z.object({}), DaylightSettingsSchema),
    /** Change the source. A sensor that cannot be read is accepted: the sun answers and the status says why. */
    setSettings: method(DaylightSettingsSchema, DaylightStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  vocabulary: {
    notOperatorFacing:
      'the day/night phase authority — configured in System settings, not a device action',
  },
} as const satisfies CapabilityDefinition

export type IDaylightPhaseProvider = InferProvider<typeof daylightPhaseCapability>
