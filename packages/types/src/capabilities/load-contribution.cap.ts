/**
 * `load-contribution` — the capability an addon reports its OWN cost through,
 * already attributed. It stores nothing.
 *
 * ## Why this exists, and why it is not a pid→camera map
 *
 * Four of the five load families in
 * `packages/addon-admin-ui/src/components/cluster/load/camera-load-attribution.ts`
 * are per-camera by construction — one forked decode worker per decode
 * session, one ffmpeg per (camera, encode plan), one ffmpeg per (camera,
 * recording profile), one ffmpeg ingest per camera source — and none could be
 * READ per camera. The obvious repair is to surface each child's pid so an
 * observer can join it against the OS process table. That repair is wrong
 * here, for a reason worth writing down:
 *
 *  - the join needs an entity with GLOBAL knowledge (which pid belongs to
 *    which camera, for every addon), and every such entity is a list that a
 *    new addon has to be added to — the failure mode of a central list is that
 *    nothing breaks, the operator simply never sees what somebody added;
 *  - the pair has to be shipped somewhere it can outlive the process it
 *    describes, and pids are recycled. A stale entry charges one camera for
 *    another camera's work, silently and plausibly. This repo has already paid
 *    for a registry that answered while the truth was elsewhere (D49).
 *
 * The recorder does not need to be told which camera its ffmpeg serves. It
 * spawned it. So each addon reports what it already knows, and no entity needs
 * global knowledge. The shape is copied from `log-channels.cap.ts` /
 * `log-destination.cap.ts` (`mode: 'collection'`, `internal: true`,
 * `mount: { kind: 'skip' }`): no tRPC route, no generated hooks, while
 * `addons.listCapabilityProviders` still enumerates it and the hub's
 * `CapabilityRegistry` still holds an RPC proxy per provider, so a forked
 * runner's entries reach hub-main over transport that already exists. No new
 * UDS message, no second registry (D3).
 *
 * ## The external observer still has a job
 *
 * `metrics.node-processes-snapshot` measures every camstack-shaped process on
 * the node whether or not anybody claims it. Contributions cover what the
 * addons know about; the snapshot covers what is actually running. **The
 * difference is the finding** — a process nobody claims is either a leak or a
 * cost family nobody has taught to report, and both are worth seeing. So an
 * unclaimed process stays in an "unattributed" bucket and is never folded into
 * a neighbour.
 *
 * ## Absent, never zero
 *
 * Every measurement here is optional. An addon that cannot produce a number
 * omits it, and the consumer reads UNKNOWN. A zero would say "this camera cost
 * nothing", which is a measurement, and a measurement nobody made is the one
 * thing this whole surface exists to prevent.
 *
 * ## Detection declares its own renunciation
 *
 * The shared inference pool is one process per (node, runtime, hardware
 * device) serving every camera. It contributes an entry with `deviceId: null`
 * and `attribution: 'unattributable'` — the giving-up is DATA, reported by the
 * only component that knows it, rather than a deduction an observer makes.
 * `isChartablePerCamera` keeps refusing it.
 */

import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * The load families an addon can report. Kept as a tuple so the Zod enum and
 * the TypeScript union have one source.
 *
 * `detection` is a member on purpose — see the module docblock. It is the one
 * role that reports itself as unattributable.
 */
export const LOAD_CONTRIBUTION_ROLES = [
  'decode',
  'transcode',
  'recording',
  'streaming',
  'detection',
] as const

export type LoadContributionRole = (typeof LOAD_CONTRIBUTION_ROLES)[number]

/**
 * How well the reporting addon can tie this entry to ONE camera. The
 * contributor decides, because the contributor is the only one who knows.
 *
 * - `measured` — the numbers on this entry are this camera's, measured. The
 *   entry owns a process (or an equivalent exclusive resource) that serves
 *   exactly one camera.
 * - `accounted` — per-camera work really is COUNTED (frames submitted,
 *   inference milliseconds), but the cost is shared and can only ever be
 *   apportioned. A consumer must label it as a share, never as a cost.
 * - `unattributable` — no camera owns this. Reported anyway, with
 *   `deviceId: null`, so the shared cost is visible as shared instead of
 *   invisible.
 */
export const LOAD_CONTRIBUTION_ATTRIBUTIONS = ['measured', 'accounted', 'unattributable'] as const

export type LoadContributionAttribution = (typeof LOAD_CONTRIBUTION_ATTRIBUTIONS)[number]

const LoadContributionSchema = z.object({
  role: z.enum(LOAD_CONTRIBUTION_ROLES),
  /**
   * The NUMERIC device id — the same value every log line carries as
   * `tags.deviceId`. `null` means this cost genuinely belongs to no single
   * camera (a shared pool), NOT that the contributor forgot to look it up: a
   * contributor that cannot name its camera must not emit the entry at all,
   * because an unnamed per-camera entry is indistinguishable from a shared one
   * and would quietly turn one camera's cost into everybody's.
   */
  deviceId: z.number().int().positive().nullable(),
  attribution: z.enum(LOAD_CONTRIBUTION_ATTRIBUTIONS),
  /**
   * What ONE entry is, in the contributor's own words — `101/high`,
   * `102/native`, `cuda:0 shared pool`. Free text because the unit differs per
   * family and inventing a common one would lose the only information that
   * makes two entries for the same camera distinguishable.
   */
  unit: z.string(),
  /**
   * The OS process this cost lives in, when there is one. Present so a
   * consumer can (a) tell two generations of the same unit apart across a
   * restart, and (b) subtract claimed processes from the node's process
   * snapshot to see what NOBODY claimed. Absent for an entry that owns no
   * process of its own.
   */
  pid: z.number().int().positive().optional(),
  /**
   * When this generation started. The pid's incarnation marker: a consumer
   * differencing {@link LoadContributionSchema.shape.cpuSeconds} must drop the
   * window when this changes, because the counter restarted from zero in a new
   * process.
   */
  startedAtMs: z.number().optional(),
  /**
   * CUMULATIVE CPU seconds this unit has consumed since it started — user +
   * system, read from the child's own `/proc/<pid>/stat` at the moment the
   * contribution is asked for.
   *
   * Cumulative and not a rate on purpose: a rate needs a window, a window
   * needs a sampler, and a new per-node sampler is the defect half of
   * `docs/architecture/load-ledger.md` documents. A counter can be differenced
   * by whoever already keeps a history; a rate cannot be un-averaged.
   *
   * Absent — never zero — on a node with no `/proc`, on a read failure, and on
   * an entry with no process.
   */
  cpuSeconds: z.number().optional(),
  /** Resident bytes of this unit's process, same source and same rules. */
  rssBytes: z.number().optional(),
})

export type LoadContribution = z.infer<typeof LoadContributionSchema>

export const loadContributionCapability = {
  name: 'load-contribution',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * This addon's own cost entries, computed live from state it already
     * holds. Inert: no persistence, no sampling, no timer. It is answered on
     * whatever beat the caller already has.
     */
    list: method(z.void(), z.array(LoadContributionSchema).readonly()),
  },
  /** In-process only — enumerated through `addons.listCapabilityProviders`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type ILoadContributionProvider = InferProvider<typeof loadContributionCapability>

export { LoadContributionSchema }
