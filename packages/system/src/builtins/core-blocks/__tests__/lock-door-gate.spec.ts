import type { DeviceCall, DeviceCallRedirect } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { composeRedirects, LockDoorGate } from '../lock-door-gate.js'
import { recordingLogger } from './fixtures.js'

const LOCK = 7
const lockCall: DeviceCall = { capName: 'lock-control', method: 'lock', deviceId: LOCK, args: {} }

function world(sensor: string | null = 'Front door contact') {
  const log = recordingLogger()
  const gate = new LockDoorGate({ sensorOf: async () => sensor, logger: log.logger })
  const feed = (state: string, deviceId = LOCK, capName = 'lock-control') =>
    gate.onStateChanged({ deviceId, capName, slice: { state } })
  return { gate, feed, redirect: gate.redirect(), log }
}

describe('LockDoorGate (D984)', () => {
  it('covers lock() and nothing else', () => {
    const { redirect } = world()
    expect(redirect.covers('lock-control', 'lock')).toBe(true)
    expect(redirect.covers('lock-control', 'unlock')).toBe(false)
    expect(redirect.covers('media-player', 'play')).toBe(false)
  })

  it('refuses lock() while the door is open, naming the sensor', async () => {
    const { feed, redirect } = world()
    feed('door-open')
    await expect(redirect.attempt(lockCall)).rejects.toThrow(/Front door contact/)
  })

  it('logs the refusal with the device tag', async () => {
    const { feed, redirect, log } = world()
    feed('door-open')
    await redirect.attempt(lockCall).catch(() => undefined)
    expect(JSON.stringify(log.lines)).toContain(`"deviceId":${LOCK}`)
  })

  it('lets lock() through once the door closed', async () => {
    const { feed, redirect } = world()
    feed('door-open')
    feed('unlocked')
    expect(await redirect.attempt(lockCall)).toEqual({ kind: 'not-redirected' })
  })

  it('never blocks on an unknown door, and logs it once', async () => {
    const { redirect, log } = world()
    expect(await redirect.attempt(lockCall)).toEqual({ kind: 'not-redirected' })
    await redirect.attempt(lockCall)
    expect(log.lines.filter((l) => JSON.stringify(l).includes('unknown'))).toHaveLength(1)
  })

  it('stays silent about a lock with no linked sensor', async () => {
    const { redirect, log } = world(null)
    expect(await redirect.attempt(lockCall)).toEqual({ kind: 'not-redirected' })
    expect(log.lines).toHaveLength(0)
  })

  it('ignores another device and another cap', async () => {
    const { feed, redirect } = world()
    feed('door-open', LOCK + 1)
    feed('door-open', LOCK, 'battery')
    expect(await redirect.attempt(lockCall)).toEqual({ kind: 'not-redirected' })
  })
})

describe('composeRedirects', () => {
  const media: DeviceCallRedirect = {
    covers: (cap) => cap === 'media-player',
    attempt: async () => ({ kind: 'redirected', result: 'media' }),
  }
  it('routes each call to the authority that covers it', async () => {
    const { feed, gate } = world()
    const both = composeRedirects([media, gate.redirect()])
    expect(both.covers('media-player', 'play')).toBe(true)
    expect(both.covers('lock-control', 'lock')).toBe(true)
    expect(both.covers('lock-control', 'unlock')).toBe(false)
    expect(
      await both.attempt({ capName: 'media-player', method: 'play', deviceId: 1, args: {} }),
    ).toEqual({ kind: 'redirected', result: 'media' })
    feed('door-open')
    await expect(both.attempt(lockCall)).rejects.toThrow(/door is open/)
  })
})
