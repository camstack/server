import { describe, expect, it } from 'vitest'
import {
  brokerRefreshPatch,
  brokersExposing,
  devicesForBroker,
  enabledBrokerIds,
  type ExportMembership,
  isExposed,
  type KnownBroker,
  pruneBrokers,
  setExposed,
} from '../membership.js'

const M: ExportMembership = { ha_home: ['101', '102'], ha_office: ['101'] }

describe('per-broker membership', () => {
  it('lets two Home Assistant instances see different sets', () => {
    expect(devicesForBroker(M, 'ha_home')).toEqual(['101', '102'])
    expect(devicesForBroker(M, 'ha_office')).toEqual(['101'])
    expect(isExposed(M, 'ha_office', '102')).toBe(false)
  })

  it('answers empty for a broker nobody was exposed to', () => {
    expect(devicesForBroker(M, 'ha_new')).toEqual([])
  })

  it('names every broker a device is exposed to', () => {
    expect(brokersExposing(M, '101')).toEqual(['ha_home', 'ha_office'])
    expect(brokersExposing(M, '102')).toEqual(['ha_home'])
    expect(brokersExposing(M, '999')).toEqual([])
  })

  it('adds without mutating the original', () => {
    const next = setExposed(M, 'ha_office', '102', true)
    expect(devicesForBroker(next, 'ha_office')).toEqual(['101', '102'])
    expect(devicesForBroker(M, 'ha_office')).toEqual(['101'])
  })

  it('is idempotent on a repeated expose', () => {
    expect(setExposed(M, 'ha_home', '101', true)).toEqual(M)
  })

  it('removes only from the broker asked, never the others', () => {
    const next = setExposed(M, 'ha_home', '101', false)
    expect(devicesForBroker(next, 'ha_home')).toEqual(['102'])
    expect(devicesForBroker(next, 'ha_office')).toEqual(['101'])
  })

  it('drops a broker that no longer exists, and keeps the ones that do', () => {
    const next = pruneBrokers(M, ['ha_home'])
    expect(Object.keys(next)).toEqual(['ha_home'])
  })

  it('leaves membership untouched when every broker still exists', () => {
    expect(pruneBrokers(M, ['ha_home', 'ha_office'])).toEqual(M)
  })
})

describe('enabledBrokerIds', () => {
  /**
   * The regression: the addon read `exportTo:<id>` off `this.config`, and
   * `BaseAddon.resolveConfig` had already dropped it — a dynamic key cannot be
   * in `DEFAULT_CONFIG`, and only keys present in the defaults survive. The
   * store therefore had to be the read surface. If this ever reads a typed
   * config object again, the switch goes back to writing a value nobody reads.
   */
  it('reads the switch from the RAW store, not from a typed config object', () => {
    const store = { 'exportTo:ha_001': true, membership: {}, knownBrokers: [] }
    expect(enabledBrokerIds(store, ['ha_001'])).toEqual(['ha_001'])
  })

  it('treats anything that is not exactly true as off', () => {
    expect(enabledBrokerIds({ 'exportTo:ha_001': 'true' }, ['ha_001'])).toEqual([])
    expect(enabledBrokerIds({ 'exportTo:ha_001': 1 }, ['ha_001'])).toEqual([])
    expect(enabledBrokerIds({}, ['ha_001'])).toEqual([])
    expect(enabledBrokerIds({ 'exportTo:ha_001': false }, ['ha_001'])).toEqual([])
  })

  it('never enables a broker the hub no longer knows', () => {
    const store = { 'exportTo:ha_gone': true, 'exportTo:ha_001': true }
    expect(enabledBrokerIds(store, ['ha_001'])).toEqual(['ha_001'])
  })
})

describe('pruneBrokers is never given an empty list', () => {
  /**
   * The unit itself is honest — asked to keep nothing, it keeps nothing. The
   * bug was the CALLER handing it `[]` from an enumeration that had not
   * resolved yet, which wiped the operator's exported cameras on every boot
   * and persisted the result. Pinned here so the destructive behaviour is
   * visible at the place a future reader will look.
   */
  it('would drop everything if handed an empty known-broker list', () => {
    expect(pruneBrokers({ ha_001: ['101', '104'] }, [])).toEqual({})
  })

  it('keeps a broker that is still known, and forgets one that is not', () => {
    expect(pruneBrokers({ ha_001: ['101'], ha_gone: ['104'] }, ['ha_001'])).toEqual({
      ha_001: ['101'],
    })
  })
})

describe('a broker refresh writes only the key it changed', () => {
  const HA: KnownBroker = { id: 'ha_001', name: 'Home Assistant' }
  const STORED: ExportMembership = { ha_001: ['104', '101'] }

  it('writes nothing when neither the roster nor the membership moved', () => {
    expect(
      brokerRefreshPatch(
        { knownBrokers: [HA], membership: STORED },
        { knownBrokers: [HA], membership: STORED },
      ),
    ).toBeNull()
  })

  /**
   * The regression of 2026-08-24, in one assertion.
   *
   * `this.config` has fallen back to the constructor defaults because the
   * settings read answered empty during the boot window — so `membership` is
   * `{}` and `knownBrokers` is `[]` — while the broker enumeration has come
   * back with `ha_001`. The refresh has real news about the ROSTER and none
   * at all about the membership; naming `membership` here persists the empty
   * default over the operator's two exported cameras, which is what erased
   * them and left Home Assistant three days of orphaned entities.
   */
  it('never names membership when only the broker roster changed', () => {
    // Exactly the production path: `pruned` comes out of `pruneBrokers`, which
    // hands back the SAME object when it removed nothing. Building a second
    // `{}` literal here would test a shape the caller never produces.
    const defaulted: ExportMembership = {}
    const pruned = pruneBrokers(defaulted, ['ha_001'])
    const patch = brokerRefreshPatch(
      { knownBrokers: [], membership: defaulted },
      { knownBrokers: [HA], membership: pruned },
    )
    expect(patch).toEqual({ knownBrokers: [HA] })
    expect(Object.keys(patch ?? {})).not.toContain('membership')
  })

  it('still names membership when a prune really removed a broker', () => {
    const before: ExportMembership = { ha_001: ['101'], ha_gone: ['104'] }
    const pruned = pruneBrokers(before, ['ha_001'])
    const patch = brokerRefreshPatch(
      { knownBrokers: [HA], membership: before },
      { knownBrokers: [HA], membership: pruned },
    )
    expect(patch).toEqual({ membership: { ha_001: ['101'] } })
  })

  it('names both when both moved', () => {
    const before: ExportMembership = { ha_gone: ['104'] }
    const patch = brokerRefreshPatch(
      { knownBrokers: [], membership: before },
      { knownBrokers: [HA], membership: pruneBrokers(before, ['ha_001']) },
    )
    expect(patch).toEqual({ knownBrokers: [HA], membership: {} })
  })

  it('treats a renamed broker as roster news, and still leaves membership alone', () => {
    const patch = brokerRefreshPatch(
      { knownBrokers: [HA], membership: STORED },
      { knownBrokers: [{ id: 'ha_001', name: 'Casa' }], membership: STORED },
    )
    expect(patch).toEqual({ knownBrokers: [{ id: 'ha_001', name: 'Casa' }] })
  })
})
