/**
 * Reolink stream-catalog — ONE re-auth retry on a dead Baichuan session.
 *
 * ## The failure this guards against (live, 2026-08-25, device 3629)
 *
 * `ensureApi()` returns the CACHED client whenever `this.api` is set. A
 * Baichuan session that expires under a socket that is STILL OPEN emits no
 * `close` and no `error`, so `scheduleReconnect` — the only thing that nulls
 * `this.api` — never fires. Every `buildVideoStreamOptions` then answers
 * `responseCode 400, empty body`, forever, and the broker's catalog pull for
 * that camera fails every 30 s: 35 minutes with no broker, no recording and no
 * detection on that device, cured only by restarting the addon.
 *
 * The fix is not a new auth flow: drop the cached client (the same
 * `close()` + `this.api = null` the `disconnectAll` / debug-options paths
 * already perform) and let the existing `ensureApi` log in again — ONCE.
 *
 * ## Why these are source-structure assertions
 *
 * Constructing a real `ReolinkCamera` needs the entire `DeviceContext` plus a
 * live Baichuan client mocked; every spec in this package tests this file
 * structurally for that reason (see `battery-stream-catalog-discipline.spec.ts`).
 * The invariants here are structural — *is the session dropped, is the retry
 * bounded, are hub children excluded* — and they survive refactors.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let i = source.indexOf('{', start)
  if (i === -1) throw new Error(`opening brace not found for ${methodSignature}`)
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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

const heavy = sliceMethodBody(cameraSource, 'private async buildStreamCatalogUncached(')

describe('ensureApi hands back a cached client — which is why the session must be dropped', () => {
  it('short-circuits on this.api, so a stale session survives every retry until it is nulled', () => {
    const body = sliceMethodBody(cameraSource, 'async ensureApi(')
    expect(body).toMatch(/if\s*\(this\.api\)\s*return this\.api/)
  })
})

describe('dropBaichuanSession — the invalidation the reconnect ladder cannot express', () => {
  const body = sliceMethodBody(cameraSource, 'private async dropBaichuanSession(')

  it('nulls the cached client so the next ensureApi logs in fresh', () => {
    expect(body).toMatch(/this\.api\s*=\s*null/)
  })

  it('closes the old client best-effort rather than leaking the socket', () => {
    expect(body).toMatch(/\.close\(\{\s*reason\s*\}\)/)
    expect(body).toMatch(/catch/)
  })
})

describe('buildStreamCatalogUncached — bounded re-auth retry on a stream-options failure', () => {
  it('drops the Baichuan session when buildVideoStreamOptions fails', () => {
    expect(heavy).toMatch(/await this\.dropBaichuanSession\(/)
  })

  it('re-logs in AFTER dropping the session, never before', () => {
    const dropIdx = heavy.indexOf('this.dropBaichuanSession(')
    const reEnsureIdx = heavy.indexOf('this.ensureApi(', dropIdx)
    expect(dropIdx).toBeGreaterThan(-1)
    expect(reEnsureIdx).toBeGreaterThan(dropIdx)
  })

  it('retries the stream-options read EXACTLY once — two attempts, no loop', () => {
    // A loop here is a login storm against a camera that is already refusing.
    // The broker's per-device ladder owns every attempt after these two.
    expect(countOccurrences(heavy, 'readStreamOptions(')).toBe(2)
    const retryRegion = heavy.slice(
      heavy.indexOf('this.dropBaichuanSession('),
      heavy.indexOf('after one re-auth retry'),
    )
    expect(retryRegion.length).toBeGreaterThan(0)
    expect(retryRegion).not.toMatch(/\b(while|for)\s*\(/)
  })

  it('excludes hub children — their session belongs to the parent Hub', () => {
    // Tearing down the shared parent socket because ONE child's GetEnc failed
    // is a fleet-scale action taken on a single-device signal.
    const dropIdx = heavy.indexOf('this.dropBaichuanSession(')
    const childGuardIdx = heavy.lastIndexOf('if (isChild) {', dropIdx)
    expect(childGuardIdx).toBeGreaterThan(-1)
    expect(childGuardIdx).toBeLessThan(dropIdx)
  })

  it('reports the drop with the numeric deviceId tag', () => {
    const warnIdx = heavy.indexOf('dropping the Baichuan session and retrying once')
    expect(warnIdx).toBeGreaterThan(-1)
    const region = heavy.slice(warnIdx, warnIdx + 400)
    expect(region).toMatch(/tags:\s*\{\s*deviceId:\s*this\.id\s*\}/)
  })

  it('still THROWS when the retry also fails — [] and an error are different facts', () => {
    // Returning [] would tell the broker "this camera has no streams", which
    // is a claim we cannot make about a camera we could not read.
    expect(heavy).toMatch(/after one re-auth retry/)
  })
})
