import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Reolink battery-cam sleep poll — active-consumer teardown guard.
 *
 * Root cause this guards against:
 *   `api.getSleepStatus()` infers "sleeping" from recent Baichuan
 *   CONTROL-socket command history. During a live stream the video
 *   flows over a SEPARATE rfc4571 media path (a dedicated session
 *   socket), and the lib's own active-streaming guard keys off
 *   `activeVideoMsgNums`, which briefly empties whenever an rfc4571
 *   server idle-tears-down (~15s with no TCP client) and recreates
 *   between broker pulls. In that window `getSleepStatus` can return
 *   "sleeping" even though a consumer is actively watching. The old
 *   poll then called `closeActiveStreams('sleep-poll')` unconditionally,
 *   killing the live stream — the broker re-dialled, the cam re-woke,
 *   and the camera flapped sleep<->wake every ~30-50s ("the stream
 *   doesn't work at all", torn down within ~30s).
 *
 * The fix: when we hold live rfc4571 servers (`this.active.size > 0`)
 * a genuine consumer is attached and continuously pulling — keeping the
 * cam awake — so the poll must NOT flip the sleeping slice or tear the
 * streams down. It defers to the firmware `sleeping` push / stream-idle
 * teardown (which drains `this.active`) for the real transition.
 *
 * Matches this file's own `sleeping` simpleEvent handler
 * (`if (this.active.size > 0)`).
 *
 * Source-structure assertions (same approach as battery-update-polling
 * and intercom specs): constructing the full `ReolinkCamera` requires
 * mocking the entire `DeviceContext`. The invariant we care about — the
 * poll's "sleeping" branch is gated on active streams BEFORE it tears
 * down — is structural and survives surrounding refactors.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let depth = 0
  let i = source.indexOf('{', start)
  if (i === -1) throw new Error(`opening brace not found for ${methodSignature}`)
  const bodyStart = i
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`closing brace not found for ${methodSignature}`)
}

describe('Reolink sleep poll — active-stream teardown guard', () => {
  const body = sliceMethodBody(cameraSource, 'private startSleepPoll()')

  it('still reacts to the "sleeping" inference only when not already sleeping', () => {
    expect(body).toMatch(/status\.state === 'sleeping' && !this\.sleeping/)
  })

  it('guards the "sleeping" teardown on the active-stream count', () => {
    // The gate must check `this.active.size > 0` (live rfc4571 servers
    // = a genuine, attached consumer) inside the "sleeping" branch.
    expect(body).toMatch(/if\s*\(this\.active\.size > 0\)/)
  })

  it('the active-stream gate appears BEFORE the closeActiveStreams call (so it can short-circuit it)', () => {
    const gateIdx = body.indexOf('this.active.size > 0')
    const teardownIdx = body.indexOf("closeActiveStreams('sleep-poll')")
    expect(gateIdx).toBeGreaterThan(-1)
    expect(teardownIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(teardownIdx)
  })

  it('short-circuits the tick (returns) when streams are active instead of falling through to teardown', () => {
    // Between the active-stream gate and the teardown there must be a
    // `return` that bails out of the tick — otherwise the guard would
    // not actually prevent the teardown.
    const gateIdx = body.indexOf('this.active.size > 0')
    const teardownIdx = body.indexOf("closeActiveStreams('sleep-poll')")
    const between = body.slice(gateIdx, teardownIdx)
    expect(between).toMatch(/\breturn\b/)
  })

  it('does NOT flip the battery.sleeping slice while streams are active', () => {
    // The slice write must live AFTER the active-stream short-circuit,
    // so an active stream never commits a (false) sleeping transition.
    const gateIdx = body.indexOf('this.active.size > 0')
    const sliceWriteIdx = body.indexOf("this.commitSleepState(true, 'sleep-poll')")
    expect(sliceWriteIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(sliceWriteIdx)
  })

  it('writes the slice through commitSleepState, never directly', () => {
    // `commitSleepState` is the single writer: it owns the hysteresis
    // window AND the `sleepStateChangedAt` stamp. The poll used to
    // assign `this.state.battery.sleeping` directly, which bypassed both
    // — so a poll-driven flip left the timestamp stale and the NEXT
    // simpleEvent was compared against an ancient change time.
    expect(body).not.toMatch(/this\.state\.battery\.sleeping\s*=/)
    expect(body).toContain("this.commitSleepState(true, 'sleep-poll')")
    expect(body).toContain("this.commitSleepState(false, 'sleep-poll')")
  })

  it('still tears down when there are NO active streams (genuine idle sleep)', () => {
    // The unconditional-teardown path must remain reachable for the
    // real case (cam genuinely idle, no consumer) so battery is not
    // drained by a stream kept open against a sleeping camera.
    expect(body).toContain("closeActiveStreams('sleep-poll')")
  })
})
