/**
 * `showControls={false}` means the HOST draws the chrome — ALL of it.
 *
 * The player is embedded by the viewer app, which lays a full-bleed gesture
 * layer over the video (pinch / pan / tap). Every touch that lands on the
 * picture belongs to that layer, so a button this component draws inside its
 * own box is visible and can never be pressed. The operator hit exactly that:
 * "esce un pulsante sullo stream ma non è cliccabile." [a button shows up on the stream but it is not clickable]
 *
 * A first pass gated the CORNER spinner and the corner retry. The full-cover
 * error surface — the one carrying the big Reconnect button — was left ungated,
 * so a button still rendered where it could not be reached. Both covered
 * surfaces are gated now, and this pins them: a host that draws its own chrome
 * gets NO chrome from here, and receives the failure through the state chain
 * instead (`onError` / `onStateChange` → its own transport bar).
 *
 * A standalone embed (`showControls` defaults true) keeps everything — there is
 * no host bar to move it to, and no gesture layer in the way.
 *
 * Source guards: the covered surfaces are conditional JSX inside a component
 * that owns a live RTCPeerConnection, and the property being defended is a rule
 * ("nothing chrome-like renders un-gated"), not a rendered pixel.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLAYER = join(__dirname, '..', 'camera-stream-player.tsx')
const src = readFileSync(PLAYER, 'utf8')

describe('the embed draws no chrome when the host owns it', () => {
  it('gates the full-cover CONNECTING loader', () => {
    expect(src).toContain("{showControls && !stillImg && state === 'connecting' && (")
  })

  it('gates the full-cover ERROR surface — the one with the Reconnect button', () => {
    expect(src).toContain(
      "{showControls && !stillImg && (state === 'error' || state === 'disconnected') && (",
    )
  })

  it('gates the corner spinner and the corner retry', () => {
    expect(src).toContain(
      "{showControls && stillImg && (state === 'connecting' || state === 'disconnected') && (",
    )
    expect(src).toContain("{showControls && stillImg && state === 'error' && (")
  })

  it('leaves no un-gated onClick={handleReconnect} anywhere', () => {
    // Every reconnect affordance in this file must sit under a `showControls`
    // branch. Counting them is the cheap way to catch a NEW one added outside.
    const reconnectButtons = src.match(/onClick=\{handleReconnect\}/g) ?? []
    const gatedBranches = src.match(/\{showControls && /g) ?? []
    expect(reconnectButtons).toHaveLength(2)
    expect(gatedBranches.length).toBeGreaterThanOrEqual(4)
  })
})

describe('the auto-retry loop is visible from end to end', () => {
  it('reports every attempt AND the exhaustion edge to the host', () => {
    expect(src).toContain('onReconnectAttempt?: (action: ReconnectAction) => void')
    expect(src).toContain('onReconnectAttemptRef.current?.(action)')
  })

  it('makes exhaustion a hard error instead of returning silently', () => {
    // The previous shape returned without a trace when the budget ran out: the
    // loop stopped, the surface kept whatever state it last had, and nothing
    // was logged. A camera stayed dark while looking busy.
    expect(src).toContain("if (action.kind === 'exhausted')")
    expect(src).toContain('reconnect attempts exhausted')
  })

  it('feeds the no-decoded-frame watchdog into the same error state', () => {
    // The client twin of the server's answered-but-silent guard. As a log line
    // alone it left the player reporting "playing" over a black surface, with
    // nothing for the operator to act on.
    expect(src).toContain("reportHardErrorRef.current('no decoded frame after connect')")
    // …and it must RETRY, not just complain.
    const watchdog = src.slice(src.indexOf("'no decoded frame after connect'"))
    expect(watchdog.slice(0, 200)).toContain('scheduleReconnect()')
  })

  it('a manual reconnect resets the budget rather than replacing the loop', () => {
    const manual = src.slice(src.indexOf('const handleReconnect = () => {'))
    expect(manual.slice(0, 200)).toContain('reconnectAttemptsRef.current = 0')
  })
})
