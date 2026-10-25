import { describe, it, expect } from 'vitest'
import {
  groupMotionRegions,
  resolveMinGroupArea,
  DEFAULT_MERGE_RADIUS_DIVISOR,
  DEFAULT_MIN_AREA,
  DEFAULT_MIN_AREA_FRACTION,
  DEFAULT_MAX_COVERAGE_FRACTION,
  type MotionRegionInput,
  type RegionGroupingConfig,
} from '../region-grouping.js'

/**
 * The production motion view: `MOTION_FRAME_VIEW` is `content 320×320, fit
 * contain, gray`, so a 16:9 camera is analysed at 320×180 = 57 600 px.
 */
const VIEW_W = 320
const VIEW_H = 180
const VIEW_AREA = VIEW_W * VIEW_H
/** A bar of 900 px on this view — pinned in the tests that depend on its value,
 *  so the measured default can move without unpinning the geometry. */
const BAR_900 = 900 / VIEW_AREA

function cfg(patch: Partial<RegionGroupingConfig> = {}): RegionGroupingConfig {
  return {
    viewWidth: VIEW_W,
    viewHeight: VIEW_H,
    mergeRadiusDivisor: DEFAULT_MERGE_RADIUS_DIVISOR,
    minAreaFraction: DEFAULT_MIN_AREA_FRACTION,
    minArea: 0,
    maxCoverageFraction: 1,
    ...patch,
  }
}

function region(x: number, y: number, w: number, h: number, pixels?: number): MotionRegionInput {
  return { x, y, w, h, pixels: pixels ?? w * h }
}

describe('the shipped default changes nothing', () => {
  // Installing this addon must not move a single camera. The default config is
  // the legacy rule at the bar that shipped, and an operator moves ONE camera
  // by setting `minArea` to 0.
  const shipped: RegionGroupingConfig = {
    viewWidth: VIEW_W,
    viewHeight: VIEW_H,
    mergeRadiusDivisor: DEFAULT_MERGE_RADIUS_DIVISOR,
    minAreaFraction: DEFAULT_MIN_AREA_FRACTION,
    minArea: DEFAULT_MIN_AREA,
    maxCoverageFraction: DEFAULT_MAX_COVERAGE_FRACTION,
  }

  it('reproduces the pre-D394 filter exactly, region for region', () => {
    const regions = [
      region(100, 80, 30, 20, 600),
      region(126, 84, 30, 20, 600),
      region(10, 10, 60, 50, 1600),
      region(200, 120, 80, 70, 4000),
      region(300, 170, 6, 6, 20),
    ]
    const before = regions.filter((r) => r.pixels >= DEFAULT_MIN_AREA)
    const after = groupMotionRegions(regions, shipped)

    expect(after.passed).toHaveLength(before.length)
    expect(after.passed.map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.h, pixels: g.pixels }))).toEqual(
      before.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, pixels: r.pixels })),
    )
    expect(after.suppressedByCoverage).toBe(0)
  })

  it('is the legacy bar that shipped, not a new number', () => {
    expect(DEFAULT_MIN_AREA).toBe(1500)
  })

  it('setting minArea to 0 is the whole gesture that moves a camera', () => {
    const fragments = [
      region(100, 80, 30, 20, 600),
      region(126, 84, 30, 20, 600),
      region(150, 82, 30, 20, 600),
    ]
    expect(groupMotionRegions(fragments, shipped).passed).toEqual([])
    expect(groupMotionRegions(fragments, { ...shipped, minArea: 0 }).passed).toHaveLength(1)
  })
})

describe('resolveMinGroupArea', () => {
  it('derives the bar from the motion view, so it means the same thing on every camera', () => {
    expect(resolveMinGroupArea(cfg({ minAreaFraction: 0.01 }))).toBe(Math.round(0.01 * VIEW_AREA))
  })

  it('lets an absolute operator override replace the derived bar', () => {
    expect(resolveMinGroupArea(cfg({ minAreaFraction: 0.01, minArea: 1500 }))).toBe(1500)
  })

  it('treats a zero/negative override as "not set" rather than "let everything through"', () => {
    const derived = Math.round(DEFAULT_MIN_AREA_FRACTION * VIEW_AREA)
    expect(resolveMinGroupArea(cfg({ minArea: 0 }))).toBe(derived)
    expect(resolveMinGroupArea(cfg({ minArea: -1 }))).toBe(derived)
  })
})

describe('groupMotionRegions — merge then judge', () => {
  it('returns nothing for no regions', () => {
    const out = groupMotionRegions([], cfg())
    expect(out.groups).toEqual([])
    expect(out.passed).toEqual([])
  })

  it('merges fragments of one subject that each fall under the bar, and passes the group', () => {
    // A dog fragmenting into three neighbouring blobs, 600 px each. The bar at
    // the default fraction is ~900 px: each fragment loses on its own, the
    // group wins. This is the exact 555–1495 px population the recall
    // benchmark measured being discarded three times over.
    const regions = [
      region(100, 80, 30, 20, 600),
      region(126, 84, 30, 20, 600),
      region(150, 82, 30, 20, 600),
    ]
    const conf = cfg({ minAreaFraction: BAR_900 })
    const out = groupMotionRegions(regions, conf)

    expect(out.passed).toHaveLength(1)
    expect(out.passed[0]?.pixels).toBe(1800)
    expect(out.passed[0]?.members).toBe(3)
    // Every member on its own is under the bar.
    for (const r of regions) expect(r.pixels).toBeLessThan(resolveMinGroupArea(conf))
  })

  it('unions the ORIGINAL boxes, never the grown ones', () => {
    // Two 30×20 boxes 26 px apart merge only because each is grown to r×r
    // (r = min(320,180)/6 = 30) about its centre. The group rectangle must
    // still be the union of what CCL actually found — otherwise every crop
    // downstream inflates by the merge radius.
    const a = region(100, 80, 30, 20, 600)
    const b = region(126, 84, 30, 20, 600)
    const out = groupMotionRegions([a, b], cfg())

    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]).toMatchObject({ x: 100, y: 80, w: 56, h: 24 })
  })

  it('merges transitively — A touches B, B touches C, all three are one group', () => {
    const out = groupMotionRegions(
      // Centres 25 px apart: each grows to 30×30, so consecutive pairs overlap
      // and the outer two do not — only transitivity can make this one group.
      [region(10, 80, 10, 10, 100), region(35, 80, 10, 10, 100), region(60, 80, 10, 10, 100)],
      cfg(),
    )
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]?.members).toBe(3)
  })

  it('does not merge fragments that are genuinely far apart, and drops each on its own', () => {
    // Same three 600 px fragments, spread across the frame: no grown box
    // overlaps another, so nothing coalesces and nothing passes.
    const out = groupMotionRegions(
      [region(0, 0, 30, 20, 600), region(150, 80, 30, 20, 600), region(285, 155, 30, 20, 600)],
      cfg({ minAreaFraction: BAR_900 }),
    )
    expect(out.groups).toHaveLength(3)
    expect(out.passed).toEqual([])
  })

  it('passes a single large region unchanged', () => {
    const out = groupMotionRegions([region(40, 30, 120, 90, 6000)], cfg())
    expect(out.passed).toHaveLength(1)
    expect(out.passed[0]).toMatchObject({ x: 40, y: 30, w: 120, h: 90, pixels: 6000, members: 1 })
  })

  it('is exact at the boundary — the bar is inclusive, one pixel under fails', () => {
    const conf = cfg({ minAreaFraction: BAR_900 })
    const bar = resolveMinGroupArea(conf)
    expect(groupMotionRegions([region(0, 0, 40, 40, bar)], conf).passed).toHaveLength(1)
    expect(groupMotionRegions([region(0, 0, 40, 40, bar - 1)], conf).passed).toEqual([])
  })

  it('means the same thing at a different motion-view resolution', () => {
    // The same scene at 640×360: every coordinate and pixel count doubles in
    // each dimension (×4 in area). An absolute bar would flip the verdict;
    // a relative one must not.
    const conf = cfg({ minAreaFraction: BAR_900 })
    const under = groupMotionRegions([region(100, 80, 30, 20, 700)], conf)
    const underBig = groupMotionRegions([region(200, 160, 60, 40, 2800)], {
      ...conf,
      viewWidth: 640,
      viewHeight: 360,
    })
    expect(under.passed).toEqual([])
    expect(underBig.passed).toEqual([])

    const over = groupMotionRegions([region(100, 80, 30, 20, 1000)], conf)
    const overBig = groupMotionRegions([region(200, 160, 60, 40, 4000)], {
      ...conf,
      viewWidth: 640,
      viewHeight: 360,
    })
    expect(over.passed).toHaveLength(1)
    expect(overBig.passed).toHaveLength(1)
  })

  it('a positive minArea puts the camera back on the LEGACY rule, whole', () => {
    // `minArea > 0` is not "the same rule with a different number" — it is the
    // pre-D394 rule in full: an absolute bar, applied per COMPONENT, with no
    // merging. Two 600 px fragments of one subject are two failures, exactly
    // as they were before.
    const regions = [region(100, 80, 30, 20, 600), region(126, 84, 30, 20, 600)]
    const legacy = groupMotionRegions(regions, cfg({ minArea: 1000 }))
    expect(legacy.passed).toEqual([])
    expect(legacy.groups).toHaveLength(2)
    for (const g of legacy.groups) expect(g.members).toBe(1)

    // A single component over the bar passes, unchanged.
    const one = groupMotionRegions([region(10, 10, 40, 40, 1200)], cfg({ minArea: 1000 }))
    expect(one.passed).toHaveLength(1)
    expect(one.passed[0]).toMatchObject({ x: 10, y: 10, w: 40, h: 40, pixels: 1200 })

    // And the relative bar is inert while it is set.
    expect(
      groupMotionRegions(
        [region(10, 10, 40, 40, 1200)],
        cfg({ minAreaFraction: 0.9, minArea: 1000 }),
      ).passed,
    ).toHaveLength(1)
  })

  it('the legacy rule has no storm cutoff — it is what the camera does today', () => {
    const rain: MotionRegionInput[] = []
    for (let y = 0; y < 180; y += 5) {
      for (let x = 0; x < 320; x += 5) rain.push(region(x, y, 4, 4, 16))
    }
    const out = groupMotionRegions(rain, cfg({ minArea: 10, maxCoverageFraction: 0.5 }))
    expect(out.suppressedByCoverage).toBe(0)
    expect(out.passed).toHaveLength(rain.length)
  })

  it('discards a frame of scattered sensor noise', () => {
    // 60 isolated 4 px specks on a 20 px lattice — far enough apart that the
    // r×r growth never bridges them.
    const noise: MotionRegionInput[] = []
    for (let y = 0; y < 180; y += 45) {
      for (let x = 0; x < 320; x += 20) noise.push(region(x, y, 2, 2, 4))
    }
    const out = groupMotionRegions(noise, cfg({ minAreaFraction: BAR_900 }))
    expect(out.passed).toEqual([])
  })
})

describe('groupMotionRegions — the storm breaker', () => {
  // Merge-then-judge makes wind/rain/IR noise MORE likely to coalesce into one
  // huge group, which is exactly the frame a motion step must not report as a
  // subject. The coverage bar is judged on the group's own pixels, not on its
  // bounding rectangle, so a large but sparse rain group is caught while a
  // solid subject close to the lens is not.
  const stormCfg = cfg({ minAreaFraction: BAR_900, maxCoverageFraction: 0.5 })

  it('drops a group whose changed pixels cover more of the view than the bar', () => {
    // 4×4 specks on a 5 px lattice across the whole view — 64% of the pixels
    // changed, which no subject does.
    const rain: MotionRegionInput[] = []
    for (let y = 0; y < 180; y += 5) {
      for (let x = 0; x < 320; x += 5) rain.push(region(x, y, 4, 4, 16))
    }
    const out = groupMotionRegions(rain, stormCfg)
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]?.pixels).toBeGreaterThan(0.5 * VIEW_AREA)
    expect(out.passed).toEqual([])
    expect(out.suppressedByCoverage).toBe(1)
  })

  it('keeps a solid subject filling half the frame — a big group is not a storm', () => {
    const out = groupMotionRegions(
      [region(60, 20, 160, 140, Math.round(0.4 * VIEW_AREA))],
      stormCfg,
    )
    expect(out.passed).toHaveLength(1)
    expect(out.suppressedByCoverage).toBe(0)
  })

  it('a coverage bar of 1 suppresses nothing — the breaker can be turned off', () => {
    const full = [region(0, 0, VIEW_W, VIEW_H, VIEW_AREA)]
    expect(groupMotionRegions(full, cfg({ maxCoverageFraction: 1 })).passed).toHaveLength(1)
  })

  it('keeps a real subject that the storm merged with, judged on its own component', () => {
    // The dangerous case for merge-then-judge: a person walks through the rain,
    // their box merges into the storm group, and the breaker silences BOTH. So
    // a suppressed group is re-judged component by component — a member that
    // clears the bar on its own, and is not itself a storm, still fires.
    const rain: MotionRegionInput[] = []
    for (let y = 0; y < 180; y += 5) {
      for (let x = 0; x < 320; x += 5) rain.push(region(x, y, 4, 4, 16))
    }
    const person = region(140, 60, 24, 60, 1100)
    const out = groupMotionRegions([...rain, person], stormCfg)

    expect(out.groups).toHaveLength(1)
    expect(out.suppressedByCoverage).toBe(1)
    expect(out.passed).toHaveLength(1)
    expect(out.passed[0]).toMatchObject({ x: 140, y: 60, pixels: 1100, members: 1 })
  })

  it('does not let a whole-frame change back in through the per-component fallback', () => {
    // An IR cut or exposure step arrives as ONE enormous component. Falling
    // back to per-component judgement must not resurrect it: a member over the
    // coverage bar is a storm by itself.
    const out = groupMotionRegions([region(0, 0, 320, 180, Math.round(0.9 * VIEW_AREA))], stormCfg)
    expect(out.suppressedByCoverage).toBe(1)
    expect(out.passed).toEqual([])
  })

  it('suppresses only the storm group, never the other movers in the frame', () => {
    const rain: MotionRegionInput[] = []
    for (let y = 0; y < 180; y += 5) {
      for (let x = 0; x < 260; x += 5) rain.push(region(x, y, 4, 4, 16))
    }
    const subject = region(290, 140, 25, 25, 900)
    const out = groupMotionRegions([...rain, subject], stormCfg)
    expect(out.suppressedByCoverage).toBe(1)
    expect(out.passed).toHaveLength(1)
    expect(out.passed[0]?.x).toBe(290)
  })
})
