/**
 * A frame the onboard root publishes WILL be asked about, so it must be marked.
 *
 * The decode worker keeps a native copy of a superseded frame only when the
 * runner marked it, and the premise behind that mark is spelled out in
 * `decode-worker-child.ts`: "a native crop can only ever name a frameId that
 * rode an INFERENCE RESULT". That is why the call is named `markInferred` and
 * why it is sent from the enqueue turn.
 *
 * On a camera whose ROOT detector is the camera's own firmware the premise is
 * false. Nothing is enqueued to the ML, so nothing is marked — and yet the
 * result is published with a handle that post-analysis names seconds later.
 * The worker has been reporting exactly this, in its own words: `native crop
 * named an UNINFERRED frame … the 'inferred' lease-admission premise does not
 * hold on this path`.
 *
 * Measured on device 106 (Baby monitor), 2026-09-15, over three hours:
 * `leaseOffered: 645, leaseAdmitted: 1, leaseFrames: 0` — and with no lease the
 * frame park refuses every thumbnail ("native or nothing"), so 27 best shots
 * never landed and 43 detail subtrees resolved no crop source.
 *
 * Inference was never the fact the lease needed. It was a PROXY for "somebody
 * will ask for these pixels", and this is the one path where the proxy is false
 * while the fact is true.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const RUNNER = fs.readFileSync(path.join(__dirname, '..', 'runner.ts'), 'utf8')
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8')

describe('the onboard root marks its frame askable', () => {
  it('marks BEFORE publishing the result — the pull that supersedes it is next', () => {
    // The mark must reach the worker from the same synchronous turn: sent
    // after an await it arrives two pulls late, the frame has been freed, and
    // every crop on it is a `released` miss nobody released (59 in 20 min,
    // 2026-09-06 — the reason the ML site says the same thing in a comment).
    const branch = RUNNER.slice(
      RUNNER.indexOf('state.lastResultDetections = pairing.detections.length'),
    )
    const mark = branch.indexOf('markFrameAskable')
    const publish = branch.indexOf('this.notifyCallbacks(')
    expect(mark).toBeGreaterThan(0)
    expect(publish).toBeGreaterThan(0)
    expect(mark).toBeLessThan(publish)
  })

  it('marks only when there IS a handle — an unhandled frame names nothing', () => {
    const branch = RUNNER.slice(
      RUNNER.indexOf('state.lastResultDetections = pairing.detections.length'),
    )
    const line = branch.slice(
      branch.indexOf('markFrameAskable') - 40,
      branch.indexOf('markFrameAskable') + 40,
    )
    expect(line).toContain('if (handle)')
  })

  it('the host resolves the handle through the crop registry, live entries only', () => {
    const impl = INDEX.slice(INDEX.indexOf('markFrameAskable: (handle)'))
    const body = impl.slice(0, impl.indexOf('},'))
    expect(body).toContain('nativeCropRegistry.lookup(handle)')
    // An expired or unknown handle must not be marked: the requester is gone
    // and the lease it would claim no longer exists.
    expect(body).toContain("'live'")
    expect(body).toContain('markInferred')
  })
})
