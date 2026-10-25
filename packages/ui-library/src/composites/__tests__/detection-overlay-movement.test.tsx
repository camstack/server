// @vitest-environment jsdom
/**
 * The live overlay splits MOVING from STATIONARY, as two switches over one
 * list — the same split the viewer's overlay panel offers, which the admin UI
 * did not have.
 *
 * The case that decides the design: a track the tracker has NOT judged yet.
 * `StateAnalyzer` needs ~10 s to call a subject stationary, so every new
 * subject arrives with no verdict. Filing that under "stationary" would make a
 * person who just walked into frame invisible to an operator watching moving
 * subjects — the exact opposite of what either switch is for.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ObjectDetection, TrackState } from '@camstack/types'
import { DetectionOverlay } from '../detection-overlay'

function det(id: string, state?: TrackState): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x: 10, y: 10, width: 40, height: 80 },
    ...(state === undefined
      ? { track: { trackId: `t-${id}` } }
      : { track: { trackId: `t-${id}`, movementState: state } }),
  } as ObjectDetection
}

function overlay(
  dets: readonly ObjectDetection[],
  props: { showMoving?: boolean; showStationary?: boolean },
): HTMLElement {
  const { container } = render(
    <DetectionOverlay
      detections={
        {
          motion: null,
          motionRaw: null,
          detection: { detections: dets, frameWidth: 1000, frameHeight: 1000 },
          phase: 'active',
        } as never
      }
      showPhaseIndicator={false}
      showMotionZones={false}
      showMotionRaw={false}
      {...props}
    />,
  )
  return container
}

const boxCount = (el: HTMLElement): number => el.querySelectorAll('[class*="border-2"]').length

describe('DetectionOverlay — moving vs stationary', () => {
  it('draws both when both switches are on', () => {
    expect(boxCount(overlay([det('a', 'moving'), det('b', 'idle')], {}))).toBe(2)
  })

  it('hides the parked one when stationary is off', () => {
    const el = overlay([det('a', 'moving'), det('b', 'idle')], { showStationary: false })
    expect(boxCount(el)).toBe(1)
  })

  // `left` is the tracker saying the subject walked out of the anchor. It is
  // the other half of what the evidence ledger refuses to count (D494), and it
  // belongs on the MOVING switch, not the parked one.
  it('keeps a track that has LEFT under moving', () => {
    expect(boxCount(overlay([det('a', 'left')], { showStationary: false }))).toBe(1)
    expect(boxCount(overlay([det('a', 'left')], { showMoving: false }))).toBe(0)
  })

  // The rule that matters: no verdict is NOT still.
  it('keeps an unjudged track under MOVING, never under stationary', () => {
    expect(boxCount(overlay([det('fresh')], { showStationary: false }))).toBe(1)
    expect(boxCount(overlay([det('fresh')], { showMoving: false }))).toBe(0)
  })

  it('the master switch still turns everything off', () => {
    const { container } = render(
      <DetectionOverlay
        detections={
          {
            motion: null,
            motionRaw: null,
            detection: { detections: [det('a', 'moving')], frameWidth: 1000, frameHeight: 1000 },
            phase: 'active',
          } as never
        }
        showPhaseIndicator={false}
        showMotionZones={false}
        showMotionRaw={false}
        showDetections={false}
      />,
    )
    expect(boxCount(container)).toBe(0)
  })
})

/**
 * The census is a LAYER, not a filter over detections. A promoted parked object
 * has been dropped from the tracker on purpose, so it is absent from the
 * detection stream — an overlay that looked for it there drew almost nothing,
 * which is exactly what the operator reported.
 */
describe('DetectionOverlay — the census layer', () => {
  const parked = (id: string) => ({
    id,
    className: 'vehicle',
    x1: 0.1,
    y1: 0.1,
    x2: 0.3,
    y2: 0.4,
    becameStationaryAt: Date.now() - 3 * 60 * 60_000,
  })

  function withCensus(props: {
    showStationary?: boolean
    showDetections?: boolean
    stationaryObjects?: ReturnType<typeof parked>[]
  }): HTMLElement {
    const { container } = render(
      <DetectionOverlay
        detections={{ motion: null, motionRaw: null, detection: null, phase: 'watching' } as never}
        showPhaseIndicator={false}
        showMotionZones={false}
        showMotionRaw={false}
        {...props}
      />,
    )
    return container
  }

  const censusCount = (el: HTMLElement): number => el.querySelectorAll('[data-census-box]').length

  it('draws a parked object with NO detections on the frame at all', () => {
    expect(censusCount(withCensus({ stationaryObjects: [parked('p1')] }))).toBe(1)
  })

  it('the stationary switch governs it', () => {
    expect(boxCount(withCensus({ stationaryObjects: [parked('p1')], showStationary: false }))).toBe(
      0,
    )
  })

  it('the master detections switch still turns it off', () => {
    expect(boxCount(withCensus({ stationaryObjects: [parked('p1')], showDetections: false }))).toBe(
      0,
    )
  })

  // Absent is NOT an empty lot: a caller that has not fetched the census must
  // not make the overlay claim there is nothing parked.
  it('draws nothing when the census was never fetched', () => {
    expect(censusCount(withCensus({}))).toBe(0)
  })
})
