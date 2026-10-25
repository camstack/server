/**
 * Attach a model-free appearance descriptor to every first-level box of a
 * frame result (D683 §8.1). The pixel source is injected: in the runner it is
 * the frame lease (or the inline RGB buffer), in tests a fixed view.
 *
 * Returns the SAME result object when nothing was attached, never mutates it,
 * and counts every box it could not describe — a skipped box in silence would
 * read as "the tracker had no appearance for that camera" with no reason.
 */
import type { FrameResult } from '@camstack/types'
import {
  type AppearanceCrop,
  appearanceCrop,
  computeAppearanceDescriptor,
  type RgbView,
} from './appearance-descriptor.js'

export interface AppearanceAttachCost {
  readonly attached: number
  readonly tooSmall: number
  readonly failed: number
  /** First-level boxes left out by a `'candidates'` scope. */
  readonly skippedScope: number
  readonly ms: number
}

/** `'all'`: every first-level box. `'candidates'`: only boxes that can become an
 *  L1 doubt or an L2 link (the cost gate's fallback, Step 9). */
export type AppearanceScope = 'all' | 'candidates'

export interface AppearanceAttachOptions {
  readonly scope: AppearanceScope
  readonly isCandidate: (index: number) => boolean
}

const ALL_BOXES: AppearanceAttachOptions = { scope: 'all', isCandidate: () => true }

export interface AppearanceAttachOutcome {
  readonly result: FrameResult
  readonly cost: AppearanceAttachCost
}

export type AppearanceViewSource = (crop: AppearanceCrop) => Promise<RgbView | null>

export async function attachAppearanceDescriptors(
  result: FrameResult,
  readView: AppearanceViewSource,
  options: AppearanceAttachOptions = ALL_BOXES,
  now: () => number = () => 0,
): Promise<AppearanceAttachOutcome> {
  let attached = 0
  let tooSmall = 0
  let failed = 0
  let skippedScope = 0
  const startedAt = now()
  const detections = await Promise.all(
    result.detections.map(async (d, index) => {
      if (d.kind !== 'first-level') return d
      if (options.scope === 'candidates' && !options.isCandidate(index)) {
        skippedScope += 1
        return d
      }
      const crop = appearanceCrop(d.bbox, result)
      if (crop === null) {
        tooSmall += 1
        return d
      }
      const view = await readView(crop)
      if (view === null) {
        failed += 1
        return d
      }
      attached += 1
      return { ...d, appearance: computeAppearanceDescriptor(view) }
    }),
  )
  const cost: AppearanceAttachCost = {
    attached,
    tooSmall,
    failed,
    skippedScope,
    ms: now() - startedAt,
  }
  return { result: attached === 0 ? result : { ...result, detections }, cost }
}

const EMPTY_APPEARANCE_COST: AppearanceAttachCost = {
  attached: 0,
  tooSmall: 0,
  failed: 0,
  skippedScope: 0,
  ms: 0,
}

/**
 * The runner's real entry point (D683 fix round 1, coordinator ruling
 * 2026-09-30 on the Task 10 cost-bench STOP): appearance is off by default
 * until Task 23 calibrates it, so a disabled camera must cost NOTHING extra
 * per frame — no crop, no resample, no descriptor. `enabled` must be the
 * SAME authority the tracker reads (`TrackerV2Config.appearanceResolvesAmbiguity`'s
 * default, `@camstack/types` `APPEARANCE_RESOLVES_AMBIGUITY_DEFAULT`) — never
 * a second flag that could disagree with it (CLAUDE.md D62). Disabled
 * short-circuits BEFORE `readView` is ever called, so `computeAppearanceDescriptor`
 * (reached only from inside {@link attachAppearanceDescriptors}, through a
 * successful `readView`) is never called either.
 */
export async function attachAppearanceIfEnabled(
  enabled: boolean,
  result: FrameResult,
  readView: AppearanceViewSource,
  options: AppearanceAttachOptions = ALL_BOXES,
  now: () => number = () => 0,
): Promise<AppearanceAttachOutcome> {
  if (!enabled) return { result, cost: EMPTY_APPEARANCE_COST }
  return attachAppearanceDescriptors(result, readView, options, now)
}
