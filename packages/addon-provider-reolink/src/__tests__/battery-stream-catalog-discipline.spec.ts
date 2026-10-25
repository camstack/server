import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Reolink BATTERY doorbell — BCUDP socket discipline for stream-catalog.
 *
 * Root cause this guards against (verified live on device 8 "Campanello"):
 *   The doorbell talks Baichuan over BCUDP — a single reliable byte-stream
 *   with ONE monotonic sequence shared by every command; the receiver only
 *   advances on contiguous packets, and the library does NOT serialize
 *   writes. GetEnc (cmd_id 56) returns a MULTI-packet Compression XML
 *   (main/sub/third), unlike the single-packet aux replies.
 *
 *   camstack used to fire a CONCURRENT BURST on every wake —
 *   `onWakeTransition` → `Promise.allSettled([alignAuxDevicesState(),
 *   refreshParentSettingsSnapshot()])`, with `alignAuxDevicesState` itself
 *   fanning out PIR + floodlight + siren concurrently — PLUS a force-wake +
 *   GetEnc on the broker's 30s reconcile poll. The heavy GetEnc reply got
 *   starved behind the burst and blew its timeout (`Baichuan timeout
 *   cmdId=56`), so `buildVideoStreamOptions` never returned and the broker
 *   had no entry → "No broker for stream 8/...". The force-wake also drained
 *   the battery by waking the cam every 30s forever.
 *
 *   The SAME doorbell with the SAME library succeeds purely by driving the
 *   socket gently: SEQUENTIAL refreshes,
 *   GetEnc read ONCE and cached (never re-fired on a poll), and NOTHING
 *   proactive on wake. This is the discipline ported here.
 *
 * Source-structure assertions (same approach as
 * sleep-poll-active-stream-guard / battery-update-polling specs):
 * constructing the full ReolinkCamera needs the entire DeviceContext mocked;
 * the invariants we care about are structural and survive refactors. Live
 * verification on the doorbell is the behavioural proof.
 */

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

describe('Reolink battery doorbell — wake fan-out is serialized (no BCUDP burst)', () => {
  it('alignAuxDevicesState refreshes accessories SEQUENTIALLY, not via Promise.allSettled', () => {
    const body = sliceMethodBody(cameraSource, 'private async alignAuxDevicesState(')
    // No concurrent fan-out: each accessory refresh must complete before the
    // next is issued so the heavy replies never collide on the BCUDP stream.
    expect(body).not.toMatch(/Promise\.allSettled/)
    expect(body).toMatch(/await\s+ref\.refreshFromAlign\(\)/)
  })

  it('onWakeTransition runs its refreshes SEQUENTIALLY, not via Promise.allSettled', () => {
    const body = sliceMethodBody(cameraSource, 'private async onWakeTransition(')
    expect(body).not.toMatch(/Promise\.allSettled/)
    expect(body).toMatch(/await\s+this\.alignAuxDevicesState\(/)
    expect(body).toMatch(/await\s+this\.refreshParentSettingsSnapshot\(\)/)
  })

  it('runBatteryUpdate runs its refreshes SEQUENTIALLY, not via Promise.allSettled', () => {
    const body = sliceMethodBody(cameraSource, 'private async runBatteryUpdate(')
    expect(body).not.toMatch(/Promise\.allSettled/)
  })
})

describe('Reolink battery doorbell — stream catalog cache-once, no force-wake', () => {
  const wrapper = sliceMethodBody(cameraSource, 'private async buildStreamCatalog(')
  const heavy = sliceMethodBody(cameraSource, 'private async buildStreamCatalogUncached(')

  it('does NOT force-wake the camera (no api.wakeUp) on the catalog path', () => {
    // Force-waking on every 30s reconcile drained the battery and never
    // helped — the wake is the on-demand dial's job, not the catalog poll's.
    expect(wrapper).not.toMatch(/\.wakeUp\(/)
    expect(heavy).not.toMatch(/\.wakeUp\(/)
  })

  it('serves the cached profile-stable catalog before delegating to any socket I/O', () => {
    // The cache short-circuit must appear BEFORE the heavy (socket) path so a
    // cached catalog is served without touching (and therefore without
    // waking) the camera. SUCCESS-path cache, not an error fallback.
    const cacheIdx = wrapper.indexOf('cachedStreamDescriptors')
    const heavyCallIdx = wrapper.indexOf('buildStreamCatalogUncached(')
    expect(cacheIdx).toBeGreaterThan(-1)
    expect(heavyCallIdx).toBeGreaterThan(-1)
    expect(cacheIdx).toBeLessThan(heavyCallIdx)
  })

  it('does not call ensureApi while a battery cam is sleeping and uncached (no wake)', () => {
    // Asleep + nothing cached yet is not an error: return without waking;
    // the build-on-wake path fills the cache when the cam comes up naturally.
    const guardIdx = heavy.indexOf('this.isBattery && this.sleeping')
    const ensureIdx = heavy.indexOf('ensureApi(')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(ensureIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(ensureIdx)
  })

  it('is single-flighted so concurrent broker pulls do not stack GetEnc calls', () => {
    expect(wrapper).toMatch(/buildStreamCatalogInFlight/)
  })

  it('caches the descriptors on a successful build', () => {
    expect(heavy).toMatch(/this\.cachedStreamDescriptors\s*=\s*descriptors/)
  })
})

describe('Reolink battery doorbell — catalog is (re)built when the cam is naturally awake', () => {
  it('onWakeTransition builds the catalog once when it is not yet cached', () => {
    const body = sliceMethodBody(cameraSource, 'private async onWakeTransition(')
    expect(body).toMatch(/buildStreamCatalog\(/)
  })

  it('applyStreamProfilePatch invalidates the cached catalog so a profile change rebuilds it', () => {
    const body = sliceMethodBody(cameraSource, 'private async applyStreamProfilePatch(')
    expect(body).toMatch(/this\.cachedStreamDescriptors\s*=\s*(undefined|null)/)
  })
})
