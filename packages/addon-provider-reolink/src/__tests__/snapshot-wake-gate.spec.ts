import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decideSnapshotCameraAccess } from '../snapshot-wake-gate.js'

/**
 * `snapshot.getSnapshot` WITHOUT `force` must never wake a sleeping battery
 * camera. The cap contract says so in two places (the `force` field doc and
 * `getSnapshotLinks`), and the live hub violated it on 2026-09-15 14:47:25:
 * device 106 ("Baby monitor") logged in while asleep for a picture that was
 * then composed from cache anyway.
 *
 * Two layers of test:
 *   1. the DECISION (`decideSnapshotCameraAccess`) — the four cases;
 *   2. the WIRING — that the driver actually asks it, before `ensureApi`,
 *      with the caller's `force`, and no longer lets a rate limiter answer
 *      the question. Constructing a real `ReolinkCamera` needs the whole
 *      `DeviceContext` mocked, so the wiring is asserted structurally, the
 *      same way `battery-read-path-discipline.spec.ts` does.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

/**
 * Slice one class member's text: from its signature to the next member.
 * Brace matching is wrong here — `Promise<{ base64: string }>` closes the
 * first brace on the signature line and would yield an empty body that
 * trivially "passes" every `not.toMatch` in this file.
 */
function sliceMember(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start === -1) throw new Error(`member not found: ${signature}`)
  const rest = source.slice(start + signature.length)
  const next =
    /\n {2}(?:\/\*\*|\/\/|private |public |protected |override |readonly |static |get |async )/.exec(
      rest,
    )
  return next ? rest.slice(0, next.index) : rest
}

describe('decideSnapshotCameraAccess', () => {
  it('(a) sleeping battery cam + no force → refuse, so no login can happen', () => {
    expect(decideSnapshotCameraAccess({ isBattery: true, sleeping: true, force: false })).toEqual({
      kind: 'refuse',
      reason: 'sleeping',
    })
  })

  it('(b) refuses identically whatever the cache holds — the gate has no cache input', () => {
    // An empty cache is NOT a licence to wake: the caller (broker sentry,
    // thumbnail) has its own fallback card, and a cold cache after a hub
    // restart would otherwise wake every battery camera on the install at
    // once. The refusal carries the reason so the wrapper can paint
    // `sleeping: true` instead of a fault.
    const decision = decideSnapshotCameraAccess({
      isBattery: true,
      sleeping: true,
      force: false,
    })
    expect(decision.kind).toBe('refuse')
  })

  it('(c) THE CONTROL — force still wakes, and stamps the shared cooldown', () => {
    expect(decideSnapshotCameraAccess({ isBattery: true, sleeping: true, force: true })).toEqual({
      kind: 'proceed',
      stampCooldown: true,
    })
  })

  it('(d) an awake battery cam is unchanged, and stamps nothing', () => {
    expect(decideSnapshotCameraAccess({ isBattery: true, sleeping: false, force: false })).toEqual({
      kind: 'proceed',
      stampCooldown: false,
    })
  })

  it('(d) a mains camera is never gated, forced or not', () => {
    expect(decideSnapshotCameraAccess({ isBattery: false, sleeping: true, force: false })).toEqual({
      kind: 'proceed',
      stampCooldown: false,
    })
    expect(decideSnapshotCameraAccess({ isBattery: false, sleeping: false, force: true })).toEqual({
      kind: 'proceed',
      stampCooldown: false,
    })
  })

  it('a forced read is never rate-limited — the decision takes no clock at all', () => {
    // Operator demand bypasses the proactive cooldown (parity with
    // `wakeForStream` / `wakeIfSleeping`). If a timestamp ever reappears in
    // this signature, a refresh button will start returning null.
    const source = readFileSync(resolve(here, '../snapshot-wake-gate.ts'), 'utf8')
    const iface = /export interface SnapshotAccessInput \{[\s\S]*?\n\}/.exec(source)?.[0]
    expect(iface).toBeDefined()
    expect(iface).not.toMatch(/nowMs|lastProactiveWakeAt|cooldownMs/)
  })
})

describe('the driver wires the gate in front of the login', () => {
  it('the cap mount forwards the caller`s force to the fetch', () => {
    const body = sliceMember(cameraSource, 'const snapshotProvider: InferNativeProvider')
    // Dropping `force` on the floor is how a non-forced read became
    // indistinguishable from an operator refresh.
    expect(body).toMatch(/getSnapshot:\s*async\s*\(\s*\{\s*deviceId,\s*force\s*\}\s*\)/)
    expect(body).toMatch(/this\.fetchSnapshotWithSingleFlight\(force === true\)/)
  })

  it('the gate is consulted BEFORE ensureApi and before any wakeUp', () => {
    const body = sliceMember(cameraSource, 'private async fetchSnapshotWithSingleFlight(')
    const gateIdx = body.indexOf('decideSnapshotCameraAccess(')
    const ensureIdx = body.indexOf('this.ensureApi()')
    const wakeIdx = body.indexOf('api.wakeUp(')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(ensureIdx).toBeGreaterThan(-1)
    expect(wakeIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(ensureIdx)
    expect(gateIdx).toBeLessThan(wakeIdx)
  })

  it('the snapshot path no longer lets the wake COOLDOWN answer the question', () => {
    // `allowProactiveCameraAccess` is a rate limiter: it answers "how often",
    // never "may we at all". It let the 2026-09-15 login through.
    const body = sliceMember(cameraSource, 'private async fetchSnapshotWithSingleFlight(')
    expect(body).not.toMatch(/allowProactiveCameraAccess/)
    expect(body).not.toMatch(/canProactivelyWake/)
  })

  it('a refusal is LOGGED — a branch that drops work never does it silently', () => {
    const body = sliceMember(cameraSource, 'private async fetchSnapshotWithSingleFlight(')
    const refuseIdx = body.indexOf("kind === 'refuse'")
    expect(refuseIdx).toBeGreaterThan(-1)
    const after = body.slice(refuseIdx, refuseIdx + 600)
    expect(after).toMatch(/this\.ctx\.logger\.(info|debug)\(/)
    expect(after).toMatch(/tags: \{ deviceId: this\.id \}/)
  })
})
