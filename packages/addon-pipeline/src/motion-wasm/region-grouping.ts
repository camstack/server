/**
 * Motion region grouping — merge, then judge.
 *
 * The connected-component step hands us one region per blob. A subject that
 * fragments (a dog behind a railing, a body split by a low-contrast band)
 * arrives as three small blobs, and a per-region area filter discards it three
 * times over. The measurement in `docs/benchmarks/motion-crop-recall.md` put a
 * number on that: on camera 101 raw regions existed on 35 of 38 frames with a
 * visible animal, but only 19 survived `minArea 1500`, and the discarded ones
 * measured 555–1495 px — clustered just under the bar.
 *
 * So the bar is applied to the SUBJECT, not to the blob:
 *
 *  1. grow every region to at least `r × r` about its centre, where
 *     `r = min(viewWidth, viewHeight) / mergeRadiusDivisor`;
 *  2. merge regions whose GROWN boxes overlap, transitively, into a group;
 *  3. the group's rectangle is the union of the **original** boxes — never the
 *     grown ones, or every crop derived downstream inflates by `r`;
 *  4. judge the group on its **summed member pixels** against a bar expressed
 *     as a fraction of the motion view, so it means the same thing on every
 *     camera and survives a resolution change.
 *
 * The shape is conventional. The values are not copied from anywhere — they
 * come from the per-camera distributions in
 * `docs/benchmarks/motion-region-area.md`.
 *
 * Pure geometry: no I/O, no clock, no config store. The caller resolves the
 * config and passes the view dimensions.
 */

/** One connected-component region as the WASM step reports it. */
export interface MotionRegionInput {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Changed pixels inside the box — NOT `w × h`. */
  readonly pixels: number
}

/** A merged subject: the union of its members' original boxes. */
export interface MotionRegionGroup {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Summed changed pixels across every member. */
  readonly pixels: number
  /** How many connected components merged into this group. */
  readonly members: number
}

export interface RegionGroupingConfig {
  /** Width of the motion view the regions are expressed in. */
  readonly viewWidth: number
  /** Height of the motion view the regions are expressed in. */
  readonly viewHeight: number
  /** `r = min(viewWidth, viewHeight) / mergeRadiusDivisor`. */
  readonly mergeRadiusDivisor: number
  /** Bar as a fraction of the motion view's area. */
  readonly minAreaFraction: number
  /**
   * Absolute bar in pixels, and the ROLLOUT SWITCH.
   *
   * `> 0` runs the **pre-D394 rule in full** on this camera: this bar, applied
   * to each component independently, no merging, no storm cutoff. That is the
   * default, so installing this addon moves nothing anywhere.
   *
   * `0` moves the camera to the measured rule — merge first, then judge
   * against {@link RegionGroupingConfig.minAreaFraction}, with
   * {@link RegionGroupingConfig.maxCoverageFraction} live. It is ONE knob
   * because it is one question: which rule does this camera run. A separate
   * enable flag beside a bar that already answers it would be a second source
   * of truth.
   */
  readonly minArea: number
  /**
   * Storm breaker: a group whose summed pixels exceed this fraction of the
   * view is suppressed. Merge-then-judge makes wind, rain and IR noise
   * coalesce into one huge group; this is what stops that group being reported
   * as a subject. `1` disables it, and so does a positive
   * {@link RegionGroupingConfig.minArea} — the legacy rule never had one.
   */
  readonly maxCoverageFraction: number
}

export interface RegionGroupingResult {
  /** Every group, before the area bar — the raw shape, for the debug overlay. */
  readonly groups: ReadonlyArray<MotionRegionGroup>
  /** Groups that cleared the area bar and were not suppressed as a storm. */
  readonly passed: ReadonlyArray<MotionRegionGroup>
  /** How many groups the storm breaker removed on this frame. */
  readonly suppressedByCoverage: number
}

/**
 * The conventional radius divisor. Kept because it is a MERGE distance — how
 * far apart two blobs of one subject may sit — not the area bar, which is the
 * number the benchmark says must be measured rather than copied.
 */
export const DEFAULT_MERGE_RADIUS_DIVISOR = 6

/**
 * Default area bar, as a fraction of the motion view.
 *
 * Chosen from the measured separation between true-positive group areas and
 * quiet-footage group areas — see `docs/benchmarks/motion-region-area.md`.
 * On the 320×180 production motion view this is ~490 px, against the 1500 px
 * absolute filter it replaces.
 */
export const DEFAULT_MIN_AREA_FRACTION = 0.0085

/**
 * The DEFAULT is the rule that shipped before D394: a 1500 px absolute bar per
 * component. The measured rule is per-camera opt-in (`minArea: 0`), because
 * the measurement says duty cycle rises between ×1.45 and ×2.82 and ten fleet
 * cameras turn that into recorded hours that cannot be measured from their own
 * footage. The end state is still one relative constant for the fleet; the
 * path there is one camera at a time.
 */
export const DEFAULT_MIN_AREA = 1500

/**
 * Default storm bar. A group of changed pixels covering more than this
 * fraction of the view is not a subject — it is weather, an exposure step or
 * an IR cut. See the storm section of `docs/benchmarks/motion-region-area.md`.
 */
export const DEFAULT_MAX_COVERAGE_FRACTION = 0.5

/** The bar in pixels: the absolute one when set, the relative rule otherwise. */
export function resolveMinGroupArea(config: RegionGroupingConfig): number {
  if (config.minArea > 0) return config.minArea
  const area = Math.max(0, config.viewWidth) * Math.max(0, config.viewHeight)
  return Math.round(config.minAreaFraction * area)
}

interface GrownBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

function grow(region: MotionRegionInput, radius: number): GrownBox {
  const cx = region.x + region.w / 2
  const cy = region.y + region.h / 2
  const halfW = Math.max(region.w, radius) / 2
  const halfH = Math.max(region.h, radius) / 2
  return { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH }
}

function overlaps(a: GrownBox, b: GrownBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

/**
 * Merge fragments into subjects and judge each subject on its own summed area.
 *
 * Groups come back in the order of their first member, so the frame's reading
 * order is stable across calls — a UI overlay does not reshuffle.
 *
 * A group over `maxCoverageFraction` is a storm and does not pass as a group;
 * its components are then judged individually, so a subject the storm merged
 * with is not silenced along with it.
 *
 * A positive `config.minArea` short-circuits all of it and runs the pre-D394
 * rule instead — see {@link RegionGroupingConfig.minArea}.
 */
export function groupMotionRegions(
  regions: ReadonlyArray<MotionRegionInput>,
  config: RegionGroupingConfig,
): RegionGroupingResult {
  if (regions.length === 0) return { groups: [], passed: [], suppressedByCoverage: 0 }

  // The legacy rule, whole: no merging, no storm cutoff, the absolute bar per
  // component. This is what a camera runs until an operator moves it.
  if (config.minArea > 0) {
    const legacy = regions.map((r) => ({
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      pixels: r.pixels,
      members: 1,
    }))
    return {
      groups: legacy,
      passed: legacy.filter((g) => g.pixels >= config.minArea),
      suppressedByCoverage: 0,
    }
  }

  const radius = Math.max(
    1,
    Math.floor(
      Math.min(config.viewWidth, config.viewHeight) / Math.max(1, config.mergeRadiusDivisor),
    ),
  )
  const grown = regions.map((r) => grow(r, radius))

  // Union-find over overlapping grown boxes — transitivity is the point: A
  // touching B and B touching C must give ONE subject, not two.
  const parent = regions.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    let cur = i
    while (parent[cur] !== root) {
      const next = parent[cur]!
      parent[cur] = root
      cur = next
    }
    return root
  }
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (!overlaps(grown[i]!, grown[j]!)) continue
      const ri = find(i)
      const rj = find(j)
      if (ri !== rj) parent[rj] = ri
    }
  }

  interface Accum {
    x0: number
    y0: number
    x1: number
    y1: number
    pixels: number
    members: number
  }
  const byRoot = new Map<number, Accum>()
  const order: number[] = []
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i]!
    const root = find(i)
    const existing = byRoot.get(root)
    if (!existing) {
      order.push(root)
      byRoot.set(root, {
        x0: region.x,
        y0: region.y,
        x1: region.x + region.w,
        y1: region.y + region.h,
        pixels: region.pixels,
        members: 1,
      })
      continue
    }
    // Union of the ORIGINAL boxes.
    existing.x0 = Math.min(existing.x0, region.x)
    existing.y0 = Math.min(existing.y0, region.y)
    existing.x1 = Math.max(existing.x1, region.x + region.w)
    existing.y1 = Math.max(existing.y1, region.y + region.h)
    existing.pixels += region.pixels
    existing.members += 1
  }

  const groups: MotionRegionGroup[] = order.map((root) => {
    const a = byRoot.get(root)!
    return {
      x: a.x0,
      y: a.y0,
      w: a.x1 - a.x0,
      h: a.y1 - a.y0,
      pixels: a.pixels,
      members: a.members,
    }
  })

  const bar = resolveMinGroupArea(config)
  const viewArea = Math.max(0, config.viewWidth) * Math.max(0, config.viewHeight)
  const stormBar =
    config.maxCoverageFraction >= 1 ? Infinity : config.maxCoverageFraction * viewArea

  // Members of each group, in the same order, so a suppressed group can be
  // re-judged component by component.
  const membersByGroup = new Map<number, MotionRegionInput[]>()
  for (let i = 0; i < regions.length; i++) {
    const root = find(i)
    const list = membersByGroup.get(root) ?? []
    list.push(regions[i]!)
    membersByGroup.set(root, list)
  }

  const passed: MotionRegionGroup[] = []
  let suppressedByCoverage = 0
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!
    if (group.pixels < bar) continue
    if (group.pixels <= stormBar) {
      passed.push(group)
      continue
    }
    // A storm. Silencing the whole group would silence a person who happens
    // to be walking through the rain — their box merges into it. So the
    // group's own components are re-judged: one that clears the bar on its
    // own, and is not itself frame-wide, still fires.
    suppressedByCoverage += 1
    for (const member of membersByGroup.get(order[g]!) ?? []) {
      if (member.pixels < bar || member.pixels > stormBar) continue
      passed.push({
        x: member.x,
        y: member.y,
        w: member.w,
        h: member.h,
        pixels: member.pixels,
        members: 1,
      })
    }
  }

  return { groups, passed, suppressedByCoverage }
}
