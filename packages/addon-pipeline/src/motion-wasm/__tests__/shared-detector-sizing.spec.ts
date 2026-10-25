import { describe, it, expect, beforeAll } from 'vitest'
import { WasmMotionDetector } from '../wasm-motion-detector.js'

/**
 * ONE `WasmMotionDetector` serves every camera on a node — motion-wasm declares
 * `execution.group: 'detection'`, so `resolveRunnerId` puts one instance of it
 * in the node's single `detection` runner, and every camera's `analyze()` call
 * lands on it.
 *
 * The WASM is sized by `init(w, h)`, and the addon used to call `init` only
 * when a camera's OWN last-seen dimensions changed. Two cameras with different
 * frame sizes therefore left the WASM sized for whichever called `init` last —
 * for as long as neither changed size, which is indefinitely.
 *
 * Production has at least three sizes live at once (measured over 24 h on this
 * hub): 320x180 for a dedicated motion decode on a 16:9 camera, 320x142 for
 * camera 1441's 1200x536 sub stream, and 640x360 whenever a camera's motion
 * rides the DETECTION decode (`registerSharedMotionSink` derives gray from the
 * detection frame, which is not the motion view).
 *
 * These tests run the REAL `motion.wasm` and pin what the mismatch does, in
 * both directions, and that `ensureSize` removes it.
 */
describe('a shared detector sized for another camera', () => {
  let detector: WasmMotionDetector

  beforeAll(async () => {
    detector = new WasmMotionDetector()
    await detector.load()
  })

  const flat = (w: number, h: number, value: number): Uint8Array =>
    new Uint8Array(w * h).fill(value)

  it('reports motion between two IDENTICAL frames when the WASM is sized larger', () => {
    // Camera B (640x360) inited last; camera A (320x180) now feeds frames that
    // fill only a quarter of each buffer. The rest of both buffers is whatever
    // the previous run left there — different scratch in each — so the diff
    // sees an enormous change that is not in the picture at all.
    detector.init(640, 360)
    const a = flat(320, 180, 120)
    const b = flat(320, 180, 120)
    // Prime the scratch buffers the way a real previous frame would.
    detector.detect(flat(640, 360, 10), flat(640, 360, 200))

    const phantom = detector.detect(a, b, { minAreaFraction: 0 })
    expect(phantom.raw.length).toBeGreaterThan(0)
    const changed = phantom.raw.reduce((sum, r) => sum + r.pixels, 0)
    // Not a stray speck — most of the buffer beyond the real frame.
    expect(changed).toBeGreaterThan(320 * 180)
  })

  it('sees nothing between two identical frames once ensureSize has resized it', () => {
    detector.init(640, 360)
    detector.detect(flat(640, 360, 10), flat(640, 360, 200))

    detector.ensureSize(320, 180)
    const clean = detector.detect(flat(320, 180, 120), flat(320, 180, 120), { minAreaFraction: 0 })
    expect(clean.raw).toEqual([])
  })

  it('ensureSize is a no-op when the size already matches', () => {
    detector.init(320, 180)
    const prev = flat(320, 180, 30)
    const curr = flat(320, 180, 30)
    // A no-op resize must not discard the sizing, and must not itself create
    // motion — a needless re-init is cheap but a needless RESET is not.
    detector.ensureSize(320, 180)
    expect(detector.detect(prev, curr, { minAreaFraction: 0 }).raw).toEqual([])
  })

  it('reads only a sheared strip when the WASM is sized smaller than the frame', () => {
    // The other direction: camera A (320x180) inited last, camera B feeds
    // 640x360. The WASM compares a 320x180 window of a 640-wide image, so the
    // rows are misaligned and only the top of the picture is looked at. A
    // subject in the BOTTOM half of the frame is invisible.
    detector.init(320, 180)
    const prev = flat(640, 360, 100)
    const curr = flat(640, 360, 100)
    // A bright square low in the frame — well below the top 57 600 bytes the
    // mis-sized WASM will ever read.
    for (let y = 300; y < 340; y++) {
      for (let x = 300; x < 340; x++) curr[y * 640 + x] = 255
    }
    const blind = detector.detect(prev, curr, { minAreaFraction: 0 })
    expect(blind.raw).toEqual([])

    // Correctly sized, the same pair is obvious.
    detector.ensureSize(640, 360)
    const seen = detector.detect(prev, curr, { minAreaFraction: 0 })
    expect(seen.raw.length).toBeGreaterThan(0)
  })
})
