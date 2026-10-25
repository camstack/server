import { describe, expect, it } from 'vitest'
import { scopeOwnerOf } from '../sqlite-settings-backend.js'

/**
 * `(op, collection)` cannot name a culprit.
 *
 * The 60 s window measured on 2026-08-25 read `query addon-device-settings`
 * **67 660 calls** — 1 128 a second on a single-threaded synchronous engine
 * that every cluster-wide configuration read queues behind. The report said
 * WHAT was running and never WHO, so the investigation could only produce a
 * plausible mechanism (~40 addons x ~700 devices, swept twice a minute) and no
 * name.
 *
 * The caller identity is not reachable from here — the cap handler receives an
 * input, not a caller — but for the scoped collections it does not have to be:
 * the id IS `<addonId>:<deviceId>.<field>`, so a filter that names an id names
 * its owner. Same source and same shape as `deviceIdOf`, which already lifts
 * the device out of the very same filter.
 */
describe('scopeOwnerOf', () => {
  it('lifts the addon out of a scoped id', () => {
    expect(scopeOwnerOf({ where: { id: 'addon-pipeline:102.enabled' } })).toEqual({
      owner: 'addon-pipeline',
    })
  })

  it('reads an id with no field suffix', () => {
    expect(scopeOwnerOf({ where: { id: 'addon-post-analysis:101' } })).toEqual({
      owner: 'addon-post-analysis',
    })
  })

  /**
   * The read that actually storms is a RANGE, and the range was invisible.
   *
   * Every scoped read the in-process door makes — `readDeviceStore`,
   * `readAddonStore`, and the batch that replaced them — is a prefix range, so
   * it arrives as `whereBetween: { id: [lo, hi) }` and never as `where.id`. On
   * 2026-08-25 that was 9 226 `query addon-device-settings` a minute, in every
   * single 60 s window, and the profiler printed no owner for one of them: the
   * only shape of read that reaches this table at volume was the one shape this
   * function did not look at.
   */
  it('lifts the addon out of a prefix RANGE, which is how a scoped read arrives', () => {
    expect(
      scopeOwnerOf({ whereBetween: { id: ['device-manager:102.', 'device-manager:102/'] } }),
    ).toEqual({ owner: 'device-manager' })
  })

  it('prefers the exact id when a filter carries both', () => {
    expect(
      scopeOwnerOf({
        where: { id: 'recorder:101.enabled' },
        whereBetween: { id: ['device-manager:1.', 'device-manager:1/'] },
      }),
    ).toEqual({ owner: 'recorder' })
  })

  it('attributes nothing for a range whose lower bound carries no scope', () => {
    expect(
      scopeOwnerOf({ whereBetween: { id: ['system-settings.', 'system-settings/'] } }),
    ).toEqual({})
    expect(scopeOwnerOf({ whereBetween: { timestamp: [0, 1] } })).toEqual({})
  })

  it('attributes nothing rather than guessing when the id is unscoped', () => {
    expect(scopeOwnerOf({ where: { id: 'system-settings.theme' } })).toEqual({})
    expect(scopeOwnerOf({ where: { id: '' } })).toEqual({})
    expect(scopeOwnerOf({ where: { id: ':102.enabled' } })).toEqual({})
  })

  it('attributes nothing when the filter does not name an id at all', () => {
    expect(scopeOwnerOf({ where: { deviceId: 102 } })).toEqual({})
    expect(scopeOwnerOf({})).toEqual({})
    expect(scopeOwnerOf(undefined)).toEqual({})
  })

  it('ignores a non-string id — a number cannot carry a scope', () => {
    expect(scopeOwnerOf({ where: { id: 42 } })).toEqual({})
  })
})
