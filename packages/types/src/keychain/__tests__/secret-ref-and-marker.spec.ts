import { describe, expect, it } from 'vitest'
import { REDACTED_SECRET } from '../../interfaces/config-ui-secrets.js'
import {
  classifySecretWrite,
  isSecretMarker,
  makeSecretMarker,
  SECRET_CLEAR,
  toSecretFieldView,
} from '../secret-marker.js'
import {
  arrayItemFieldPath,
  buildSecretRef,
  normalizeSecretOwner,
  parseSecretRef,
} from '../secret-ref.js'

describe('secret refs', () => {
  it('round-trips every scope kind', () => {
    const cases = [
      { owner: 'auth-oidc', scope: { kind: 'global' as const }, fieldPath: 'clientSecret' },
      {
        owner: 'tailscale',
        scope: { kind: 'node' as const, nodeId: 'hub/x' },
        fieldPath: 'authKey',
      },
      {
        owner: 'provider-onvif',
        scope: { kind: 'device' as const, deviceId: 101 },
        fieldPath: 'password',
      },
      {
        owner: 'provider-wyze',
        scope: { kind: 'integration' as const, integrationId: 'int 1' },
        fieldPath: 'apiKey',
      },
      {
        owner: 'storage-orchestrator',
        scope: { kind: 'row' as const, collection: 'storage_locations', rowId: 'sftp:a/b' },
        fieldPath: 'password',
      },
    ]
    for (const c of cases) {
      const ref = buildSecretRef(c)
      expect(parseSecretRef(ref)).toEqual(c)
    }
  })

  it('addresses an array item by id, so a reorder keeps the ref', () => {
    const path = arrayItemFieldPath('providers', 'authentik', 'clientSecret')
    expect(path).toBe('providers[authentik].clientSecret')
    const ref = buildSecretRef({ owner: 'auth-oidc', scope: { kind: 'global' }, fieldPath: path })
    expect(ref).toBe('secret://auth-oidc/global/providers[authentik].clientSecret')
  })

  it('normalises the in-process context id to the addon id', () => {
    expect(normalizeSecretOwner('addon:loki-logging')).toBe('loki-logging')
    expect(
      buildSecretRef({
        owner: 'addon:loki-logging',
        scope: { kind: 'global' },
        fieldPath: 'password',
      }),
    ).toBe('secret://loki-logging/global/password')
  })

  it('refuses malformed refs', () => {
    expect(parseSecretRef('secret://')).toBeNull()
    expect(parseSecretRef('secret://owner/global')).toBeNull()
    expect(parseSecretRef('secret://owner/device/abc/password')).toBeNull()
    expect(parseSecretRef('http://owner/global/x')).toBeNull()
  })
})

describe('secret write classification — the save-path contract', () => {
  it("'' never clears", () => {
    expect(classifySecretWrite('')).toEqual({ kind: 'keep' })
  })

  it('null, undefined, markers, views and redaction tokens keep', () => {
    const marker = makeSecretMarker('secret://a/global/x')
    for (const v of [
      null,
      undefined,
      marker,
      toSecretFieldView(marker),
      REDACTED_SECRET,
      '***',
      42,
      { $secret: null, v: 1, set: true },
    ]) {
      expect(classifySecretWrite(v)).toEqual({ kind: 'keep' })
    }
  })

  it('only the explicit instruction clears', () => {
    expect(classifySecretWrite(SECRET_CLEAR)).toEqual({ kind: 'clear' })
  })

  it('a typed non-empty string sets', () => {
    expect(classifySecretWrite('hunter2-but-longer')).toEqual({
      kind: 'set',
      value: 'hunter2-but-longer',
    })
  })

  it('a UI view never carries the value', () => {
    expect(toSecretFieldView('plaintext-still-inline')).toEqual({
      $secret: null,
      v: 1,
      set: true,
      inline: true,
    })
    expect(toSecretFieldView(null)).toBeNull()
    expect(toSecretFieldView('')).toBeNull()
    expect(isSecretMarker(toSecretFieldView(makeSecretMarker('secret://a/global/x')))).toBe(true)
  })
})
