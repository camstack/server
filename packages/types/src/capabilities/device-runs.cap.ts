import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * device-runs - the durable record of ONE run of a device: a washing cycle, a
 * dishwasher cycle, later a mow or a clean (D992).
 *
 * A run is a DOCUMENT (opened at one instant, closed at another, carrying what
 * was measured over it), never a sample - device-history keeps the numbers over
 * time and its `device-runs` provider keeps these documents beside them, because
 * the energy of a run is a question about device-history's own series. The
 * record is written from the `running-state` flip on `DeviceStateChanged`; it
 * survives a restart (the open row is on disk) and a missed flip (boot compares
 * the open rows against the live snapshots).
 *
 * Every measurement is `number | null` and `null` means "could not be
 * measured", never `0` (D393). A run closed by the boot reconcile because the
 * device stopped while nobody was watching has `outcome: 'unknown'`.
 */

export const DeviceRunKindSchema = z.enum(['appliance', 'mower', 'vacuum'])
export type DeviceRunKind = z.infer<typeof DeviceRunKindSchema>

export const DeviceRunStateSchema = z.enum(['open', 'closed'])
export type DeviceRunState = z.infer<typeof DeviceRunStateSchema>

export const DeviceRunOutcomeSchema = z.enum(['completed', 'aborted', 'error', 'unknown'])
export type DeviceRunOutcome = z.infer<typeof DeviceRunOutcomeSchema>

/** What opened or closed the run. `reconcile` is the boot comparison against live state. */
export const DeviceRunSourceSchema = z.enum(['running-state', 'activity', 'reconcile'])
export type DeviceRunSource = z.infer<typeof DeviceRunSourceSchema>

/** How the energy of a run was obtained; `null` when it could not be. */
export const DeviceRunEnergyMethodSchema = z.enum(['counter-delta', 'history-integral'])
export type DeviceRunEnergyMethod = z.infer<typeof DeviceRunEnergyMethodSchema>

export const DeviceRunPhaseSchema = z.object({
  phase: z.string(),
  at: z.number(),
})
export type DeviceRunPhase = z.infer<typeof DeviceRunPhaseSchema>

/** What an appliance run measured. Every number is `null` when unknown, never `0`. */
export const ApplianceRunDetailSchema = z.object({
  kind: z.literal('appliance'),
  /** kWh used over the run. */
  energyKwh: z.number().nullable().meta(readingMeta('energy')),
  energyMethod: DeviceRunEnergyMethodSchema.nullable(),
  /** Highest power seen while the run was open. */
  peakW: z.number().nullable().meta(readingMeta('power')),
  /** Time-weighted mean power while the run was open. */
  avgW: z.number().nullable().meta(readingMeta('power')),
  /** The program the appliance said it ran when the run opened. */
  program: z.string().nullable(),
  remainingAtStartSec: z.number().nullable().meta(readingMeta('duration')),
  /** The last phase the device reported before the run closed. */
  finalPhase: z.string().nullable(),
  /**
   * The meter's energy counter when the run opened; `null` when the meter had
   * not said (or the run was opened late, by the boot reconcile). It lives in
   * the row so a run that outlives a restart still ends with `end - start`.
   */
  energyStartKwh: z.number().nullable().meta(readingMeta('energy')),
  /** Milliseconds of power readings behind `avgW` - the weight a restart resumes the mean with. */
  powerObservedMs: z.number(),
})
export type ApplianceRunDetail = z.infer<typeof ApplianceRunDetailSchema>

/** The kind-specific block; a later phase adds a branch, nothing else changes. */
export const DeviceRunDetailSchema = z.discriminatedUnion('kind', [ApplianceRunDetailSchema])
export type DeviceRunDetail = z.infer<typeof DeviceRunDetailSchema>

export const DeviceRunSchema = z.object({
  /** `${deviceId}:${startedAt}`. */
  runId: z.string(),
  deviceId: z.number().int(),
  kind: DeviceRunKindSchema,
  state: DeviceRunStateSchema,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  outcome: DeviceRunOutcomeSchema.nullable(),
  startSource: DeviceRunSourceSchema,
  endSource: DeviceRunSourceSchema.nullable(),
  /** Where the device's running bit came from (`running-state.source`); `null` when it did not say. */
  runningSource: z.enum(['native', 'assigned']).nullable(),
  phases: z.array(DeviceRunPhaseSchema),
  detail: DeviceRunDetailSchema,
})
export type DeviceRun = z.infer<typeof DeviceRunSchema>

/** Runs of these types are recorded in P1. */
const DEVICE_RUNS_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
]

export const DEVICE_RUNS_MAX_PAGE = 200

export const deviceRunsCapability = {
  name: 'device-runs',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: DEVICE_RUNS_DEVICE_TYPES,
  methods: {
    /** Runs of a device, newest first. `limit` is bounded; page with `cursor`. */
    listRuns: method(
      z.object({
        deviceId: z.number().int(),
        outcome: DeviceRunOutcomeSchema.optional(),
        atFrom: z.number().optional(),
        atTo: z.number().optional(),
        limit: z.number().int().positive().max(DEVICE_RUNS_MAX_PAGE).default(50),
        cursor: z.string().optional(),
      }),
      z.object({
        runs: z.array(DeviceRunSchema).readonly(),
        nextCursor: z.string().nullable(),
      }),
    ),
    getRun: method(
      z.object({ deviceId: z.number().int(), runId: z.string() }),
      DeviceRunSchema.nullable(),
    ),
    /** The run open right now, or `null` (answered: there is none). */
    getCurrentRun: method(z.object({ deviceId: z.number().int() }), DeviceRunSchema.nullable()),
  },
  events: {
    onRunOpened: {
      data: DeviceRunSchema,
      notOperatorFacing:
        'the durable record of a run that the running-state start flip already announces',
    },
    onRunClosed: {
      data: DeviceRunSchema,
      notOperatorFacing:
        'the durable record of a run that the running-state finish flip already announces',
    },
  },
  vocabulary: { noun: t('Runs', 'Esecuzioni'), order: 2130 },
} as const satisfies CapabilityDefinition

export type IDeviceRunsProvider = InferProvider<typeof deviceRunsCapability>
