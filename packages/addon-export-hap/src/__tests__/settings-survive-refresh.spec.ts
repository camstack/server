/**
 * A settings change must SURVIVE the refresh that the change itself triggers.
 *
 * `exposeDevice` rebuilds the stored entry and carries `settings` forward from
 * the previous one — `carryForward`, which is correct and has its own spec
 * recording this very failure ("the operator pinned `low`, the accessory came
 * back advertising `auto`").
 *
 * But `applyDeviceSettingsPatch` refreshes by `unexposeDevice` then
 * `exposeDevice`, and `unexposeDevice` REMOVES the entry from
 * `config.exposed`. So by the time `exposeDevice` looks for `previous` there is
 * nothing there, `carryForward` has nothing to carry, and the accessory comes
 * back on defaults. The fix was real and the call site defeated it.
 *
 * Measured live on 2026-09-17: pinning device 104 to `mid` logged
 * `streamPreference {"from":"auto","to":"mid"}`, refreshed the accessory, and
 * read back `auto`.
 *
 * The check is structural because the defect is a call ORDER, and the unit
 * test of the mechanism passes either way — which is exactly how this survived
 * having a fix and a spec.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../hap-export.addon.ts'),
  'utf8',
)

describe('the refresh after a settings change', () => {
  /**
   * The settings must travel INTO the rebuild, not be applied after it.
   *
   * Applying them afterwards persists the value and changes nothing the
   * controller can see: the mapper — and with it the advertised resolution
   * list — is already built. Measured 2026-09-17, with exactly that fix in
   * place: the stored value read `mid` while the accessory went on advertising
   * `streamPreference=auto`.
   */
  it('re-exposes WITH the settings the patch computed', () => {
    const refresh = SOURCE.slice(
      SOURCE.indexOf('await this.unexposeDevice(deviceIdStr, { clearPairing'),
    )
    expect(
      refresh.slice(0, 2000),
      'the re-expose does not carry nextSettings — the accessory will be rebuilt on the defaults, because the unexpose deleted the entry carryForward reads',
    ).toContain('await this.exposeDevice(deviceIdStr, undefined, nextSettings)')
  })

  /**
   * And the seed must actually reach the stored entry. `carryForward` only
   * fills keys that are ABSENT, so a seeded `settings` has to be present on
   * the object handed to it or the previous value silently wins.
   */
  it('seeds the rebuilt entry before carrying anything forward', () => {
    const expose = SOURCE.slice(SOURCE.indexOf('private async exposeDevice'))
    const seedAt = expose.indexOf('settings === undefined ? rebuilt : { ...rebuilt, settings }')
    const carryAt = expose.indexOf('carryForward(')
    expect(
      seedAt,
      'nothing seeds the rebuilt entry with the caller’s settings',
    ).toBeGreaterThanOrEqual(0)
    expect(seedAt, 'the seed happens after carryForward, which is too late').toBeLessThan(carryAt)
  })
})
