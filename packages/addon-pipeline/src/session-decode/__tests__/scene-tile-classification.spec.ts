import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The scene tile is classified against the dimensions it was CUT from.
 *
 * `handleCutTiles` captures `frame.width/height` into `tileFrameWidth/Height`
 * BEFORE the cut (a freed NavFrame reports 0×0, and `serveFromTile` already
 * reads the captured pair for that reason). The scene/subject split ran after
 * the encode awaits and re-read `frame.width` — so whenever a `pull` released
 * the frame during a 4K JPEG encode, `isSceneRegion` saw 0×0, answered
 * false, and the ~2 MB scene raster was filed as a SUBJECT: `scenesCut` stayed
 * 0, the 48 MB scene store stayed empty, and the 64 MB subject store filled
 * with scenes and evicted the face/plate tiles it exists for. Measured on
 * `hub/detection` 2026-09-05: `tilesCut/scenesCut` 87:1 and 359/0 against a
 * structural ceiling of 4, `sceneRefused:0`, `tileCutFailures:0`, subject
 * store at 0.93 MB/frame against 0.2 on the agents. 16 100 detail dispatches
 * that day produced nothing.
 *
 * Structural, like `sws-dst-tail-slack.spec.ts`: the class is not exported,
 * and the two cut specs pass dimensions explicitly — the fake supplying the
 * value production forgot to read.
 */
const SOURCE = path.resolve(__dirname, '../decode-worker-child.ts')

function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start === -1) throw new Error(`method not found: ${signature}`)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced: ${signature}`)
}

describe('scene tile classification (decode-worker-child)', () => {
  const src = fs.readFileSync(SOURCE, 'utf-8')
  const body = methodBody(src, 'private async handleCutTiles(')

  it('partitions the cut against the CAPTURED frame size, never a re-read of the frame', () => {
    expect(body).toContain('partitionSceneTile(cut, this.tileFrameWidth, this.tileFrameHeight)')
    expect(body).not.toMatch(/partitionSceneTile\(cut,\s*frame\.width/)
  })

  it('counts a planned scene that came back unclassified — the branch that lost 16 100 enrichments in silence', () => {
    expect(body).toContain('this.sceneUnclassified += 1')
    // ...and reports it on the metrics line beside scenesCut.
    expect(src).toMatch(/sceneUnclassified:\$\{this\.sceneUnclassified\}/)
  })

  it('names the two ways a tile fallback misses: no tile for the frame, or no tile containing the rectangle', () => {
    expect(src).toContain('no retained tile for this frame')
    expect(src).toContain('no retained subject or scene tile contains the requested rectangle')
  })
})
