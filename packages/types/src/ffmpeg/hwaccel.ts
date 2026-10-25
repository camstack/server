/**
 * Decode hardware acceleration for an EGRESS transcode — resolved through the
 * ONE ranking that is known to work on this hardware.
 *
 * ## Why this file exists
 *
 * The repo has two hwaccel opinions and they disagree in the direction that
 * breaks things:
 *
 * - the raw kernel resolver (`ctx.kernel.hwaccel.resolve()`) returns
 *   `['qsv','vaapi']` for an Intel host — qsv FIRST;
 * - the decoder addon's `DECODE_HWACCEL_RANK` (`addon-decoder-nodeav`) puts **vaapi above qsv on
 *   purpose**, because on this exact hub a qsv decode child exits `code=171`
 *   producing no frames, while vaapi decodes 8 MP h264 at ~50 fps.
 *
 * **The decoder addon is the authority.** It publishes its answer per node as
 * the `probedBestHwaccel@<node>` setting and exposes it on the `decoder` cap's
 * `getInfo` — the same value `AgentLoadService.readNodeDecodeHwaccel` reads to
 * show per-node hwaccel in the UI. This module reads THAT, and deliberately
 * never re-derives a ranking: a second copy of the rank table is exactly how
 * the two opinions appeared. Addons may not import each other, so the read is
 * a `ctx.api.decoder.getInfo` call injected as {@link EgressHwAccelDeps.readDecoderBackend}.
 *
 * ## Why the kernel resolver is still a dependency here
 *
 * It is only ever used to say something in a log line. It is never allowed to
 * SELECT a backend: if the decoder cannot answer, this resolver returns
 * software rather than adopting the kernel's qsv-first order, because that
 * order is the known-bad one. `never silently downgrades` in the spec is the
 * test that holds this.
 *
 * ## The failure mode this must not reproduce
 *
 * A silent fall back to software decode is a FLOW bug on this hub, not a
 * capability limit (vaapi works — 10 concurrent 4K decodes pass). So every
 * path that ends in software calls {@link EgressHwAccelDeps.onFallback}, which
 * the caller logs at `warn` with `tags: { deviceId }`. Silence reads as
 * "hardware was used".
 */

/** Why a resolve ended in software decode. */
export type EgressHwAccelFallbackReason =
  /** The `decoder` cap could not be reached (offline node, cap not mounted). */
  | 'decoder-unreadable'
  /** The decoder answered, but has not probed a backend on this node yet. */
  | 'decoder-unprobed'

export interface EgressHwAccelFallback {
  readonly reason: EgressHwAccelFallbackReason
  /** What the kernel resolver would have said — for the log line ONLY. */
  readonly kernelPreferred: readonly string[]
  readonly error?: string
}

/**
 * A bounded memo so a per-session resolve is not a per-session cross-process
 * cap call. Owned by the caller (one per broker / exporter), never a module
 * global — a module global would outlive an addon respawn and survive an
 * operator changing the decoder backend.
 */
export interface HwAccelCache {
  read(): string | null | undefined
  write(value: string | null): void
}

export interface HwAccelCacheOptions {
  readonly ttlMs: number
  readonly now?: () => number
}

export function createHwAccelCache(options: HwAccelCacheOptions): HwAccelCache {
  const now = options.now ?? ((): number => Date.now())
  let value: string | null = null
  let writtenAt = Number.NEGATIVE_INFINITY
  return {
    read(): string | null | undefined {
      return now() - writtenAt < options.ttlMs ? value : undefined
    },
    write(next: string | null): void {
      value = next
      writtenAt = now()
    },
  }
}

export interface EgressHwAccelDeps {
  /**
   * `ctx.api.decoder.getInfo.query(undefined, nodePin(nodeId)).probedBestHwaccel`
   * — the DECODER ADDON's own answer for THIS node, already re-ranked through
   * `DECODE_HWACCEL_RANK`. Throw or return `''` when it is not knowable.
   */
  readDecoderBackend(): Promise<string>
  /**
   * `ctx.kernel.hwaccel.resolve().preferred` — reported in the fallback log so
   * an operator can see the disagreement. NEVER used to select a backend.
   */
  readKernelPreferred(): Promise<readonly string[]>
  /** Called on every path that ends in software. The caller logs at `warn`. */
  onFallback(fallback: EgressHwAccelFallback): void
  /**
   * An explicit operator choice (`decoder.hwaccel`, or a per-consumer pin).
   * `'auto'` is passed through as the literal ffmpeg instruction; `'none'` /
   * `'copy'` force software; anything else pins that backend. Absent ⇒ ask the
   * decoder.
   */
  readonly override?: string | null
  readonly cache?: HwAccelCache
}

/** `true` when a value means "decode in software". */
function meansSoftware(value: string | null): boolean {
  return !value || value === 'none' || value === 'copy'
}

/**
 * Resolve the `-hwaccel` value for an egress transcode. Hardware is the
 * DEFAULT — an egress that decodes in software on a hub with working vaapi is
 * paying for nothing — and every software outcome is announced.
 *
 * Returns a concrete backend name, the literal `'auto'`, or `null` for
 * software decode (⇒ {@link buildFfmpegArgs} emits no `-hwaccel` at all).
 */
export async function resolveEgressDecodeHwAccel(deps: EgressHwAccelDeps): Promise<string | null> {
  const override = deps.override
  if (override !== undefined && override !== null && override !== '') {
    // An operator choice is final, and needs no probe to honour.
    return meansSoftware(override) ? null : override
  }

  const cached = deps.cache?.read()
  if (cached !== undefined) return cached

  let backend: string
  try {
    backend = await deps.readDecoderBackend()
  } catch (err) {
    const kernelPreferred = await deps.readKernelPreferred().catch(() => [])
    deps.onFallback({
      reason: 'decoder-unreadable',
      kernelPreferred,
      error: err instanceof Error ? err.message : String(err),
    })
    deps.cache?.write(null)
    return null
  }

  if (backend === '') {
    // The decoder has not probed this node yet. We do NOT adopt the kernel's
    // preference: on Intel its head is `qsv`, the backend that exits 171 here.
    const kernelPreferred = await deps.readKernelPreferred().catch(() => [])
    deps.onFallback({ reason: 'decoder-unprobed', kernelPreferred })
    deps.cache?.write(null)
    return null
  }

  // `'none'` from the decoder is a DELIBERATE software choice (the operator
  // set it, or the node genuinely has no accelerator). Not a fallback — do not
  // cry wolf about it.
  const resolved = meansSoftware(backend) ? null : backend
  deps.cache?.write(resolved)
  return resolved
}
