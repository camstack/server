import { z } from 'zod'

/**
 * Adoption job — the background form of `device-adoption.adopt`.
 *
 * ## Why this exists
 *
 * `adopt({childNativeIds: [...]})` materialises one CamStack device per
 * candidate PLUS every accessory child, and the whole array shares ONE UDS
 * request deadline (60s). Measured on the live hub against Home Assistant:
 * each device the kernel creates costs ~450 ms — `devices.create` pre-seeds
 * meta with up to eleven SEQUENTIAL round trips (`setName`, `setType`,
 * `setRole`, … `persistConfig`) before the class is constructed — and an
 * accessory child costs the same as its parent. So the real unit of work is
 * the CHILD, not the candidate:
 *
 * - 25 candidates averaging 6 children  → ~150 devices → **>60s, times out**
 * - ONE candidate with 217 children     → ~217 devices → **>60s, times out**
 *
 * That second line is why this is a job and not a smaller batch. No chunking,
 * no bounded concurrency over candidates and no per-call tuning can fix a
 * shape where **N=1 already exceeds the deadline** — the count that blows the
 * budget is the source system's accessory fan-out, which the operator does not
 * choose and cannot see. A design that only works below some N is the same bug
 * deferred.
 *
 * ## What the timeout did NOT do
 *
 * It did not stop the work. The UDS deadline ends the CALLER's wait; the
 * provider's loop runs to completion. Measured: a 25-candidate adopt that
 * "failed" at 60s had adopted 17 by 87s and all 25 by ~130s. The operator saw
 * an error and had no way to learn that. Every field below exists so that
 * question has an answer.
 *
 * ## Idempotency
 *
 * Jobs are in-RAM; a restart forgets them. That is safe here because adoption
 * is keyed by a stable id (`ha:<broker>:dev:<nativeId>` and equivalents), so
 * re-running a job re-adopts nothing: an already-adopted candidate is SKIPPED
 * by the engine before any provider call and lands in `alreadyAdopted`. It is
 * never a duplicate device, and never an error the operator has to interpret.
 */
export const AdoptionJobStateSchema = z.enum(['running', 'done', 'failed', 'cancelled'])
export type AdoptionJobState = z.infer<typeof AdoptionJobStateSchema>

/**
 * Per-candidate result. Every candidate the job was asked to adopt ends in
 * exactly one of these buckets — there is no silent drop, and the operator can
 * always answer "which of my 25 landed?".
 *
 * - `adopted` — created now by this job.
 * - `already-adopted` — a device for this candidate existed before the job
 *   reached it (a re-run, or a retry after a timeout). Not an error.
 * - `failed` — the provider threw; `error` carries the message.
 * - `cancelled` — the operator cancelled before this candidate was reached.
 */
export const AdoptionOutcomeSchema = z.enum(['adopted', 'already-adopted', 'failed', 'cancelled'])
export type AdoptionOutcome = z.infer<typeof AdoptionOutcomeSchema>

export const AdoptionCandidateResultSchema = z.object({
  childNativeId: z.string(),
  outcome: AdoptionOutcomeSchema,
  /** The materialised parent device id — null for `failed` / `cancelled`. */
  parentDeviceId: z.number().int().nonnegative().nullable(),
  /** Accessory children created for this candidate. */
  accessoryCount: z.number().int().nonnegative(),
  /** Failure message; null unless `outcome === 'failed'`. */
  error: z.string().nullable(),
})
export type AdoptionCandidateResult = z.infer<typeof AdoptionCandidateResultSchema>

export const AdoptionJobSchema = z.object({
  jobId: z.string(),
  /** The integration provider this job adopts through (the `addonId` pin). */
  addonId: z.string(),
  integrationId: z.string(),
  state: AdoptionJobStateSchema,
  /** Candidates the job was asked to adopt. Known up front, so never null. */
  total: z.number().int().nonnegative(),
  /** Candidates that have reached a terminal bucket. */
  processed: z.number().int().nonnegative(),
  adopted: z.number().int().nonnegative(),
  alreadyAdopted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Accessory child devices created across every candidate — the real unit
   *  of work, surfaced so a slow job is legible rather than mysterious. */
  accessoriesCreated: z.number().int().nonnegative(),
  /** The candidate currently being adopted; null when idle or finished. */
  currentChildNativeId: z.string().nullable(),
  /** One entry per candidate, in the order they were processed. */
  results: z.array(AdoptionCandidateResultSchema).readonly(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** Set only when the job itself broke (not a per-candidate failure). */
  error: z.string().nullable(),
})
export type AdoptionJob = z.infer<typeof AdoptionJobSchema>
