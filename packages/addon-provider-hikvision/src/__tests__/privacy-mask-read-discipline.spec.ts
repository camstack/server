import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What one open admin page costs THESE cameras.
 *
 * `pipelineOrchestrator.getCameraStatuses` composes the switched-off badge for
 * every camera and the admin page polls it every 5 seconds; the only authority
 * behind that badge that leaves the server is `privacy-mask`. On this fleet 20
 * of 29 cameras are Hikvision, so this provider IS the cost
 * ([D221](../../../../docs/decisions/adr-0221-a-polled-list-never-dials-a-camera.md)).
 *
 * Two independent leaks were closed, and both are structural — which is why
 * they are asserted against the source rather than a constructed camera
 * (building one needs the whole `DeviceContext`; the sibling specs take the
 * same approach):
 *
 *  - `getStatus` refreshed on a 10s window, so a 5s poll dialled the camera on
 *    essentially every read, ON the request path.
 *  - `getOptions` made its own pair of ISAPI calls with no window at all — the
 *    badge calls it once per camera per poll, so it dialled EVERY time.
 *
 * The fix is one freshness policy over the ONE read that fetches both, at the
 * source. A cache in the consumer instead of this is what D221 removed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../hikvision-camera.ts'), 'utf8')

/** The body of `registerPrivacyMaskCap`, brace-matched. */
function privacyMaskCapBody(): string {
  const signature = 'private registerPrivacyMaskCap('
  const start = cameraSource.indexOf(signature)
  if (start === -1) throw new Error('registerPrivacyMaskCap not found')
  let depth = 0
  let i = cameraSource.indexOf('{', cameraSource.indexOf(')', start))
  const bodyStart = i
  for (; i < cameraSource.length; i += 1) {
    const ch = cameraSource[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return cameraSource.slice(bodyStart, i + 1)
    }
  }
  throw new Error('registerPrivacyMaskCap body not closed')
}

/** The `getOptions:` property of the cap provider, up to the next property. */
function getOptionsBody(body: string): string {
  const start = body.indexOf('getOptions: async')
  if (start === -1) throw new Error('getOptions not found')
  const rest = body.slice(start)
  const next = /\n {6}(?:setMask|setAudioEnabled|getStatus):/.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

describe('hikvision privacy-mask — the read discipline a polled badge needs', () => {
  const body = privacyMaskCapBody()

  it('gives the status bridge the operator-written window, not the 10s default', () => {
    expect(body).toMatch(/staleMs:\s*OPERATOR_WRITTEN_STALE_MS/)
    expect(body).not.toMatch(/staleMs:\s*STALE_MS/)
  })

  it('serves a stale read and revalidates behind it, so no poll waits on ISAPI', () => {
    expect(body).toMatch(/staleRead:\s*'serve-and-revalidate'/)
  })

  it('the COLD slice reports unknown zones, never an empty list (D315)', () => {
    // `[]` is a real answer ("this camera has no zones") that consumers act
    // on: the switch group tells the operator to go and draw one, and the mask
    // editor opens on an empty canvas whose Save DELETEs every ISAPI slot
    // first. A camera nobody has reached must say `null` instead.
    const emptyBlock = body.slice(body.indexOf('empty: ():'), body.indexOf('const provider'))
    expect(emptyBlock).toMatch(/regions:\s*null/)
    expect(emptyBlock).not.toMatch(/regions:\s*\[\]/)
  })

  it('reports a refresh that stops landing, tagged per camera', () => {
    // Without a logger the bridge's miss cooldown is silent, and a camera that
    // has been answering defaults for an hour looks exactly like a working one.
    expect(body).toMatch(/logger:\s*this\.ctx\.logger/)
  })

  it('never dials the camera from getOptions', () => {
    const getOptions = getOptionsBody(body)
    // The availability facts come out of the SAME refresh that builds the
    // status slice. A second pair of reads here is the leak this closed.
    expect(getOptions).not.toMatch(/isapi\.getPrivacyMask/)
    expect(getOptions).not.toMatch(/readStreamAudioChannels/)
    expect(getOptions).toMatch(/bridge\.ensureFresh\(\)/)
  })

  it('survives an addon restart without re-probing every camera', () => {
    // An in-memory descriptor is empty after every deploy, so the first poll
    // after one would dial the whole fleet again — and the status slice, which
    // IS durable, would answer from the database while the options did not.
    expect(body).toMatch(/deviceCache'\)\?\.privacyMaskOptions/)
    expect(body).toMatch(/privacyMaskOptions: \{/)
  })

  it('writes the descriptor only when it MOVED', () => {
    // This runs on every refresh; a SQLite commit per refresh for an unchanged
    // model capability is pure churn.
    const persist = body.slice(body.indexOf('const persistOptions'))
    expect(persist).toMatch(/stored\.maxRegions === next\.maxRegions/)
    expect(persist).toMatch(/stored\.supportsAudioMute === next\.supportsAudioMute/)
  })

  it('probes ONCE when the descriptor is cold but the status slice is not', () => {
    // The two halves have different lifetimes: the status slice is durable and
    // can come back from the database still INSIDE the freshness window, in
    // which case `ensureFresh` correctly does nothing — and without this the
    // descriptor would stay missing for a whole window after every deploy.
    // Bounded, because "never answered" and "unreachable" are the same state.
    const getOptions = getOptionsBody(body)
    expect(getOptions).toMatch(/optionsProbeCooldownUntil/)
    expect(getOptions).toMatch(/RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS/)
    expect(getOptions).toMatch(/await refreshFromCamera\(\)/)
  })

  it('reports UNKNOWN options rather than describing a camera it never reached', () => {
    const getOptions = getOptionsBody(body)
    expect(getOptions).toMatch(/warm !== null/)
    expect(getOptions).toMatch(/cold !== null/)
    expect(getOptions).toMatch(/throw new Error/)
  })

  it('re-reads the camera after every write, which is what makes the window safe', () => {
    // The freshness window is only defensible because an operator's own change
    // never waits it out: each write path reads the camera back into the slice.
    const setMask = body.slice(body.indexOf('setMask: async'), body.indexOf('setAudioEnabled:'))
    expect(setMask).toMatch(/refreshFromCamera\(\)/)
  })
})
