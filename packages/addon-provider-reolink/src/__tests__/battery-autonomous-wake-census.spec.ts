import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE contract, as a test (D173):
 *
 *   "A camera that declares a battery must have NO mechanism that activates it
 *    on its own. The only one is the snapshot, and on a very wide interval.
 *    The brokers must always be AVAILABLE: not active, available on demand."
 *
 * Every path in this provider that reaches `ensureApi()` is a potential wake —
 * on a UDP battery camera the Baichuan login IS the wake, whatever command
 * follows it. So the invariant is not "do not poll", it is: **no self-initiated
 * path may reach `ensureApi()` while the camera is known to be sleeping.**
 *
 * Two vectors were open when this file was written, and both were invisible
 * precisely because they are lifecycle rather than timers:
 *
 *  - `onProbe()` called `ensureApi()` unconditionally. It is not a one-shot:
 *    the kernel retries it on the boot-recovery backoff (15s, 60s, 5m, 15m,
 *    30m, 60m, 90m) until the `feature-probe` slice is seeded, so a camera
 *    asleep at boot paid up to seven logins in three hours — ~25 wakes a day
 *    across restarts, none of them asked for by anybody.
 *  - `registerBatteryIfSupported()` seeded the cache with
 *    `refreshBatteryFromApi()` **from the constructor**, so every addon restart
 *    woke every sleeping battery camera to read a value the RESTORED slice
 *    already held.
 *
 * Source-structure assertions, like the sibling battery specs: constructing a
 * real `ReolinkCamera` requires the whole `DeviceContext`, and these
 * invariants are structural — they survive the refactors that would otherwise
 * quietly reopen a vector.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')
const hubSource = readFileSync(resolve(here, '../reolink-hub-session.ts'), 'utf8')

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

/** The sleep gate, in the two spellings the file uses. */
function hasSleepGate(body: string): boolean {
  return /this\.isBattery\s*&&\s*this\.sleeping/.test(body)
}

describe('no self-initiated path wakes a sleeping battery camera', () => {
  it('onProbe refuses BEFORE ensureApi — the kernel retry chain is the expensive part', () => {
    const body = sliceMethodBody(cameraSource, 'override async onProbe()')
    expect(hasSleepGate(body)).toBe(true)
    const gateIdx = body.search(/this\.isBattery\s*&&\s*this\.sleeping/)
    const ensureIdx = body.indexOf('this.ensureApi()')
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(ensureIdx).toBeGreaterThanOrEqual(0)
    // The gate must come FIRST. A gate after the login is not a gate.
    expect(gateIdx).toBeLessThan(ensureIdx)
  })

  it('the constructor-time battery seed is refused while sleeping', () => {
    const body = sliceMethodBody(
      cameraSource,
      "private async refreshBatteryFromApi(\n    reason: 'register' | 'periodic' | 'wake' | 'demand',\n  )",
    )
    expect(hasSleepGate(body)).toBe(true)
    const gateIdx = body.search(/this\.isBattery\s*&&\s*this\.sleeping/)
    const ensureIdx = body.indexOf('this.ensureApi()')
    expect(gateIdx).toBeLessThan(ensureIdx)
    // …and only for the self-initiated reasons. A post-login refresh costs
    // nothing (the socket is already up) and must NOT be skipped, or the
    // badge stays on the cold fallback forever.
    expect(body).toContain("reason === 'register'")
    expect(body).toContain("reason === 'periodic'")
  })

  it('every refreshBatteryFromApi call site declares WHY it is allowed to run', () => {
    // An un-argumented call is a call nobody classified — exactly how the
    // constructor seed stayed un-gated. Ban the shape.
    expect(cameraSource).not.toMatch(/refreshBatteryFromApi\(\s*\)/)
  })

  it('the scheduled refresh (D847) is the ONE sanctioned self-initiated wake, and it is bounded', () => {
    // A standalone battery camera pushes only when it wakes, so a quiet night
    // used to freeze every fact it owns (device 106 showed 80 % until it died).
    // D847 sanctions ONE wake per window, only at the window's deadline and
    // only when no awake moment spared it — the decision is the tested pure
    // module, the wake goes through the existing `wakeIfSleeping`, and there is
    // no second wake path (D355's contact-expiry wake is gone).
    const wiring = sliceMethodBody(cameraSource, 'private getBatteryRefresh()')
    const cooldownIdx = wiring.indexOf("this.canProactivelyWake('scheduled-refresh')")
    const wakeIdx = wiring.indexOf('this.wakeIfSleeping()')
    expect(cooldownIdx).toBeGreaterThanOrEqual(0)
    // The cooldown gate sits before the login, which IS the wake.
    expect(cooldownIdx).toBeLessThan(wakeIdx)
    expect(wiring).toContain('this.markWakeIssued()')
    expect(cameraSource).not.toContain('wakeForContactRefresh')
    expect(cameraSource).not.toContain('shouldWakeForContact')
    const periodic = sliceMethodBody(cameraSource, 'private async runBatteryUpdate()')
    expect(periodic).toContain('this.getBatteryRefresh().tick()')
    // The controller is the only caller of the wake: nothing else in the file
    // wires a scheduled wake.
    expect(cameraSource.split("canProactivelyWake('scheduled-refresh')").length - 1).toBe(1)
  })

  it('the periodic tick never connects on its own — the decision gates before any I/O', () => {
    const body = sliceMethodBody(cameraSource, 'private async runBatteryUpdate()')
    expect(body).not.toContain('ensureApi')
    expect(body).toContain('if (!this.isBattery) return')
  })

  it('the catalog build still refuses to wake for a poll', () => {
    const body = sliceMethodBody(cameraSource, 'private async buildStreamCatalogUncached()')
    const gateIdx = body.search(/this\.isBattery\s*&&\s*this\.sleeping/)
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeLessThan(body.indexOf('this.ensureApi()'))
  })

  it('the settings snapshot still refuses to wake ON ITS OWN', () => {
    const body = sliceMethodBody(cameraSource, 'private async refreshParentSettingsSnapshot(')
    expect(hasSleepGate(body)).toBe(true)
    // The gate now exempts `post-write`, and that does not weaken this census:
    // a re-read that follows an operator's save is not SELF-initiated, and the
    // write it follows already used the socket. What this file guards is the
    // camera waking because CamStack felt like asking — see
    // `battery-write-wakes-and-verifies.spec.ts` for why the exemption exists.
    expect(body).toContain('post-write')
  })

  it('the ping watchdog is never armed for a battery camera', () => {
    const body = sliceMethodBody(cameraSource, 'private startWatchdogs()')
    expect(body).toContain('if (!this.isBattery)')
  })

  it('the aux-align poll is never armed for a battery camera', () => {
    const body = sliceMethodBody(cameraSource, 'private startAlignAuxPolling()')
    expect(body).toContain('if (this.isBattery) return')
  })

  it('the scheduled-refresh window is bounded: default an hour, never wider than the presence budget', () => {
    const src = readFileSync(resolve(here, '../battery-hourly-refresh.ts'), 'utf8')
    expect(src).toContain('BATTERY_REFRESH_MINUTES_DEFAULT = 60')
    expect(src).toContain('BATTERY_REFRESH_MINUTES_MAX = 240')
    expect(src).toContain('MAX_ATTEMPTS_PER_WINDOW = 2')
  })
})

describe('the stream catalog survives a restart (brokers AVAILABLE, never active)', () => {
  it('a cold RAM cache falls back to the durable slice before touching the camera', () => {
    const body = sliceMethodBody(cameraSource, 'private async buildStreamCatalog()')
    const restoreIdx = body.indexOf('this.restoreStreamCatalogFromLedger()')
    const uncachedIdx = body.indexOf('this.buildStreamCatalogUncached()')
    expect(restoreIdx).toBeGreaterThanOrEqual(0)
    expect(uncachedIdx).toBeGreaterThanOrEqual(0)
    // Restore FIRST. A restore after the build is a restore that never runs
    // for the only device that needs it.
    expect(restoreIdx).toBeLessThan(uncachedIdx)
  })

  it('only a SUCCESSFUL build writes the ledger — a refusal must not demote a good copy', () => {
    const body = sliceMethodBody(cameraSource, 'private persistStreamCatalogToLedger(')
    expect(body).toContain('if (descriptors.length === 0) return')
  })

  it('the wake path re-reads the catalog and updates the ledger', () => {
    const body = sliceMethodBody(
      cameraSource,
      // Matched on the name alone: the reason union gained 'confirmed-wake'
      // (a wake this process drove and watched), and pinning the full
      // signature here made an unrelated spec fail for a reason that has
      // nothing to do with what it guards.
      'private async onWakeTransition(',
    )
    expect(body).toContain('this.shouldRebuildCatalogOnWake()')
    const rebuildIdx = body.indexOf('this.shouldRebuildCatalogOnWake()')
    const buildIdx = body.indexOf('this.buildStreamCatalog()')
    expect(rebuildIdx).toBeLessThan(buildIdx)
  })
})

describe('passive contact is the only evidence of reachability we take', () => {
  it('markPassiveContact refuses non-battery devices and quantises its write', () => {
    const body = sliceMethodBody(cameraSource, 'private markPassiveContact()')
    expect(body).toContain('if (!this.isBattery) return')
    expect(body).toContain('CONTACT_WRITE_QUANTUM_MS')
  })

  it('an inbound simpleEvent stamps contact — the one proof that costs nothing', () => {
    const body = sliceMethodBody(
      cameraSource,
      "  handleSimpleEvent(\n    event: import('@apocaliss92/nodelink-js').ReolinkSimpleEvent,",
    )
    expect(body).toContain('this.markPassiveContact()')
  })

  it('nothing polls in order to produce contact — no reachability poll here', () => {
    // The generic `startReachabilityPoll` would be a 30s login on a battery
    // camera. This provider must never wire it.
    expect(cameraSource).not.toContain('startReachabilityPoll')
  })
})

describe('the hub routes by the children that attached themselves (no registry scan to clear)', () => {
  it('the session keeps no channel map of its own to clear on a quiet registry', () => {
    expect(hubSource).not.toContain('channelToDeviceId')
    expect(hubSource).not.toContain('loadAdoptedChildrenByChannel')
  })

  it('routing reads the live children at push time', () => {
    const body = sliceMethodBody(hubSource, 'routeSimpleEvent(event: ReolinkSimpleEvent)')
    expect(body).toContain('this.#deps.children().find(')
  })
})
