/**
 * How the recorder reads a `child_process` `'error'` — ONE owner of the
 * transient-vs-permanent question.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * In Node a child that cannot be spawned emits `'error'`, and an `'error'`
 * with no listener is re-thrown as an UNCAUGHT EXCEPTION. On 2026-08-18 three
 * cameras were unplugged, every writer for them re-dialled at once, the host
 * momentarily could not fork (`spawn ffmpeg EAGAIN`), and the `recorder`
 * runner died three times inside nine seconds. The D6 crash circuit-breaker
 * did its job and stopped respawning — leaving the whole fleet with no
 * recording for three hours and fifteen minutes while `/health` returned 200.
 *
 * Every ffmpeg spawn site in the recorder therefore attaches an `'error'`
 * listener, and every one of them classifies the failure HERE rather than
 * inventing its own list.
 */

/**
 * Spawn failures that RETRYING CANNOT FIX.
 *
 * The EAGAIN-vs-ENOENT split, stated once:
 *
 *   - EAGAIN / EMFILE / ENOMEM are the host saying "not right now". The
 *     resource comes back, often within one backoff. They take the ordinary
 *     restart-with-backoff path, whose own comment already states the policy
 *     for this shape: "only RAPID back-to-back failures count toward giving
 *     up, so a brief blip never permanently stops a camera's recording".
 *   - ENOENT / EACCES are the host saying "there is no ffmpeg here you may
 *     run". Nothing about the next ten attempts differs from this one, so the
 *     caller stops immediately and surfaces it at ERROR level: burning a
 *     ten-attempt budget on a missing binary only delays recovery and buries
 *     the single actionable line under ten identical warnings.
 *
 * EPERM is deliberately absent: it is reported for transient sandbox/cgroup
 * refusals as well as for real permission faults, and treating an ambiguous
 * code as permanent stops a camera that would have recovered.
 */
const PERMANENT_SPAWN_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES'])

/** What a failed spawn tells us. Read from the emitted value, never cast. */
export interface SpawnFailure {
  /** The errno string (`EAGAIN`, `ENOENT`, …) when the emitter carried one. */
  readonly code: string | undefined
  readonly message: string
  /** True when retrying cannot help — see {@link PERMANENT_SPAWN_CODES}. */
  readonly permanent: boolean
}

/**
 * Read the `'error'` payload without a cast.
 *
 * An unknown code is treated as TRANSIENT: the cost of retrying something
 * permanent is a bounded restart budget, while the cost of giving up on
 * something transient is a camera that stops recording until an operator
 * notices.
 */
export function readSpawnFailure(raw: unknown): SpawnFailure {
  const code = errnoCode(raw)
  return {
    code,
    message: raw instanceof Error ? raw.message : String(raw),
    permanent: code !== undefined && PERMANENT_SPAWN_CODES.has(code),
  }
}

function errnoCode(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('code' in raw)) return undefined
  const code: unknown = raw.code
  return typeof code === 'string' ? code : undefined
}
