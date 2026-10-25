import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What one open admin page costs THESE cameras.
 *
 * `pipelineOrchestrator.getCameraStatuses` composes the switched-off badge for
 * every camera and the admin page polls it every 5 seconds; the only authority
 * behind that badge that leaves the server is `privacy-mask`. With the 10s
 * window this bridge used to carry, the slice was stale on nearly every poll,
 * so the badge dialled every camera twelve times a minute for two facts an
 * operator changes by hand
 * ([D221](../../../../docs/decisions/adr-0221-a-polled-list-never-dials-a-camera.md)).
 *
 * Structural assertions, like the sibling battery specs: constructing a
 * `ReolinkCamera` needs the whole `DeviceContext`, while the invariant is a
 * property of how the bridge is configured and survives refactors around it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

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

describe('reolink privacy-mask — the read discipline a polled badge needs', () => {
  const body = privacyMaskCapBody()

  it('gives the status bridge the operator-written window, not the 10s default', () => {
    expect(body).toMatch(/staleMs:\s*OPERATOR_WRITTEN_STALE_MS/)
    expect(body).not.toMatch(/staleMs:\s*STALE_MS/)
  })

  it('serves a stale read and revalidates behind it, so no poll waits on the camera', () => {
    expect(body).toMatch(/staleRead:\s*'serve-and-revalidate'/)
  })

  it('does NOT hand the bridge a logger, because the sleep gate would cry wolf', () => {
    // `sleepGatedRefresh` makes a refresh a deliberate no-op on a sleeping
    // battery camera, so `lastFetchedAt` never advances and the bridge's miss
    // line fires forever on cameras that are perfectly fine — measured at 4
    // lines per 5 minutes per camera. The REAL Reolink failure is reported by
    // `resolveCapOptions`, with the firmware's own error and the same tag.
    const bridgeCall = body.slice(
      body.indexOf('createRuntimeStateBridge({'),
      body.indexOf('const provider'),
    )
    expect(bridgeCall).not.toMatch(/logger:/)
  })

  it('keeps getOptions off the camera, through the persisted descriptor', () => {
    const getOptions = body.slice(body.indexOf('getOptions: async'), body.indexOf('setMask: async'))
    expect(getOptions).toMatch(/this\.resolveCapOptions\(/)
  })

  it('the COLD slice reports unknown zones, never an empty list (D315)', () => {
    // This provider is where the collapse actually bit: `sleepGatedRefresh`
    // makes a refresh a deliberate no-op on a sleeping battery camera, so the
    // slice can stay cold for days. While `empty()` said `regions: []`, every
    // reader was handed a positive claim — the switch group turned it into
    // "nothing is set up for it to act on" (go and draw a zone) and the mask
    // editor seeded an empty canvas one Save away from deleting the real one.
    const emptyBlock = body.slice(body.indexOf('empty: ():'), body.indexOf('const provider'))
    expect(emptyBlock).toMatch(/regions:\s*null/)
    expect(emptyBlock).not.toMatch(/regions:\s*\[\]/)
  })

  it('re-reads the camera after every write, which is what makes the window safe', () => {
    // The freshness window is only defensible because an operator's own change
    // never waits it out: each write path reads the camera back into the slice.
    const setMask = body.slice(body.indexOf('setMask: async'), body.indexOf('setAudioEnabled:'))
    expect(setMask).toMatch(/refreshFromCamera\(\)/)
    const setAudio = body.slice(body.indexOf('setAudioEnabled: async'))
    expect(setAudio).toMatch(/refreshFromCamera\(\)/)
  })
})

/**
 * The OTHER unbounded read on the same polled path.
 *
 * `privacyMask.getOptions` resolves through `resolveCapOptions`, whose 6h
 * persisted TTL is what keeps it off the camera — but only once a probe has
 * SUCCEEDED. A probe that fails persists nothing, so before this every poll
 * re-probed. Measured on the live hub (2026-08-21, device 3629, a battery
 * Reolink the registry already reports offline): `getOptions` took **23.1s on
 * every call**, while its `getStatus` sibling answered in 8ms — because the
 * runtime-state bridge opens a miss cooldown and this did not.
 */
describe('reolink cap options — a probe that fails is not paid for twice', () => {
  const body = ((): string => {
    const signature = 'private async resolveCapOptions<T>'
    const start = cameraSource.indexOf(signature)
    if (start === -1) throw new Error('resolveCapOptions not found')
    const rest = cameraSource.slice(start)
    const next = /\n {2}(?:\/\*\*|private |public )/.exec(rest.slice(signature.length))
    return next ? rest.slice(0, signature.length + next.index) : rest
  })()

  it('opens a cooldown on a failed probe, using the bridge own constant', () => {
    expect(body).toMatch(/capOptionsMissCooldownUntil\.set\(/)
    expect(body).toMatch(/RUNTIME_STATE_REFRESH_MISS_COOLDOWN_MS/)
  })

  it('short-circuits inside the cooldown, BEFORE the probe', () => {
    const gateIdx = body.indexOf('capOptionsMissCooldownUntil.get(')
    const probeIdx = body.indexOf('const started = probe()')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(probeIdx)
  })

  it('says so out loud, tagged per camera', () => {
    // A cap that has been answering `fallback()` for an hour is exactly the
    // silence that makes an unreachable camera look configured. The old line
    // was `debug`.
    const failure = body.slice(body.indexOf('} catch (err)'))
    expect(failure).toMatch(/this\.ctx\.logger\.warn\(/)
    expect(failure).toMatch(/tags: \{ deviceId: this\.id \}/)
  })

  it('shares an in-flight probe instead of starting a second dial', () => {
    // The cooldown only opens once a probe has FAILED, and on an unreachable
    // camera that is 23.1s away — so without this every poll arriving inside
    // those seconds started its own dial and the cooldown bounded nothing.
    const gateIdx = body.indexOf('this.capOptionsInFlight.has(capName)')
    const probeIdx = body.indexOf('const started = probe()')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeGreaterThan(-1)
    // And it SERVES rather than queues: waiting for a probe that is not coming
    // back is how one unreachable camera stalls every poll it overlaps.
    expect(body.slice(gateIdx, gateIdx + 160)).toMatch(/return cached\?\.value \?\? fallback\(\)/)
    expect(gateIdx).toBeLessThan(probeIdx)
    expect(body).toMatch(/capOptionsInFlight\.set\(capName, started\)/)
    expect(body).toMatch(/capOptionsInFlight\.delete\(capName\)/)
  })

  it('clears the cooldown once a probe lands', () => {
    expect(body).toMatch(/capOptionsMissCooldownUntil\.delete\(capName\)/)
  })
})
