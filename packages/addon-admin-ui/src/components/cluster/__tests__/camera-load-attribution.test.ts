/**
 * The per-camera attribution table.
 *
 * These are guards, not descriptions. The rule they enforce — a chart that
 * shows a number the system cannot attribute is worse than no chart — is
 * enforceable here and nowhere else: once a row claims `measured` + `wired`,
 * the UI will plot it.
 */
import { describe, expect, it } from 'vitest'
import {
  CAMERA_LOAD_ATTRIBUTION,
  isChartablePerCamera,
  type CameraLoadFamily,
} from '../load/camera-load-attribution'

const EXPECTED_FAMILIES: readonly CameraLoadFamily[] = [
  'decode',
  'transcode',
  'recording',
  'detection',
  'streaming',
]

describe('CAMERA_LOAD_ATTRIBUTION', () => {
  it('covers every family the operator asked about, exactly once', () => {
    const families = CAMERA_LOAD_ATTRIBUTION.map((r) => r.family)
    expect([...families].toSorted()).toEqual([...EXPECTED_FAMILIES].toSorted())
    expect(new Set(families).size).toBe(families.length)
  })

  it('classifies detection as a SHARED pool — countable, never measurable', () => {
    const detection = CAMERA_LOAD_ATTRIBUTION.find((r) => r.family === 'detection')
    expect(detection?.attribution).toBe('accounted')
    expect(detection?.perCamera).toBe(false)
  })

  it('never marks the shared pool chartable per camera, even though counting exists', () => {
    // `wiredToday` is TRUE for detection — the per-device counters really do
    // run. The gate must still refuse it: counted work is not measured cost,
    // and plotting it on a load axis would make it look like cost.
    const detection = CAMERA_LOAD_ATTRIBUTION.find((r) => r.family === 'detection')
    expect(detection?.wiredToday).toBe(true)
    expect(isChartablePerCamera(detection!)).toBe(false)
  })

  it('marks the three families whose addon now reports itself as chartable', () => {
    // Each of these has a per-camera child process and the addon that spawns
    // it claims it (`load-contribution`). Nothing joins a pid to a camera:
    // the spawn site already knew both.
    for (const family of ['decode', 'transcode', 'recording'] as const) {
      const row = CAMERA_LOAD_ATTRIBUTION.find((r) => r.family === family)
      expect(row?.attribution, family).toBe('measured')
      expect(row?.perCamera, family).toBe(true)
      expect(row?.wiredToday, family).toBe(true)
      expect(isChartablePerCamera(row!), family).toBe(true)
    }
  })

  it('keeps STREAMING unchartable — the ffmpeg path is the minority path', () => {
    // A native source spawns no child at all: its streaming cost is in-process
    // ring occupancy and the counter for it is still private. Flipping this
    // row would promise a number for every camera and deliver one only for the
    // cameras that happen to need an ffmpeg parser.
    const streaming = CAMERA_LOAD_ATTRIBUTION.find((r) => r.family === 'streaming')
    expect(streaming?.perCamera).toBe(true)
    expect(streaming?.wiredToday).toBe(false)
    expect(isChartablePerCamera(streaming!)).toBe(false)
  })

  it('has no slot for a VALUE — the field that stops an estimate looking measured', () => {
    // The shared pool reports a real, large cost. The only thing that keeps it
    // off a per-camera axis is that this row type cannot carry a number at
    // all. Adding one would make apportioning it a one-line change.
    for (const row of CAMERA_LOAD_ATTRIBUTION) {
      for (const key of Object.keys(row)) {
        expect(
          ['cpu', 'cost', 'value', 'percent', 'bytes', 'seconds'].some((banned) =>
            key.toLowerCase().includes(banned),
          ),
          `${row.family}.${key}`,
        ).toBe(false)
      }
    }
  })

  it('requires a stated missing link on every family the chart refuses', () => {
    // Stronger than "wherever nothing is wired", and it has to be:
    // `CameraLoadPanel` now renders `missingLink` for EVERY non-chartable
    // family, unconditionally, as the only place an operator is told why a
    // family is absent. A refused family with an empty string would print a
    // bare name and read as "free". `detection` is the case that makes the two
    // rules differ — it is wired and still refused.
    for (const row of CAMERA_LOAD_ATTRIBUTION) {
      if (isChartablePerCamera(row)) continue
      expect(row.missingLink.length, row.family).toBeGreaterThan(0)
    }
  })

  it('backs every row with `file:line` evidence', () => {
    for (const row of CAMERA_LOAD_ATTRIBUTION) {
      expect(row.evidence.length, row.family).toBeGreaterThan(0)
      for (const e of row.evidence) {
        expect(e, `${row.family}: ${e}`).toMatch(/^[\w./@-]+\.ts:\d+$/)
      }
    }
  })
})
