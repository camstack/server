/**
 * Both negotiation paths must attach the PLI / Receiver-Report listener.
 *
 * `session.ts` loads werift through a dynamic-import shim the vitest runner
 * cannot resolve, so `AdaptiveSession` cannot be driven here (see
 * `webrtc-client-offer-answer.spec.ts`). This reads the source instead: the
 * client-offer path (`handleOffer`, used by every browser and the native embed)
 * shipped without `setupPliListener()`, so a viewer's PLI was dropped — a lost
 * reference frame froze the picture until the camera's next natural IDR — and
 * no RTCP RR ever arrived (`hasReceiverReport=false` on every live session).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('../session.ts', import.meta.url), 'utf8')

/** The body of `async <name>(` up to the next method declared at the same indent. */
function methodBody(name: string): string {
  const start = SOURCE.indexOf(`\n  async ${name}(`)
  expect(start, `method ${name} not found`).toBeGreaterThan(-1)
  const next = SOURCE.slice(start + 1).search(
    /\n  (?:async |private |public |get |static )?[A-Za-z_]+\(/,
  )
  return next === -1 ? SOURCE.slice(start) : SOURCE.slice(start, start + 1 + next)
}

describe('AdaptiveSession PLI wiring', () => {
  it('the server-offer path attaches the PLI listener', () => {
    expect(methodBody('createOffer')).toContain('this.setupPliListener()')
  })

  it('the client-offer path attaches the PLI listener too', () => {
    expect(methodBody('handleOffer')).toContain('this.setupPliListener()')
  })
})
