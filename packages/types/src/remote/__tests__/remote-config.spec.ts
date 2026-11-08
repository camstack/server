import { describe, expect, it } from 'vitest'
import {
  EMPTY_REMOTE_CONFIG,
  RemoteConfigSchema,
  RemoteLayoutPayloadSchema,
} from '../remote-config.js'
import { isRemoteRole, isRemoteWidgetRole, REMOTE_KNOWN_ROLES } from '../remote-roles.js'

const action = {
  kind: 'cap' as const,
  deviceId: 5,
  cap: 'switch',
  method: 'turnOn',
}

describe('remote roles', () => {
  it('knows the vocabulary and any custom:<slug>, nothing else', () => {
    expect(REMOTE_KNOWN_ROLES).toContain('digit_9')
    expect(isRemoteRole('volume_up')).toBe(true)
    expect(isRemoteRole('custom:source_hdmi_1')).toBe(true)
    expect(isRemoteRole('custom:Bad Key')).toBe(false)
    expect(isRemoteRole('turbo')).toBe(false)
  })
})

describe('widget roles', () => {
  it('source_select is a known role and the only widget', () => {
    expect(isRemoteRole('source_select')).toBe(true)
    expect(isRemoteWidgetRole('source_select')).toBe(true)
    expect(isRemoteWidgetRole('volume_up')).toBe(false)
    expect(isRemoteWidgetRole('custom:source_select')).toBe(false)
  })

  it('refuses to bind a widget, with a message that says why', () => {
    const parsed = RemoteConfigSchema.safeParse({
      ...EMPTY_REMOTE_CONFIG,
      bindings: { source_select: { action } },
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('layout widget')
  })

  it('refuses a sequence step that presses a widget', () => {
    const parsed = RemoteConfigSchema.safeParse({
      ...EMPTY_REMOTE_CONFIG,
      sources: [{ id: 'x', name: 'X', kind: 'sequence', steps: ['source_select'] }],
    })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain('layout widget')
  })

  it('a layout may place it', () => {
    const parsed = RemoteLayoutPayloadSchema.safeParse({
      columns: 4,
      rows: 1,
      buttons: [{ id: 's', role: 'source_select', row: 0, col: 0, rowSpan: 1, colSpan: 4 }],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('RemoteConfigSchema', () => {
  it('accepts the empty config', () => {
    expect(RemoteConfigSchema.safeParse(EMPTY_REMOTE_CONFIG).success).toBe(true)
  })

  it('refuses a binding under an unknown role', () => {
    const parsed = RemoteConfigSchema.safeParse({
      ...EMPTY_REMOTE_CONFIG,
      bindings: { turbo: { action } },
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses a custom binding with no catalog entry, and a duplicated catalog key', () => {
    expect(
      RemoteConfigSchema.safeParse({
        ...EMPTY_REMOTE_CONFIG,
        bindings: { 'custom:tv': { action } },
      }).success,
    ).toBe(false)
    expect(
      RemoteConfigSchema.safeParse({
        ...EMPTY_REMOTE_CONFIG,
        customButtons: [
          { key: 'tv', name: 'TV' },
          { key: 'tv', name: 'Again' },
        ],
      }).success,
    ).toBe(false)
  })

  it('a binding carries no repeat count: the caller supplies it', () => {
    const parsed = RemoteConfigSchema.safeParse({
      ...EMPTY_REMOTE_CONFIG,
      bindings: { volume_up: { action, repeat: 3 } },
    })
    expect(parsed.success && 'repeat' in (parsed.data.bindings['volume_up'] ?? {})).toBe(false)
  })
})

describe('RemoteLayoutPayloadSchema', () => {
  const button = { id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' }

  it('accepts a grid of placed buttons', () => {
    const ok = RemoteLayoutPayloadSchema.safeParse({
      columns: 3,
      rows: 2,
      buttons: [button, { ...button, id: 'b', col: 1, colSpan: 2, role: 'custom:tv' }],
    })
    expect(ok.success).toBe(true)
  })

  it.each([
    ['overlap', [button, { ...button, id: 'b' }]],
    ['outside the grid', [{ ...button, col: 2, colSpan: 2 }]],
    ['a repeated id', [button, { ...button, col: 1 }]],
    ['an unknown role', [{ ...button, role: 'turbo' }]],
  ])('refuses %s', (_name, buttons) => {
    expect(RemoteLayoutPayloadSchema.safeParse({ columns: 3, rows: 2, buttons }).success).toBe(
      false,
    )
  })
})
