import { describe, expect, it } from 'vitest'
import {
  buildOnboardEntry,
  diffOnboardRuntimes,
  isOnboardRequested,
  type OnboardBrokerEntry,
  onboardToEmbeddedEntry,
  readOnboardPort,
} from '../onboard-helpers.js'

describe('onboardToEmbeddedEntry', () => {
  it('maps id/name from the entry and port/allowAnonymous from onboard', () => {
    const entry: OnboardBrokerEntry = {
      id: 'abc',
      name: 'Local broker',
      onboard: { port: 1885, allowAnonymous: true },
    }
    expect(onboardToEmbeddedEntry(entry)).toEqual({
      id: 'abc',
      name: 'Local broker',
      port: 1885,
      allowAnonymous: true,
    })
  })

  it('carries username + password through when present', () => {
    const entry: OnboardBrokerEntry = {
      id: 'x',
      name: 'Auth broker',
      username: 'user',
      password: 'stored-password',
      onboard: { port: 2000, allowAnonymous: false },
    }
    expect(onboardToEmbeddedEntry(entry)).toEqual({
      id: 'x',
      name: 'Auth broker',
      port: 2000,
      allowAnonymous: false,
      username: 'user',
      password: 'stored-password',
    })
  })

  it('omits username/password keys when absent (no undefined fields)', () => {
    const entry: OnboardBrokerEntry = {
      id: 'y',
      name: 'Anon broker',
      onboard: { port: 1883, allowAnonymous: true },
    }
    const result = onboardToEmbeddedEntry(entry)
    expect('username' in result).toBe(false)
    expect('password' in result).toBe(false)
  })

  it('does not mutate the input entry', () => {
    const entry: OnboardBrokerEntry = {
      id: 'z',
      name: 'Broker',
      onboard: { port: 1883, allowAnonymous: false },
    }
    const snapshot = JSON.parse(JSON.stringify(entry))
    onboardToEmbeddedEntry(entry)
    expect(entry).toEqual(snapshot)
  })
})

describe('diffOnboardRuntimes', () => {
  it('starts entries with no running runtime', () => {
    const plan = diffOnboardRuntimes(
      [
        { id: 'a', port: 1883 },
        { id: 'b', port: 1884 },
      ],
      [],
      new Map(),
    )
    expect(plan.toStart).toEqual(['a', 'b'])
    expect(plan.toStop).toEqual([])
    expect(plan.toRespawn).toEqual([])
  })

  it('stops runtimes whose entry disappeared', () => {
    const plan = diffOnboardRuntimes(
      [{ id: 'a', port: 1883 }],
      ['a', 'gone'],
      new Map([
        ['a', 1883],
        ['gone', 1999],
      ]),
    )
    expect(plan.toStart).toEqual([])
    expect(plan.toStop).toEqual(['gone'])
    expect(plan.toRespawn).toEqual([])
  })

  it('respawns runtimes whose port changed', () => {
    const plan = diffOnboardRuntimes([{ id: 'a', port: 2000 }], ['a'], new Map([['a', 1883]]))
    expect(plan.toStart).toEqual([])
    expect(plan.toStop).toEqual([])
    expect(plan.toRespawn).toEqual(['a'])
  })

  it('leaves a matching running entry untouched', () => {
    const plan = diffOnboardRuntimes([{ id: 'a', port: 1883 }], ['a'], new Map([['a', 1883]]))
    expect(plan).toEqual({ toStart: [], toStop: [], toRespawn: [] })
  })

  it('handles a mix of start / stop / respawn at once', () => {
    const plan = diffOnboardRuntimes(
      [
        { id: 'keep', port: 1883 },
        { id: 'moved', port: 9000 },
        { id: 'new', port: 1884 },
      ],
      ['keep', 'moved', 'orphan'],
      new Map([
        ['keep', 1883],
        ['moved', 1885],
        ['orphan', 1999],
      ]),
    )
    expect(plan.toStart).toEqual(['new'])
    expect(plan.toRespawn).toEqual(['moved'])
    expect(plan.toStop).toEqual(['orphan'])
  })
})

describe('isOnboardRequested / readOnboardPort', () => {
  it('isOnboardRequested only for boolean true', () => {
    expect(isOnboardRequested({ onboard: true })).toBe(true)
    expect(isOnboardRequested({ onboard: 'true' })).toBe(false)
    expect(isOnboardRequested({ onboard: 1 })).toBe(false)
    expect(isOnboardRequested({})).toBe(false)
  })

  it('readOnboardPort accepts valid integer ports', () => {
    expect(readOnboardPort({ port: 1883 })).toBe(1883)
    expect(readOnboardPort({ port: 65535 })).toBe(65535)
  })

  it('readOnboardPort rejects out-of-range / non-integer / missing', () => {
    expect(readOnboardPort({ port: 0 })).toBeNull()
    expect(readOnboardPort({ port: 70000 })).toBeNull()
    expect(readOnboardPort({ port: 18.5 })).toBeNull()
    expect(readOnboardPort({ port: '1883' })).toBeNull()
    expect(readOnboardPort({})).toBeNull()
  })
})

describe('buildOnboardEntry', () => {
  it('builds url from port and defaults allowAnonymous to false', () => {
    const entry = buildOnboardEntry({
      id: 'id1',
      name: 'My broker',
      port: 1890,
      settings: {},
    })
    expect(entry).toEqual({
      id: 'id1',
      name: 'My broker',
      url: 'mqtt://127.0.0.1:1890',
      onboard: { port: 1890, allowAnonymous: false },
    })
  })

  it('carries the password as supplied (the keychain stores it) and the username', () => {
    const entry = buildOnboardEntry({
      id: 'id2',
      name: 'Auth broker',
      port: 1883,
      settings: { username: 'bob', password: 'secret', allowAnonymous: true },
    })
    expect(entry).toEqual({
      id: 'id2',
      name: 'Auth broker',
      url: 'mqtt://127.0.0.1:1883',
      username: 'bob',
      password: 'secret',
      onboard: { port: 1883, allowAnonymous: true },
    })
  })

  it('omits username/password keys when not strings', () => {
    const entry = buildOnboardEntry({
      id: 'id3',
      name: 'Broker',
      port: 1883,
      settings: { username: 42, password: null },
    })
    expect('username' in entry).toBe(false)
    expect('password' in entry).toBe(false)
  })
})
