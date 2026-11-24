import { describe, it, expect } from 'vitest'
import {
  AppDeclarationSchema,
  AppEntrySchema,
  AppReachSchema,
  parseAppBridgeMessage,
} from '../index.js'

const label = { key: 'apps.x', fallback: 'X' }

describe('AppEntrySchema', () => {
  it('accepts each entry kind', () => {
    expect(AppEntrySchema.safeParse({ kind: 'native', route: '/cameras' }).success).toBe(true)
    expect(AppEntrySchema.safeParse({ kind: 'web', path: '/admin', auth: 'handoff' }).success).toBe(
      true,
    )
    expect(AppEntrySchema.safeParse({ kind: 'addon-page', pageId: 'benchmark' }).success).toBe(true)
  })
  it('rejects an unknown kind and a web entry with an unknown auth', () => {
    expect(AppEntrySchema.safeParse({ kind: 'iframe', path: '/' }).success).toBe(false)
    expect(AppEntrySchema.safeParse({ kind: 'web', path: '/a', auth: 'token' }).success).toBe(false)
  })
})

describe('AppReachSchema', () => {
  it('needs a nodeId for a node reach', () => {
    expect(AppReachSchema.safeParse({ kind: 'node', nodeId: 'n1' }).success).toBe(true)
    expect(AppReachSchema.safeParse({ kind: 'node' }).success).toBe(false)
    expect(AppReachSchema.safeParse({ kind: 'lan-only' }).success).toBe(true)
  })
})

describe('AppDeclarationSchema', () => {
  const base = {
    id: 'admin',
    label,
    icon: 'settings',
    entry: { kind: 'web', path: '/admin', auth: 'session-cookie' },
    reach: { kind: 'hub' },
    adminOnly: true,
    nav: [{ id: 's', label: null, items: [{ id: 'i', label, icon: 'x', path: '/p' }] }],
    takesSharedSearch: true,
    settings: { path: '/settings' },
  }
  it('accepts a full declaration and a null settings', () => {
    expect(AppDeclarationSchema.safeParse(base).success).toBe(true)
    expect(AppDeclarationSchema.safeParse({ ...base, settings: null }).success).toBe(true)
  })
  it('rejects a label without a key', () => {
    expect(
      AppDeclarationSchema.safeParse({ ...base, label: { key: '', fallback: 'X' } }).success,
    ).toBe(false)
  })
})

describe('parseAppBridgeMessage', () => {
  const env = { camstack: 'app-bridge', v: 1 }
  it('accepts every message of both directions', () => {
    const ok = [
      { type: 'hello' },
      { type: 'navigate', path: '/a' },
      { type: 'search', query: 'q' },
      { type: 'theme', mode: 'dark' },
      { type: 'ready', path: '/' },
      { type: 'path', path: '/a', title: 'A' },
      { type: 'invalidate', what: 'badges' },
      { type: 'open-app', appId: 'admin' },
      { type: 'open-app', appId: 'admin', path: '/x' },
    ]
    for (const m of ok) expect(parseAppBridgeMessage({ ...env, ...m })?.type).toBe(m.type)
  })
  it('rejects a foreign envelope, a wrong version, a bad payload and non-objects', () => {
    expect(parseAppBridgeMessage({ camstack: 'other', v: 1, type: 'hello' })).toBeNull()
    expect(parseAppBridgeMessage({ ...env, v: 2, type: 'hello' })).toBeNull()
    expect(parseAppBridgeMessage({ ...env, type: 'theme', mode: 'blue' })).toBeNull()
    expect(parseAppBridgeMessage({ ...env, type: 'navigate' })).toBeNull()
    expect(parseAppBridgeMessage({ ...env, type: 'unknown' })).toBeNull()
    expect(parseAppBridgeMessage('hello')).toBeNull()
    expect(parseAppBridgeMessage(null)).toBeNull()
  })
})
