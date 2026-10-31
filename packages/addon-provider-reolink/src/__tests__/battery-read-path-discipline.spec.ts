import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  decideSleepCommit,
  SLEEP_HYSTERESIS_MS,
  WAKE_HYSTERESIS_MS,
} from '../sleep-state-decision.js'

/**
 * Battery read-path discipline — the device-detail page must never wake
 * a sleeping battery camera.
 *
 * Root cause this guards against:
 *   `deviceManager.getDeviceAggregate` calls `getOptions` + `getStatus`
 *   on EVERY bound device-config cap (`stream-params`, `motion-zones`,
 *   `privacy-mask`, `day-night`, `image-settings`, `ptz`), and the admin
 *   UI re-polls that aggregate every 2.5s while the Config tab is open
 *   (`DeviceAggregateSection.tsx`). Every one of those `getOptions`
 *   implementations used to issue an un-cached Baichuan round-trip, and
 *   every `getStatus` bridge refreshed from the camera once its 10s
 *   staleness window expired — with no sleep gate anywhere. Net effect:
 *   ~7 commands every 2.5s, which woke a sleeping doorbell on a plain
 *   page visit and then kept it awake for as long as the tab was open.
 *
 * The fix has two halves, asserted below:
 *   - `getOptions` resolves through `resolveCapOptions` (persisted
 *     descriptor + TTL + "never probe while sleeping").
 *   - every status bridge takes `sleepGatedRefresh(...)`, so a READ
 *     never reaches for the radio; write paths keep the raw refresh.
 *
 * Source-structure assertions (same approach as the sibling battery
 * specs): constructing a full `ReolinkCamera` requires mocking the
 * entire `DeviceContext`, while the invariant here is structural and
 * survives surrounding refactors.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')
const hubSource = readFileSync(resolve(here, '../reolink-hub-session.ts'), 'utf8')

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

/**
 * Brace matching can't find the body of a member whose signature already
 * contains a `{` — an inline params object (`resolveCapOptions<T>(params: {`)
 * or an inline return type (`Promise<{ base64: string }>`). For those,
 * slice from the signature to the next class-member boundary instead.
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

/** Every device-config cap the aggregate walks on a Reolink camera, with
 *  the register method that owns its provider. */
const DEVICE_CONFIG_CAPS = [
  { cap: 'stream-params', register: 'private registerStreamParamsCap()' },
  { cap: 'motion-zones', register: 'private registerMotionZonesCap()' },
  { cap: 'privacy-mask', register: 'private registerPrivacyMaskCap()' },
  { cap: 'day-night', register: 'private registerDayNightCap()' },
  { cap: 'image-settings', register: 'private registerImageSettingsCap()' },
] as const

describe('device-config cap reads never wake a sleeping battery cam', () => {
  describe.each(DEVICE_CONFIG_CAPS)('$cap', ({ register }) => {
    const body = sliceMethodBody(cameraSource, register)

    it('routes getOptions through resolveCapOptions (persisted + sleep-gated)', () => {
      expect(body).toMatch(/this\.resolveCapOptions\(/)
    })

    it('feeds the status bridge a sleep-gated refresh', () => {
      expect(body).toMatch(/refresh:\s*this\.sleepGatedRefresh\(/)
    })

    it('does NOT hand the bridge the raw camera refresh', () => {
      expect(body).not.toMatch(/refresh:\s*refreshFromCamera\s*,/)
    })
  })

  it('registers a wake warm-up for every device-config cap', () => {
    // Gating reads is only half the contract: with nothing refreshing the
    // caches, a sleeping camera shows null for everything in the State
    // panel (which reads the runtime-state slices) and an empty snapshot
    // tile. The refresh has to happen while the camera is ALREADY up.
    for (const { register } of DEVICE_CONFIG_CAPS) {
      const body = sliceMethodBody(cameraSource, register)
      expect(body).toMatch(/this\.registerCapWarmer\(/)
    }
  })

  it('the wake transition warms cap slices AND the snapshot cache', () => {
    const body = sliceMember(cameraSource, 'private async onWakeTransition(')
    const warmCapsIdx = body.indexOf('this.warmCapSlicesOnWake()')
    const warmSnapIdx = body.indexOf('this.warmSnapshotOnWake()')
    const settingsIdx = body.indexOf('this.refreshParentSettingsSnapshot()')
    expect(warmCapsIdx).toBeGreaterThan(-1)
    expect(warmSnapIdx).toBeGreaterThan(-1)
    // Ahead of the long settings multi-probe: the awake window is ~14s and
    // these back what the operator actually looks at while asleep.
    expect(warmCapsIdx).toBeLessThan(settingsIdx)
    expect(warmSnapIdx).toBeLessThan(settingsIdx)
  })

  it('the wake warm-up is serialized and skips still-fresh slices', () => {
    const body = sliceMethodBody(cameraSource, 'private async warmCapSlicesOnWake(')
    expect(body).toMatch(/await warm\(\)/)
    expect(body).not.toMatch(/Promise\.all/)
    expect(body).toMatch(/WAKE_WARM_MAX_AGE_MS/)
    // The skip is now overridable, and ONLY by an explicit force: the
    // operator's "Refresh from camera" exists to distrust what we believe,
    // and everything else still gets the freshness skip this test guards.
    expect(body).toContain('opts?.force !== true')
  })

  it('ptz getOptions is cached + sleep-gated too', () => {
    const body = sliceMethodBody(cameraSource, 'private registerPtzIfSupported()')
    expect(body).toMatch(/this\.resolveCapOptions\(/)
    expect(body).toContain("capName: 'ptz'")
  })

  it('resolveCapOptions refuses to probe a sleeping battery cam', () => {
    const body = sliceMember(cameraSource, 'private async resolveCapOptions<T>')
    const gateIdx = body.indexOf('this.isBattery && this.sleeping')
    const probeIdx = body.indexOf('const started = probe()')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeGreaterThan(-1)
    // The sleep gate must short-circuit BEFORE the probe.
    expect(gateIdx).toBeLessThan(probeIdx)
  })

  it('resolveCapOptions validates the persisted blob instead of casting it', () => {
    const body = sliceMember(cameraSource, 'private readCapOptionsCache<T>')
    expect(body).toMatch(/schema\.safeParse\(/)
    expect(body).not.toMatch(/\bas\s+T\b/)
  })
})

describe('proactive wake cooldown', () => {
  // The snapshot path's gate is no longer the cooldown at all: a rate limiter
  // answers "how often may we wake this camera", never "may we wake it", and
  // it let a background sentry read log in to a sleeping camera on
  // 2026-09-15. `force` decides now — see `snapshot-wake-gate.spec.ts`, which
  // owns the ordering assertion this test used to make.

  it('the periodic tick reaches the radio only through the scheduled-refresh controller (D847)', () => {
    // History: this cycle once "never woke", and device 106 then showed 80 %
    // until it died. It is now the one sanctioned wake — once per window, at
    // the window's deadline, when no awake moment spared it — and the decision
    // that lets it through is `decideBatteryRefresh` (driven on a fake clock in
    // `battery-hourly-refresh.spec.ts`). What stays true here: the tick itself
    // never logs in, and it does not borrow the proactive-wake cooldown helper.
    const body = sliceMethodBody(cameraSource, 'private async runBatteryUpdate()')
    expect(body).not.toMatch(/this\.allowProactiveCameraAccess\(/)
    expect(body).not.toContain('this.ensureApi()')
    expect(body).toContain('this.getBatteryRefresh().tick()')
  })

  it('the shared cooldown is stamped by every path that actually wakes', () => {
    // The cooldown is a RECORD of wakes, not a gate on them: it exists so
    // opportunistic paths back off behind a wake somebody else paid for.
    // (The helper that used to gate the snapshot path on it is gone — see
    // `snapshot-wake-gate.spec.ts`.)
    expect(cameraSource).not.toMatch(/private allowProactiveCameraAccess\(/)
    const stamp = sliceMethodBody(cameraSource, 'private markWakeIssued()')
    expect(stamp).toMatch(/this\.lastProactiveWakeAt = Date\.now\(\)/)
  })

  it('demand-driven wakes bypass the cooldown (stream + operator action)', () => {
    // `wakeForStream` (a viewer is waiting) and `wakeIfSleeping` (the
    // operator clicked something) must NEVER consult the cooldown —
    // they only stamp it so background paths back off afterwards.
    const wakeIfSleeping = sliceMethodBody(cameraSource, 'private async wakeIfSleeping(')
    expect(wakeIfSleeping).not.toMatch(/canProactivelyWake/)
    expect(wakeIfSleeping).toMatch(/this\.markWakeIssued\(\)/)

    const battery = sliceMethodBody(cameraSource, 'private registerBatteryIfSupported()')
    expect(battery).not.toMatch(/canProactivelyWake/)
    expect(battery).toMatch(/this\.markWakeIssued\(\)/)
  })
})

describe('sleep-state hysteresis is asymmetric', () => {
  it('the "→ sleeping" window is shorter than the camera awake window', () => {
    // The camera's natural awake window is ~14s (see `onWakeTransition`).
    // A symmetric 30s window dropped the `sleeping` transition of every
    // natural cycle, leaving the slice stuck on "awake" while the camera
    // slept — the "at rest we lose the sleeping state" bug.
    expect(SLEEP_HYSTERESIS_MS).toBeLessThan(14_000)
    expect(WAKE_HYSTERESIS_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('the NVR-reported state is authoritative and bypasses the hysteresis', () => {
    // Driven, not matched against the source text. A summary verdict is
    // firmware state, not socket inference, so the anti-flap window does not
    // apply to it — in either direction.
    const nowMs = 1_000_000
    for (const source of ['hub-summary', 'hub-reconcile'] as const) {
      expect(
        decideSleepCommit({
          current: true,
          next: false,
          source,
          lastFirstHandCommitAt: nowMs - 1_000,
          nowMs,
        }),
      ).toMatchObject({ kind: 'commit' })
    }
  })
})

describe('hub → child sleep/battery propagation', () => {
  it('simpleEvent routing never depends on the CGI list or on a registry read', () => {
    const body = sliceMethodBody(hubSource, 'routeSimpleEvent(event: ReolinkSimpleEvent)')
    // A deep-asleep battery channel drops out of the summary: routing must come from the
    // children that attached themselves, so its pushes are never silently discarded (D173).
    expect(body).toContain('this.#deps.children()')
    expect(body).not.toContain('getNvrChannelsSummary')
  })

  it('pushes the NVR-reported sleep state into adopted battery children', () => {
    const body = sliceMethodBody(hubSource, 'async #refresh()')
    expect(body).toMatch(/this\.reconcileChildSleepState\(channels\)/)
    const reconcile = sliceMethodBody(hubSource, 'private reconcileChildSleepState(')
    expect(reconcile).toMatch(/applyHubSleepState\(/)
    // `offline` / `unknown` carry no sleep information — only these two
    // statuses may drive the slice.
    expect(reconcile).toMatch(/entry\.status === 'sleeping'/)
    expect(reconcile).toMatch(/entry\.status !== 'sleeping' && entry\.status !== 'online'/)
  })
})

describe('battery feature flag is sticky', () => {
  it('an ability probe answering false does not clear hasBattery', () => {
    const body = sliceMethodBody(cameraSource, 'private async probeAndPersistFeatures(')
    expect(body).toMatch(
      /hasBattery:\s*hasBattery === true \|\| prevFlags\.hasBattery === true \|\| this\.isBattery/,
    )
  })
})
