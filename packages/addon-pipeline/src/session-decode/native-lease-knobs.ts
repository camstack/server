/**
 * The native-lease knobs AS THE DECODE WORKER RECEIVES THEM — the wire shape,
 * its guard, and the one-line spawn diagnostic. Child-safe by construction:
 * this module imports nothing but TYPES from `@camstack/types`.
 *
 * ## Why this is not `native-lease-config.ts`
 *
 * That module resolves the knobs — operator setting > env var > shipped
 * default — and needs the Zod schemas to do it. Until D453 the CHILD did that
 * resolution at module load, from env vars the parent wrote at fork time, and
 * so the child bundle inlined the whole `@camstack/types` index (1.5 MB, every
 * cap's schema) for three symbols. Measured on the hub, 2026-09-11, same
 * environment as the runner: fork → first IPC reply **195 ms and 200 MB RSS**
 * with that chunk, **65 ms and 63 MB** without it. That chunk was most of the
 * "unattributed" cold-start cost `forkToFrameMs` could never name.
 *
 * So the split is: the parent RESOLVES (it already has the schemas loaded),
 * the child RECEIVES the resolved values on `start` and validates their shape
 * with the same hand-written guards every other protocol field uses. A
 * pre-forked worker (the zygote pool, `decode-worker-pool.ts`) is possible only
 * because of this: a child that read its knobs at module load was bound to the
 * configuration it was born with.
 *
 * `scripts/check-decode-worker-child-lean.ts` fails the build if any module
 * reachable from the child entry imports a VALUE from `@camstack/types`.
 */
import type {
  NativeLeaseAdmission,
  NativeLeaseKnob,
  NativeLeaseNumberKnob,
  NativeLeaseSettings,
} from '@camstack/types'

export type { NativeLeaseKnob } from '@camstack/types'

/** Every knob, in the order the spawn line names them. */
export const NATIVE_LEASE_KNOB_NAMES: readonly NativeLeaseKnob[] = [
  'holdFrames',
  'budgetMb',
  'activityMs',
  'admission',
  'tileBudgetMb',
  'sceneBudgetMb',
]

/** The numeric knobs — every knob but `admission`. */
export const NATIVE_LEASE_NUMBER_KNOBS: readonly NativeLeaseNumberKnob[] = [
  'holdFrames',
  'budgetMb',
  'activityMs',
  'tileBudgetMb',
  'sceneBudgetMb',
]

/** Where a resolved knob's value came from. Reported in the worker's spawn log. */
export type NativeLeaseKnobSource = 'setting' | 'env' | 'default'

const KNOB_SOURCES: readonly NativeLeaseKnobSource[] = ['setting', 'env', 'default']

/**
 * The knobs in force for ONE decode session: every value plus the level it was
 * resolved at. Built by the parent (`resolveNativeLeaseKnobs`), carried on the
 * `start` message, frozen for the life of the session — a knob that can change
 * after the first frame is a knob with two values during a session.
 */
export interface WorkerLeaseKnobs {
  readonly values: NativeLeaseSettings
  readonly sources: Readonly<Record<NativeLeaseKnob, NativeLeaseKnobSource>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isAdmission(value: unknown): value is NativeLeaseAdmission {
  return value === 'all' || value === 'inferred'
}

function isKnobSource(value: unknown): value is NativeLeaseKnobSource {
  return typeof value === 'string' && KNOB_SOURCES.some((s) => s === value)
}

/**
 * Shape guard for the wire. The parent already bounded every value through the
 * knob's own Zod schema; what is checked here is what a store constructor would
 * otherwise turn into a silent misconfiguration — a non-integer, a negative
 * budget, a hold of zero (a worker that holds nothing can crop nothing), an
 * admission word that is neither mode, a source that names no level.
 */
export function isWorkerLeaseKnobs(value: unknown): value is WorkerLeaseKnobs {
  if (!isRecord(value) || !isRecord(value.values) || !isRecord(value.sources)) return false
  const { values, sources } = value
  for (const knob of NATIVE_LEASE_NUMBER_KNOBS) {
    if (!isNonNegativeInteger(values[knob])) return false
  }
  if (!isNonNegativeInteger(values.holdFrames) || values.holdFrames < 1) return false
  if (!isAdmission(values.admission)) return false
  return NATIVE_LEASE_KNOB_NAMES.every((knob) => isKnobSource(sources[knob]))
}

/**
 * The one-line spawn diagnostic. Names the effective value AND its source for
 * every knob: without the source, a log saying `holdFrames=8` cannot distinguish
 * "the operator's setting arrived" from "someone left a shell variable set", and
 * a setting that silently fails to arrive is exactly the failure the source
 * field exists to make visible.
 */
export function formatNativeLeaseKnobs(resolved: WorkerLeaseKnobs): string {
  const part = (knob: NativeLeaseKnob): string =>
    `${knob}=${resolved.values[knob]} source=${resolved.sources[knob]}`
  return `native lease knobs — ${NATIVE_LEASE_KNOB_NAMES.map(part).join('; ')}`
}
