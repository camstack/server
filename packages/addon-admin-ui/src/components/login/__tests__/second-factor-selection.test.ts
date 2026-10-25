import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `second-factor-selection.ts` contract — the fix for the fallback
 * footgun: the second-factor phase must fall back to the MF `widget`
 * arm whenever no `passkey` arm is USABLE, not merely when none was
 * contributed. `isPasskeyMethodUsable` / `selectSecondFactorMethods`
 * both take an injectable `getHostname` so these are pure unit tests —
 * no `window.location` or jsdom WebAuthn stubbing required.
 */

let webAuthnSupported = true

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => webAuthnSupported,
}))

import type { LoginMethod, PasskeyLoginMethod, WidgetLoginMethod } from '../PrimaryLoginMethods'
import {
  isPasskeyMethodUsable,
  needsOriginHint,
  selectSecondFactorMethods,
} from '../second-factor-selection'

const passkeyArm: PasskeyLoginMethod = {
  kind: 'passkey',
  id: 'auth-webauthn/passkey-login',
  label: 'Use a passkey',
  stage: 'second-factor',
  rpId: 'example.com',
  origin: null,
}

const widgetArm: WidgetLoginMethod = {
  kind: 'widget',
  id: 'auth-webauthn/passkey-login-widget',
  addonId: 'auth-webauthn',
  bundle: 'remoteEntry.js',
  remote: { remoteName: 'addon_auth_webauthn_widgets', exposedModule: './widgets' },
  stage: 'second-factor',
  bundleUrl: '/api/addon-widgets/auth-webauthn/remoteEntry.js?v=1',
}

beforeEach(() => {
  webAuthnSupported = true
})

describe('isPasskeyMethodUsable', () => {
  it('is usable when the browser supports WebAuthn and the hostname matches the rpId', () => {
    expect(isPasskeyMethodUsable(passkeyArm, () => 'example.com')).toBe(true)
  })

  it('is NOT usable when the browser lacks WebAuthn support', () => {
    webAuthnSupported = false
    expect(isPasskeyMethodUsable(passkeyArm, () => 'example.com')).toBe(false)
  })

  it('is NOT usable when the hostname is a raw IP (fails the origin gate)', () => {
    expect(isPasskeyMethodUsable(passkeyArm, () => '192.168.10.9')).toBe(false)
  })

  it('is NOT usable when the hostname does not match the rpId', () => {
    expect(isPasskeyMethodUsable(passkeyArm, () => 'evil.com')).toBe(false)
  })
})

describe('selectSecondFactorMethods', () => {
  it('selects the passkey arm and skips the widget fallback when the gate passes', () => {
    const methods: readonly LoginMethod[] = [passkeyArm, widgetArm]
    const result = selectSecondFactorMethods(methods, () => 'example.com')
    expect(result.passkeyMethods).toEqual([passkeyArm])
    expect(result.widgetMethods).toEqual([])
  })

  it('falls back to the widget arm when the passkey arm exists but the gate fails (raw-IP origin)', () => {
    const methods: readonly LoginMethod[] = [passkeyArm, widgetArm]
    const result = selectSecondFactorMethods(methods, () => '192.168.10.9')
    expect(result.passkeyMethods).toEqual([])
    expect(result.widgetMethods).toEqual([widgetArm])
  })

  it('falls back to the widget arm when the passkey arm exists but the gate fails (rpId mismatch)', () => {
    const methods: readonly LoginMethod[] = [passkeyArm, widgetArm]
    const result = selectSecondFactorMethods(methods, () => 'not-example.com')
    expect(result.passkeyMethods).toEqual([])
    expect(result.widgetMethods).toEqual([widgetArm])
  })

  it('falls back to the widget arm when no passkey arm was contributed at all', () => {
    const methods: readonly LoginMethod[] = [widgetArm]
    const result = selectSecondFactorMethods(methods, () => 'example.com')
    expect(result.passkeyMethods).toEqual([])
    expect(result.widgetMethods).toEqual([widgetArm])
  })

  it('selects neither when no second-factor arm is usable and none was contributed', () => {
    const result = selectSecondFactorMethods([], () => 'example.com')
    expect(result.passkeyMethods).toEqual([])
    expect(result.widgetMethods).toEqual([])
  })

  it('ignores primary-stage arms entirely', () => {
    const primaryPasskey: PasskeyLoginMethod = { ...passkeyArm, stage: 'primary' }
    const primaryWidget: WidgetLoginMethod = { ...widgetArm, stage: 'primary' }
    const result = selectSecondFactorMethods([primaryPasskey, primaryWidget], () => 'example.com')
    expect(result.passkeyMethods).toEqual([])
    expect(result.widgetMethods).toEqual([])
  })
})

describe('needsOriginHint', () => {
  const usablePasskeySelection = { passkeyMethods: [passkeyArm], widgetMethods: [] }
  const widgetFallbackSelection = { passkeyMethods: [], widgetMethods: [widgetArm] }
  const emptySelection = { passkeyMethods: [], widgetMethods: [] }

  it('is true when a passkey factor has no usable method and no TOTP fallback (raw-IP dead-end)', () => {
    expect(needsOriginHint(['passkey'], emptySelection)).toBe(true)
  })

  it('is false when a TOTP factor can carry the challenge', () => {
    expect(needsOriginHint(['passkey', 'totp'], emptySelection)).toBe(false)
  })

  it('is false when a usable native passkey method exists', () => {
    expect(needsOriginHint(['passkey'], usablePasskeySelection)).toBe(false)
  })

  it('is false when a widget fallback method exists', () => {
    expect(needsOriginHint(['passkey'], widgetFallbackSelection)).toBe(false)
  })

  it('is false when the challenge has no passkey factor at all', () => {
    expect(needsOriginHint(['totp'], emptySelection)).toBe(false)
  })
})
