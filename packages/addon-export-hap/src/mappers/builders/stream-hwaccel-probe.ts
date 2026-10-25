/**
 * The impure half of the hardware-decode path: ask the node what it has.
 *
 * There is exactly one authority for that in this workspace, and it is not a
 * probe of our own. Every decoder addon publishes `hwaccel` (the operator's
 * choice) and `probedBestHwaccel` (its own boot-time probe of the host) as
 * per-node settings, keyed `probedBestHwaccel@<node>`, and exposes both on
 * `decoder.getInfo`. `AgentLoadService` reads them through exactly this call.
 * Reusing it means the HomeKit transcode and the pipeline cannot disagree about
 * what the hardware is, and it means an operator who turns hardware decode off
 * in the decoder settings turns it off here too.
 *
 * `export-hap` is `hub-only` and spawns ffmpeg in its own process, so the node
 * that matters is always the local one — but the call is pinned explicitly
 * rather than left to routing, because an unpinned singleton cap answers from
 * whichever node owns it and would report the WRONG host's hardware.
 *
 * Bounded by a 60 s memo, not by nothing and not forever. It used to be read
 * once per SESSION, and iOS starts sessions in bursts — one on record was
 * started three times in 16 s — so a burst paid three cross-process cap calls
 * for an answer that cannot change in that window. The memo is the same
 * primitive and the same TTL the broker's `egressHwAccelCache` uses, so the two
 * consumers cannot disagree about how stale "current" is; it is short enough
 * that an operator who changes the decoder backend is obeyed on the next
 * session rather than after the next accessory rebuild. See
 * `stream-hwaccel-memo.ts`.
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { nodePin } from '@camstack/types'

import type { DecoderReadingMemo } from './stream-hwaccel-memo.js'
import type { DecoderHwaccelReading } from './stream-hwaccel.js'

/** The two fields of `decoder.getInfo` this path reads. */
export interface DecoderInfoFields {
  readonly hwaccel?: string | null
  readonly probedBestHwaccel?: string | null
}

/**
 * The node, and the one cap read against it.
 *
 * Extracted as a seam for the same reason `EgressHwAccelDeps.readDecoderBackend`
 * is one: it makes "how many `decoder.getInfo` calls did a burst of sessions
 * issue" a question a test can answer, and that count IS the memo's whole
 * claim. Production builds it from the addon context via
 * {@link decoderInfoSourceFromContext} — there is no second implementation.
 */
export interface DecoderInfoSource {
  /** `ctx.kernel?.localNodeId`. Absent during boot. */
  readonly localNodeId: string | undefined
  readInfo(nodeId: string): Promise<DecoderInfoFields | null | undefined>
}

/**
 * The real read: `decoder.getInfo`, pinned to the LOCAL node.
 *
 * Pinned explicitly rather than left to routing, because an unpinned singleton
 * cap answers from whichever node owns it and would report the WRONG host's
 * hardware.
 */
export function decoderInfoSourceFromContext(ctx: AddonContext): DecoderInfoSource {
  return {
    localNodeId: ctx.kernel?.localNodeId,
    readInfo: (nodeId: string): Promise<DecoderInfoFields | null | undefined> =>
      ctx.api.decoder.getInfo.query(undefined, nodePin(nodeId)),
  }
}

export interface ProbeDecoderHwaccelInput {
  readonly source: DecoderInfoSource
  readonly log: IScopedLogger
  /**
   * The addon-process-wide memo. Passed in rather than owned here: a module
   * global would outlive an addon respawn and survive an operator changing the
   * decoder backend (the rule `HwAccelCache` itself records).
   */
  readonly memo: DecoderReadingMemo
}

/**
 * Read this node's decode-hwaccel state, or `null` when nothing answered.
 *
 * Never throws. `null` means "we do not know", which
 * {@link import('./stream-hwaccel.js').selectHwDecode} turns into software —
 * the safe direction, because a guess here costs the whole stream.
 */
export async function probeDecoderHwaccel(
  input: ProbeDecoderHwaccelInput,
): Promise<DecoderHwaccelReading | null> {
  const { source, log, memo } = input
  // `undefined` = ask. `null` = we asked inside the window and nothing
  // answered — remembered on purpose, because a node with no decoder addon
  // bound is a legitimate configuration and must not cost a failing
  // cross-process call on every session.
  const memoised = memo.read()
  if (memoised !== undefined) return memoised

  const nodeId = source.localNodeId
  if (nodeId === undefined || nodeId.length === 0) {
    log.warn('export-hap: hwaccel probe skipped — no local node id, decoding in SOFTWARE')
    // NOT memoised: a missing local node id is a boot-order state, not a fact
    // about the host, and caching it would keep every session in software for a
    // minute after the kernel finished coming up.
    return null
  }

  try {
    const info = await source.readInfo(nodeId)
    if (info === null || info === undefined) {
      log.info('export-hap: hwaccel probe returned nothing — decoding in SOFTWARE', {
        meta: { nodeId },
      })
      memo.write(null)
      return null
    }
    const reading: DecoderHwaccelReading = {
      hwaccel: info.hwaccel ?? null,
      probedBestHwaccel: info.probedBestHwaccel ?? null,
    }
    memo.write(reading)
    return reading
  } catch (err) {
    // A node with no decoder addon bound is a legitimate configuration, not a
    // fault — but it is indistinguishable from a transport failure here, and
    // both end in software, so both are said out loud rather than swallowed.
    log.warn('export-hap: hwaccel probe failed — decoding in SOFTWARE', {
      meta: { nodeId, error: err instanceof Error ? err.message : String(err) },
    })
    memo.write(null)
    return null
  }
}
