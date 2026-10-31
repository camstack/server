import { z } from 'zod'
import { AutomationRunTraceSchema } from '../automation/trace.js'
import {
  LOCAL_DATE_PATTERN,
  SchedulerConflictSchema,
  SchedulerInputSchema,
  SchedulerPreviewSchema,
  SchedulerSchema,
  SchedulerStatusSchema,
} from '../automation/scheduler.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * schedulers — timelines of edge and hold points that perform actions over the
 * day (D983). Provided by the core-blocks builtin on the hub, beside `actions`:
 * the same runs ledger (owner `scheduler:<id>`), the same target resolver, the
 * same step runner.
 *
 * The hub runs ONE timer for the next point across every scheduler. A save is
 * refused with its reason (`[invalid-scheduler] …`) when a hold has a step that
 * leads to no state, or a sun point has no site location to read.
 */
const SchedulerIdInput = z.object({ schedulerId: z.string().min(1) })

export const schedulersCapability = {
  name: 'schedulers',
  scope: 'system',
  mode: 'singleton',
  methods: {
    list: method(z.object({}), z.array(SchedulerSchema), { auth: 'admin' }),
    get: method(SchedulerIdInput, z.object({ scheduler: SchedulerSchema.nullable() }), {
      auth: 'admin',
    }),
    create: method(
      z.object({ scheduler: SchedulerInputSchema }),
      z.object({ scheduler: SchedulerSchema }),
      {
        kind: 'mutation',
        auth: 'admin',
      },
    ),
    /** Replace a scheduler with the edited one. The id and creation time stay. */
    update: method(
      z.object({
        schedulerId: z.string().min(1),
        scheduler: SchedulerInputSchema,
      }),
      z.object({ scheduler: SchedulerSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    delete: method(SchedulerIdInput, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * The scheduler's manual switch, or one profile's when `profileId` is given.
     * Turning it off suspends any hold (nothing is reversed) and skips its edges.
     */
    setEnabled: method(
      z.object({
        schedulerId: z.string().min(1),
        profileId: z.string().min(1).optional(),
        enabled: z.boolean(),
      }),
      z.object({ scheduler: SchedulerSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * The resolved timeline of one site-local day (default today): which
     * profile is in force and when each point happens.
     */
    preview: method(
      z.object({
        schedulerId: z.string().min(1),
        date: z.string().regex(LOCAL_DATE_PATTERN).optional(),
      }),
      SchedulerPreviewSchema,
      { auth: 'admin' },
    ),
    /**
     * Holds of `scheduler` (a draft, or a saved one when `schedulerId` names
     * it) that overlap another scheduler's hold on the same device with a
     * different effect, with both priorities.
     */
    conflicts: method(
      z.object({
        scheduler: SchedulerInputSchema,
        schedulerId: z.string().min(1).optional(),
      }),
      z.object({ conflicts: z.array(SchedulerConflictSchema) }),
      { auth: 'admin' },
    ),
    /** Where each scheduler's current hold stands. */
    getStatus: method(z.object({}), z.array(SchedulerStatusSchema), {
      auth: 'admin',
    }),
    getTraces: method(SchedulerIdInput, z.object({ traces: z.array(AutomationRunTraceSchema) }), {
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type ISchedulersProvider = InferProvider<typeof schedulersCapability>
