/**
 * The old-space ceiling for the AGENT root process — one formula, mirrored by
 * `agent_heap_mb` in the Dockerfile's `docker-entrypoint.sh` (a spec pins the two
 * to the same answers). Pure: no `os`, no `fs`.
 *
 * ## Why a default at all
 *
 * hub-main takes V8's host-derived default (about a quarter of RAM, capped near
 * 4 GB) and an operator override, `CAMSTACK_HUB_HEAP_MB`. The agent root was
 * started with no flag on every launch path, so on a small host V8's quarter
 * (1 GB on a 4 GB box) is the ceiling, and the heartbeat added with this change
 * could not even say who chose it.
 *
 * ## Why this number, and why it is generous
 *
 * Measured agent roots are 0.8–1.4 GB RSS and what part of that is V8 heap is
 * NOT measured (the `[mem] agent-main` heartbeat is what will tell). A ceiling
 * that guessed low would turn a healthy root into a fatal OOM, which is what
 * `--max-old-space-size=1536` did to hub-main four times in 15 h. So:
 *
 *     ceiling = clamp(totalMem / 4, 1536 MB, 4096 MB)
 *
 *  - `totalMem / 4` is V8's own rule, so a big host gets what it already had;
 *  - the 1536 MB floor sits above every observed agent RSS, i.e. above any
 *    heap the root can hold, on hosts where V8's quarter would be smaller;
 *  - 4096 MB is the cap V8 itself applies, so the flag never raises the ceiling
 *    past what V8 would pick on a large host.
 *
 * It bounds a runaway; it is not a tuning knob. `CAMSTACK_AGENT_HEAP_MB`
 * (positive integer) overrides it, mirroring `CAMSTACK_HUB_HEAP_MB`.
 */
export const AGENT_HEAP_FLOOR_MB = 1536
export const AGENT_HEAP_CAP_MB = 4096
export const AGENT_HEAP_ENV = 'CAMSTACK_AGENT_HEAP_MB'

const BYTES_PER_MB = 1024 * 1024

/** The ceiling in MB for a host with `totalMemBytes` of RAM. */
export function agentHeapCeilingMb(
  totalMemBytes: number,
  env: Readonly<Record<string, string | undefined>> = {},
): number {
  const override = env[AGENT_HEAP_ENV]
  if (override !== undefined && /^[1-9][0-9]*$/.test(override)) return Number(override)
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return AGENT_HEAP_FLOOR_MB
  const quarterMb = Math.floor(totalMemBytes / BYTES_PER_MB / 4)
  return Math.min(AGENT_HEAP_CAP_MB, Math.max(AGENT_HEAP_FLOOR_MB, quarterMb))
}

/** The argv flag for the agent root's `node` process. */
export function agentHeapNodeArgs(
  totalMemBytes: number,
  env: Readonly<Record<string, string | undefined>> = {},
): readonly string[] {
  return [`--max-old-space-size=${agentHeapCeilingMb(totalMemBytes, env)}`]
}
