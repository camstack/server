import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A connection settings change must not be swallowed by a login in flight.
 *
 * Seen live on the MagiCam (device 5912, 2026-11-23): the operator switched
 * `udpDiscoveryMethod` relay → local-direct while a relay login was still
 * dialling. `disconnectAll` closed the cached client, but `loginPromise` kept
 * the relay attempt alive, and every demand joined it, so the camera never
 * dialled locally. With internet blocked it went offline.
 *
 * Source-structure assertions, like the other ensureApi specs in this
 * package: constructing the full ReolinkCamera needs the whole DeviceContext
 * mocked. The live switch on 5912 is the behavioural proof.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let i = source.indexOf('{', start)
  const bodyStart = i
  let depth = 0
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

describe('a login dialled with replaced settings is abandoned', () => {
  it('disconnectAll bumps the login generation, drops loginPromise and aborts the pending client', () => {
    const body = sliceMethodBody(cameraSource, 'async disconnectAll(')
    expect(body).toMatch(/this\.loginGeneration \+= 1/)
    expect(body).toMatch(/this\.loginPromise = null/)
    expect(body).toMatch(/pending\.close\(/)
  })

  it('ensureApi refuses to adopt a client whose login started under an older generation', () => {
    const body = sliceMethodBody(cameraSource, 'async ensureApi(')
    const captureIdx = body.indexOf('const generation = this.loginGeneration')
    const guardIdx = body.indexOf('if (generation !== this.loginGeneration) {')
    const adoptIdx = body.indexOf('this.api = api')
    expect(captureIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(captureIdx)
    expect(adoptIdx).toBeGreaterThan(guardIdx)
  })

  it('a superseded failure does not mark the camera unreachable', () => {
    const body = sliceMethodBody(cameraSource, 'async ensureApi(')
    const supersededIdx = body.indexOf('throw supersededLoginError(err)')
    const unreachableIdx = body.indexOf('this.noteUnreachable(')
    expect(supersededIdx).toBeGreaterThan(-1)
    expect(unreachableIdx).toBeGreaterThan(supersededIdx)
  })
})
