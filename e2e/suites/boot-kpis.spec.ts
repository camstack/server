/**
 * Boot KPI parser — extracts operator-visible boot offsets from hub docker
 * logs. The empty-hub e2e suite cannot certify “recording in seconds”; this
 * parser is what scores a real boot (captured text today, live docker logs
 * after an approved restart).
 *
 * Each assertion names the defect it holds shut: a restart used to be scored
 * by hand-grepping `boot-to-usable-camera.md` patterns that then drifted
 * (`First keyframe received` vs current `First keyframe`).
 */
import { describe, it, expect } from 'vitest'
import { BOOT_KPI_TARGETS, parseBootKpis, type BootKpis } from '../fixtures/boot-kpis.ts'

/** Synthetic docker `-t` log of the measured 1.2.125 boot (t0 = 13:00:59.261Z). */
const T0 = '2026-08-16T13:00:59.261Z'
const line = (iso: string, msg: string): string => `${iso} ${msg}`

const BOOT_1_2_125 = [
  line('2026-08-16T13:00:59.494Z', '[entrypoint] starting @camstack/server@1.2.125'),
  line('2026-08-16T13:01:09.943Z', 'CamStack server listening'),
  line('2026-08-16T13:01:12.240Z', 'recorder addon started (continuous write path active)'),
  line('2026-08-16T13:01:13.569Z', 'First keyframe'),
  line('2026-08-16T13:03:41.000Z', 'recorder: full-archive index walk deferred'),
  line('2026-08-16T13:04:42.000Z', 'recorder pinned broker source(s) for recording'),
  line('2026-08-16T13:07:30.247Z', 'First keyframe'),
  line('2026-08-16T13:15:55.000Z', 'recorder: hydrated index from storage'),
].join('\n')

function expectMs(kpis: BootKpis, key: keyof BootKpis, approx: number, slack = 1_000): void {
  const value = kpis[key]
  expect(value, String(key)).not.toBeNull()
  expect(Math.abs((value as number) - approx)).toBeLessThanOrEqual(slack)
}

describe('parseBootKpis', () => {
  it('anchors t0 on the entrypoint line, not the docker StartedAt if absent', () => {
    const kpis = parseBootKpis(BOOT_1_2_125)
    expect(kpis.t0Iso).toBe('2026-08-16T13:00:59.494Z')
  })

  it('prefers an explicit t0 when the caller already knows container StartedAt', () => {
    const kpis = parseBootKpis(BOOT_1_2_125, { t0Iso: T0 })
    expect(kpis.t0Iso).toBe(T0)
    expectMs(kpis, 'apiMs', 11_000, 500)
  })

  it('scores the four operator numbers from the 1.2.125 boot shape', () => {
    const kpis = parseBootKpis(BOOT_1_2_125, { t0Iso: T0 })
    expectMs(kpis, 'apiMs', 10_682, 50)
    expectMs(kpis, 'writePathMs', 12_979, 50)
    expectMs(kpis, 'firstKeyframeMs', 14_308, 50)
    expectMs(kpis, 'lastKeyframeMs', 390_986, 50)
    expectMs(kpis, 'firstPinMs', 222_739, 50)
    expectMs(kpis, 'walkDeferredMs', 161_739, 50)
    expectMs(kpis, 'indexHydratedMs', 895_739, 50)
  })

  it('ignores lines that are not boot milestones', () => {
    const kpis = parseBootKpis(
      [
        line('2026-08-16T13:00:59.494Z', '[entrypoint] starting'),
        line('2026-08-16T13:01:00.000Z', 'some unrelated warn'),
      ].join('\n'),
    )
    expect(kpis.apiMs).toBeNull()
    expect(kpis.firstPinMs).toBeNull()
  })

  it('reads a JSON log body when docker -t is missing', () => {
    const kpis = parseBootKpis(
      [
        '{"timestamp":"2026-08-16T13:00:59.494Z","message":"[entrypoint] starting"}',
        '{"timestamp":"2026-08-16T13:01:09.943Z","message":"CamStack server listening"}',
      ].join('\n'),
    )
    expectMs(kpis, 'apiMs', 10_449, 50)
  })
})

describe('1.2.125 regression lock — do not get slower than the measured boot', () => {
  const kpis = parseBootKpis(BOOT_1_2_125, { t0Iso: T0 })

  it('API stays in the 10 s class', () => {
    expect(kpis.apiMs).toBeLessThanOrEqual(15_000)
  })

  it('first pin must not regress past the measured 223 s', () => {
    expect(kpis.firstPinMs).toBeLessThanOrEqual(223_000)
  })

  it('last keyframe must not regress past the measured 391 s', () => {
    expect(kpis.lastKeyframeMs).toBeLessThanOrEqual(391_000)
  })

  it('index hydrate must not regress past the measured 896 s', () => {
    expect(kpis.indexHydratedMs).toBeLessThanOrEqual(896_000)
  })
})

describe('operator targets (unmet on 1.2.125 — skip until Boot phase 2 lands)', () => {
  it.skip('first pin is under 30 s', () => {
    const kpis = parseBootKpis(BOOT_1_2_125, { t0Iso: T0 })
    expect(kpis.firstPinMs).toBeLessThan(BOOT_KPI_TARGETS.firstPinMs)
  })

  it.skip('last camera keyframe is under 90 s', () => {
    const kpis = parseBootKpis(BOOT_1_2_125, { t0Iso: T0 })
    expect(kpis.lastKeyframeMs).toBeLessThan(BOOT_KPI_TARGETS.lastKeyframeMs)
  })

  it.skip('archive index is hydrated under 120 s', () => {
    const kpis = parseBootKpis(BOOT_1_2_125, { t0Iso: T0 })
    expect(kpis.indexHydratedMs).toBeLessThan(BOOT_KPI_TARGETS.indexHydratedMs)
  })
})
