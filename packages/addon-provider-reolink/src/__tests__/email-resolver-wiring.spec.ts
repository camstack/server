import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * The email-push Auto-configure resolver must be wired on BOTH
 * `DeviceRegistered` AND `DeviceMetaChanged`.
 *
 * Why: the hub's device-manager emits `DeviceRegistered` ONLY on a device's
 * FIRST registration. When ONLY this addon is redeployed (the common dev
 * case), the hub already knows the camera, so its re-registration emits
 * `DeviceMetaChanged` instead. Subscribing to `DeviceRegistered` alone left
 * every restored battery cam with `emailPushParamsResolver === undefined` →
 * "Auto-configure" failed with "resolver not wired — restart the Reolink
 * addon". Covering both events makes the resolver wire on an addon-only
 * restart too.
 */
const here = dirname(fileURLToPath(import.meta.url))
const addonSrc = readFileSync(resolve(here, '../addon.ts'), 'utf8')

describe('email-push resolver wiring', () => {
  it('subscribes to DeviceRegistered for resolver wiring', () => {
    expect(addonSrc).toMatch(/subscribe\(\s*\{\s*category:\s*EventCategory\.DeviceRegistered\s*\}/)
  })

  it('ALSO subscribes to DeviceMetaChanged (covers addon-only redeploy)', () => {
    expect(addonSrc).toMatch(/subscribe\(\s*\{\s*category:\s*EventCategory\.DeviceMetaChanged\s*\}/)
  })

  it('the wiring handler injects email + HaCfg webhook resolvers', () => {
    expect(addonSrc).toMatch(
      /setEmailPushParamsResolver\(\s*\(\)\s*=>\s*emailServer\.buildCameraSetupParams/,
    )
    expect(addonSrc).toMatch(
      /setBaichuanWebhookParamsResolver\(\s*\(\)\s*=>\s*webhookServer\.buildCameraSetupParams/,
    )
  })
})
