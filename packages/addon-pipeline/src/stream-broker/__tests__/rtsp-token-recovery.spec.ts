/**
 * Restream tokens held in a keychain that cannot be read (D870), driven through
 * the REAL `check()` loop over several timer ticks (no manual shortcuts):
 *
 *  - while held: no restream URL (the gate), no token write, an alert + ERROR log
 *    tagged with the deviceId; other cameras unaffected;
 *  - when the keychain resolves: only that camera is registered, with its STORED
 *    tokens, and the alert clears - no teardown;
 *  - a secret that is MISSING needs TWO consistent reads, then the camera is
 *    released, registered with fresh tokens that are persisted at once, the alert
 *    says new URLs were issued, and the re-check stops for it.
 */
import type { IScopedLogger, KeychainResolveResult } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeRtspTokens, RTSP_TOKENS_KEY, rtspTokensMirror } from '../broker-device-state.js'
import { HELD_TOKEN_RECHECK_MS, TokenRecovery, type TokenAlerts } from '../rtsp-token-recovery.js'
import { makeFakeBrokerDeviceSettings } from './fake-broker-device-settings.js'

const REF = (id: number): string => `secret://stream-broker/device/${id}/rtspTokens`
const marker = (id: number) => ({ $secret: REF(id), v: 1 })

type Entry = KeychainResolveResult[string]

function world() {
  const settings = makeFakeBrokerDeviceSettings()
  const error = vi.fn()
  const info = vi.fn()
  const noop = (): void => {}
  const l = { debug: noop, info, warn: noop, error, child: () => l }
  // Documented type boundary: the recovery only logs.
  const log = l as unknown as IScopedLogger
  const mirror = rtspTokensMirror(settings, log)
  const keychain: Record<string, Entry> = {}
  const alerts: TokenAlerts & {
    raised: { deviceId: number; kind: string; message: string }[]
    cleared: number[]
  } = {
    raised: [],
    cleared: [],
    raise: async (a) => void alerts.raised.push(a),
    clear: async (id) => void alerts.cleared.push(id),
  }
  const registered: { cameras: readonly number[]; tokens: ReadonlyMap<number, unknown> }[] = []
  const recovery = new TokenRecovery({
    mirror,
    secrets: {
      resolve: async (refs) =>
        Object.fromEntries(refs.map((r) => [r, keychain[r] ?? { kind: 'missing' as const }])),
    },
    alerts,
    logger: log,
    onRegister: async (tokens, cameras) => void registered.push({ cameras, tokens }),
  })
  return { settings, mirror, keychain, alerts, registered, recovery, error }
}

describe('restream tokens held but not readable', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('LOCKED: the camera is blocked (no URL, no write), alerted with the exact text, others flow', async () => {
    const w = world()
    w.keychain[REF(9)] = { kind: 'unavailable', reason: 'wrong-key' }
    w.settings.rows.set(7, { [RTSP_TOKENS_KEY]: JSON.stringify({ a: 't' }) })
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: marker(9) })
    const tokens = await w.mirror.load()
    expect([...tokens.keys()]).toEqual([7])
    expect(w.mirror.isBlocked(9)).toBe(true)
    expect(w.mirror.isBlocked(7)).toBe(false)

    w.recovery.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(w.alerts.raised).toHaveLength(1)
    expect(w.alerts.raised[0]).toMatchObject({ deviceId: 9, kind: 'unavailable' })
    expect(w.alerts.raised[0]?.message).toMatch(/RTSP restream URLs are unavailable/)
    expect(w.alerts.raised[0]?.message).toMatch(/Home Assistant or an NVR get errors/)
    expect(w.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 9 } }),
    )
    // The broker minting a token for the held camera cannot be persisted…
    await w.mirror.merge(mergeRtspTokens(w.mirror, new Map([['9/x', 'minted']])))
    expect(w.settings.writes).toEqual([])
    // …over several ticks: one alert, still blocked, nothing registered.
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS * 3)
    expect(w.alerts.raised).toHaveLength(1)
    expect(w.registered).toEqual([])
    expect(w.mirror.isBlocked(9)).toBe(true)
    w.recovery.stop()
  })

  it('UNLOCK: a later tick registers ONLY that camera with its STORED tokens and clears the alert', async () => {
    const w = world()
    w.keychain[REF(9)] = { kind: 'unavailable', reason: 'wrong-key' }
    w.settings.rows.set(7, { [RTSP_TOKENS_KEY]: JSON.stringify({ a: 't' }) })
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: marker(9) })
    await w.mirror.load()
    w.recovery.start()
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS)
    expect(w.registered).toEqual([])

    // the keychain unlocks: the settings view now resolves the marker to its value
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: JSON.stringify({ 'native:main': 'tok-old' }) })
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS)

    expect(w.alerts.cleared).toEqual([9])
    expect(w.registered).toHaveLength(1)
    expect(w.registered[0]?.cameras).toEqual([9])
    const registeredTokens = w.registered[0]?.tokens
    expect(registeredTokens?.get(9)).toEqual({ 'native:main': 'tok-old' })
    expect(w.mirror.isBlocked(9)).toBe(false)
    // and the loop stops by itself: no more ticks do anything
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS * 5)
    expect(w.registered).toHaveLength(1)
    expect(w.settings.writes).toEqual([])
  })

  it('RACE: the keychain unlocks between hydration and the FIRST tick - the stored tokens are still registered', async () => {
    const w = world()
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: marker(9) })
    await w.mirror.load() // hydration: held
    expect(w.mirror.isBlocked(9)).toBe(true)
    // unlock before any tick ran (no alert was ever raised)
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: JSON.stringify({ 'native:main': 'tok-old' }) })

    w.recovery.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(w.registered).toHaveLength(1)
    expect(w.registered[0]?.cameras).toEqual([9])
    expect(w.registered[0]?.tokens.get(9)).toEqual({ 'native:main': 'tok-old' })
    expect(w.alerts.raised).toEqual([])
    expect(w.settings.writes).toEqual([])
    w.recovery.stop()
  })

  it('MISSING needs TWO consistent reads, then: released, fresh tokens PERSISTED, new-URL alert, re-check stops', async () => {
    const w = world()
    w.keychain[REF(9)] = { kind: 'missing' }
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: marker(9) })
    await w.mirror.load()

    w.recovery.start()
    await vi.advanceTimersByTimeAsync(0)
    // first read: still blocked, nothing alerted, nothing released (D49)
    expect(w.mirror.isBlocked(9)).toBe(true)
    expect(w.alerts.raised).toEqual([])
    expect(w.registered).toEqual([])

    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS)
    // second consistent read: released and registered (the broker mints + persists)
    expect(w.mirror.isBlocked(9)).toBe(false)
    expect(w.registered).toHaveLength(1)
    expect(w.registered[0]?.cameras).toEqual([9])
    expect(w.alerts.raised).toEqual([
      expect.objectContaining({
        deviceId: 9,
        kind: 'missing',
        message: expect.stringMatching(/New RTSP restream URLs were issued for camera 9/),
      }),
    ])
    // the broker's persister now writes the freshly minted tokens at once
    await w.mirror.merge(mergeRtspTokens(w.mirror, new Map([['9/native:main', 'fresh']])))
    expect(w.settings.writes).toEqual([9])

    // later ticks do NOT re-block the released camera through load()
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS * 5)
    expect(w.mirror.isBlocked(9)).toBe(false)
    expect(w.registered).toHaveLength(1)
    expect(w.alerts.raised).toHaveLength(1)
  })

  it('DISARM: a missing read that flips back to unavailable resets the count - no release on one lone read', async () => {
    const w = world()
    w.keychain[REF(9)] = { kind: 'missing' }
    w.settings.rows.set(9, { [RTSP_TOKENS_KEY]: marker(9) })
    await w.mirror.load()
    w.recovery.start()
    await vi.advanceTimersByTimeAsync(0)
    w.keychain[REF(9)] = { kind: 'unavailable', reason: 'wrong-key' }
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS)
    w.keychain[REF(9)] = { kind: 'missing' }
    await vi.advanceTimersByTimeAsync(HELD_TOKEN_RECHECK_MS)
    // reads were missing, unavailable, missing: never two in a row
    expect(w.mirror.isBlocked(9)).toBe(true)
    expect(w.registered).toEqual([])
    w.recovery.stop()
  })
})
