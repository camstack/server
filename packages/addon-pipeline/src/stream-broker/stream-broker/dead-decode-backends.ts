/**
 * "This decode backend cannot create a device in THIS process" — remembered
 * across children, not per child.
 *
 * ## The thing this stops
 *
 * `-hwaccel vaapi` works for the decoder addon on this hub (ten concurrent 4K
 * decodes) and returns ENOMEM inside the stream-broker runner: `code=244`,
 * "Device creation failed: -12 … Cannot allocate memory". Every egress child
 * therefore spends ~3 s dying before its own software retry rescues it.
 *
 * ## CORRECTION (2026-09-18): that `-12` was not a resource condition
 *
 * The two runners were not competing for a device — they were running
 * DIFFERENT BINARIES. The decoder addon reached a capable ffmpeg; the broker
 * reached the downloaded static build, which has no VAAPI compiled in at all
 * (`hwaccels: vdpau`). `-12` is what fftools prints when
 * `av_hwdevice_ctx_alloc` returns NULL because the type is not in the build:
 * the NAME parses, so the request looks valid and the device simply cannot
 * exist. It READS as a shortage and is a property of the binary (D536).
 *
 * That is why it "recurred forever on a hub where it has never once
 * succeeded": there was nothing to recover. The fix is upstream of this file —
 * `TranscodePipelineManager` now asks the binary (`ffmpeg -hwaccels`) and
 * refuses a backend it does not carry, so this quarantine never sees that
 * class of failure again.
 *
 * Everything below still stands for what remains: a backend the binary HAS and
 * the device still refuses. That one is a genuine runtime condition and can
 * clear, which is exactly why this is a quarantine and not a tombstone.
 *
 * That was already reported — `EgressTranscodeManager.onDecodeHwAccelFailed`
 * poisoned the broker's 60 s `egressHwAccelCache`. The memo is the wrong shape
 * for the verdict: it exists to avoid a per-session cross-process
 * `decoder.getInfo`, so it expires on a **read** cadence, and one minute later
 * the decoder answers `vaapi` again and the next cold child re-pays the death.
 * Measured on camera 101 on 2026-08-07: the hardware failure recurs at 22:17:07,
 * 22:18:42, 22:28:48, 22:30:52, 22:32:39, 22:34:07, 22:52:07 — once per memo
 * window, forever, on a hub where it has never once succeeded.
 *
 * ## Why this is a quarantine and not a tombstone
 *
 * A permanent verdict is wrong for the failure this file is now left with:
 * a device that exists in the build and still refuses is a RESOURCE condition,
 * and a resource condition can clear (the operator gives the container more of
 * the device, another process releases it). The build-property case — the one
 * that produced the measurements above — no longer reaches here at all. A process that decided "never again" at 03:00 would
 * still be decoding in software at noon with a working accelerator, and nothing
 * would ever say so.
 *
 * So the verdict LASTS and escalates: each consecutive failure of the same
 * backend widens its quarantine — 30 min, 2 h, then 6 h — so a hub where the
 * backend is genuinely dead pays one probe per six hours instead of one per
 * minute, while a hub where it recovers still finds out.
 *
 * The FIRST rung is deliberately not a minute. One report is already a strong
 * signal: the manager only reports a backend after its child produced ZERO
 * packets *and* the software retry proved the same argv otherwise works, which
 * is a statement about the backend and not about the source. And the cost of
 * being wrong is bounded and already being paid — the egress encodes with
 * `libx264` either way, so an over-long quarantine costs a software DECODE on a
 * path that is decoding in software today, 100 % of the time.
 *
 * The invalidations are motivated, and there are exactly three:
 *
 *  1. **The window elapses.** The next acquire probes hardware once. If it
 *     works, {@link DeadDecodeBackends.markAlive} clears the record and the
 *     escalation starts from zero again.
 *  2. **The backend changes.** The record is keyed by backend name, so an
 *     operator switching the decoder from vaapi to qsv is obeyed immediately —
 *     qsv has no record.
 *  3. **The runner respawns.** This is instance state on the broker manager,
 *     never a module global, for the same reason `HwAccelCache` is: a module
 *     global outlives an addon respawn, and an addon respawn is exactly the
 *     event after which a stale verdict must not survive.
 *
 * ## Why it lives here and not in `@camstack/types`
 *
 * `addon-export-hap` has the identical gap (its `failedBackend` memo forgets on
 * the same 60 s cadence) and this is deliberately NOT shared with it yet: a
 * framework package is only live once a `@camstack/server` containing it is
 * installed, whereas this ships with `camstack deploy packages/addon-pipeline`.
 * The cross-PROCESS gap D67 names — addons may not import each other and no cap
 * carries "this backend is dead on this node right now" — is unchanged either
 * way; what is closed here is the broker's own repetition of the cost.
 */

/**
 * How long a backend stays quarantined after its 1st, 2nd, 3rd+ consecutive
 * failure. Escalating rather than fixed, and it starts at HALF AN HOUR: a
 * client watchdog cycles in seconds, so any first rung measured in minutes is
 * re-paid by the very churn this exists to stop. The last rung makes a
 * permanently-broken backend cost ~nothing while still being re-probed.
 */
export const DEAD_BACKEND_QUARANTINE_MS: readonly number[] = [
  1_800_000, // 30 min
  7_200_000, // 2 h
  21_600_000, // 6 h
]

/** What {@link DeadDecodeBackends.markDead} decided, for the one log line. */
export interface DeadBackendVerdict {
  readonly backend: string
  /** How many consecutive times this backend has failed in this process. */
  readonly failures: number
  /** How long it is quarantined for, from now. */
  readonly quarantineMs: number
}

export interface DeadDecodeBackends {
  /**
   * Record that `backend` could not produce a packet here. Returns the widened
   * quarantine so the caller can name it in the warn.
   */
  markDead(backend: string): DeadBackendVerdict
  /**
   * Record that `backend` DID run. Clears the record so the escalation restarts
   * from the first rung — without this a backend that recovers stays on a 6 h
   * ladder it no longer deserves.
   */
  markAlive(backend: string): void
  /** `true` while `backend`'s quarantine is still in force. */
  isQuarantined(backend: string): boolean
  /** Remaining quarantine in ms, for the log line. 0 when not quarantined. */
  remainingMs(backend: string): number
  /** Consecutive failures recorded for `backend`. 0 when there is no record. */
  failuresOf(backend: string): number
}

interface DeadRecord {
  failures: number
  until: number
}

/** A resolve that was overruled, with everything the warn has to name. */
export interface DeadBackendVeto {
  readonly backend: string
  readonly failures: number
  readonly remainingMs: number
}

export interface QuarantinedResolveInput {
  /** The honest answer — the decoder addon's, through `resolveEgressDecodeHwAccel`. */
  readonly resolve: () => Promise<string | null>
  readonly dead: DeadDecodeBackends
}

export interface QuarantinedResolve {
  /** What the child should actually be spawned with. `null` ⇒ software. */
  readonly backend: string | null
  /** Non-null exactly when the quarantine overruled a hardware answer. */
  readonly veto: DeadBackendVeto | null
}

/**
 * The decoder's answer, overruled while the backend it names is quarantined.
 *
 * Composed rather than folded into `resolveEgressDecodeHwAccel`: that function
 * answers "what SHOULD decode this", which is a per-node property of the
 * hardware; this answers "what has been observed to work in THIS process",
 * which is a property of the runner. Keeping them apart is what stops a
 * runner-local ENOMEM from being mistaken for a node that has no accelerator —
 * the first is a flow bug to fix, the second a capability limit to accept.
 */
export async function resolveWithQuarantine(
  input: QuarantinedResolveInput,
): Promise<QuarantinedResolve> {
  const backend = await input.resolve()
  if (backend === null || !input.dead.isQuarantined(backend)) return { backend, veto: null }
  return {
    backend: null,
    veto: {
      backend,
      failures: input.dead.failuresOf(backend),
      remainingMs: input.dead.remainingMs(backend),
    },
  }
}

export interface DeadDecodeBackendsOptions {
  readonly now?: () => number
}

export function createDeadDecodeBackends(
  options: DeadDecodeBackendsOptions = {},
): DeadDecodeBackends {
  const now = options.now ?? ((): number => Date.now())
  const records = new Map<string, DeadRecord>()

  const quarantineFor = (failures: number): number => {
    const index = Math.min(failures, DEAD_BACKEND_QUARANTINE_MS.length) - 1
    // `at(-1)` rather than an index expression the compiler cannot prove: the
    // table is a module constant and the clamp above already bounds `index`,
    // but a `!` here would turn a future empty table into a NaN quarantine —
    // i.e. a backend quarantined forever, silently.
    return DEAD_BACKEND_QUARANTINE_MS[index] ?? DEAD_BACKEND_QUARANTINE_MS[0] ?? 0
  }

  return {
    markDead(backend: string): DeadBackendVerdict {
      const previous = records.get(backend)
      const failures = (previous?.failures ?? 0) + 1
      const quarantineMs = quarantineFor(failures)
      records.set(backend, { failures, until: now() + quarantineMs })
      return { backend, failures, quarantineMs }
    },
    markAlive(backend: string): void {
      records.delete(backend)
    },
    isQuarantined(backend: string): boolean {
      const record = records.get(backend)
      return record !== undefined && now() < record.until
    },
    remainingMs(backend: string): number {
      const record = records.get(backend)
      if (record === undefined) return 0
      return Math.max(0, record.until - now())
    },
    failuresOf(backend: string): number {
      return records.get(backend)?.failures ?? 0
    },
  }
}
