import { describe, expect, it } from 'vitest'
import { BUILTIN_REMOTE_COMPONENTS } from '../remote-builtin-components.js'
import { RemoteLayoutPayloadSchema } from '../remote-config.js'
import { RemoteLayoutComponentSchema } from '../remote-components.js'

const key = (id: string, row: number, col: number, extra = {}) => ({
  id,
  row,
  col,
  rowSpan: 1,
  colSpan: 1,
  role: 'ok',
  ...extra,
})
const group = (
  id: string,
  row: number,
  col: number,
  rowSpan: number,
  colSpan: number,
  extra = {},
) => ({ id, componentId: 'core:panel', frame: 'panel', row, col, rowSpan, colSpan, ...extra })
const base = (extra: Record<string, unknown>) => ({ columns: 4, rows: 4, buttons: [], ...extra })
const refusal = (payload: unknown): string =>
  JSON.stringify(RemoteLayoutPayloadSchema.safeParse(payload).error?.issues ?? 'accepted')

describe('layout groups, shapes and tones', () => {
  it('parses an old payload (no groups, shapes, tones) unchanged', () => {
    const old = base({ buttons: [key('a', 0, 0)] })
    const parsed = RemoteLayoutPayloadSchema.parse(old)
    expect(parsed).toEqual(old)
    expect('groups' in parsed).toBe(false)
  })

  it('accepts a group with members, a shape and a tone', () => {
    const ok = base({
      groups: [group('g', 0, 0, 2, 2, { title: 'Nav' })],
      buttons: [key('a', 0, 0, { groupId: 'g', shape: 'round', tone: 'accent' })],
    })
    expect(RemoteLayoutPayloadSchema.safeParse(ok).success).toBe(true)
  })

  it('refuses a shape, tone or frame outside the closed vocabularies', () => {
    const shape = base({ buttons: [key('a', 0, 0, { shape: 'star' })] })
    const tone = base({ buttons: [key('a', 0, 0, { tone: 'pink' })] })
    const frame = base({ groups: [group('g', 0, 0, 1, 1, { frame: 'neon' })] })
    expect(RemoteLayoutPayloadSchema.safeParse(shape).success).toBe(false)
    expect(RemoteLayoutPayloadSchema.safeParse(tone).success).toBe(false)
    expect(RemoteLayoutPayloadSchema.safeParse(frame).success).toBe(false)
  })

  it.each([
    ['a group leaving the grid', base({ groups: [group('g', 3, 3, 2, 2)] }), /leaves the grid/],
    [
      'two overlapping groups',
      base({ groups: [group('g', 0, 0, 2, 2), group('h', 1, 1, 2, 2)] }),
      /overlap/,
    ],
    [
      'a duplicated group id',
      base({ groups: [group('g', 0, 0, 1, 1), group('g', 2, 2, 1, 1)] }),
      /used twice/,
    ],
    [
      'a member outside its group',
      base({ groups: [group('g', 0, 0, 1, 1)], buttons: [key('a', 2, 2, { groupId: 'g' })] }),
      /outside its group/,
    ],
    [
      'an unknown groupId',
      base({ buttons: [key('a', 0, 0, { groupId: 'nope' })] }),
      /unknown group/,
    ],
    [
      'a divider with a member',
      base({
        groups: [group('g', 0, 0, 1, 4, { frame: 'divider' })],
        buttons: [key('a', 0, 0, { groupId: 'g' })],
      }),
      /divider/,
    ],
    [
      'a stray key inside a group',
      base({ groups: [group('g', 0, 0, 2, 2)], buttons: [key('a', 0, 0)] }),
      /not a member/,
    ],
  ])('refuses %s', (_name, payload, message) => {
    expect(refusal(payload)).toMatch(message)
  })
})

describe('component definitions', () => {
  it('every built-in component parses; ids are unique and namespaced', () => {
    const ids = BUILTIN_REMOTE_COMPONENTS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const component of BUILTIN_REMOTE_COMPONENTS) {
      const parsed = RemoteLayoutComponentSchema.safeParse(component)
      expect(parsed.success, `${component.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect(component.id.startsWith('core:')).toBe(true)
    }
    expect(ids).toEqual(
      expect.arrayContaining([
        'core:power',
        'core:dpad',
        'core:rocker-volume-v',
        'core:rocker-channel-v',
        'core:rocker-h',
        'core:keypad',
        'core:colour-keys',
        'core:media-transport',
        'core:apps-row',
        'core:section-divider',
        'core:panel',
        'core:back-home-menu',
      ]),
    )
  })

  it('refuses a component whose button leaves it, overlaps another, or sits in a divider', () => {
    const component = BUILTIN_REMOTE_COMPONENTS.find((c) => c.id === 'core:dpad')
    if (component === undefined) throw new Error('missing core:dpad')
    const accepts = (buttons: unknown, extra = {}) =>
      RemoteLayoutComponentSchema.safeParse({ ...component, buttons, ...extra }).success
    const one = { idSuffix: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'ok' }
    expect(accepts([{ ...one, row: 2, col: 2, rowSpan: 2 }])).toBe(false)
    expect(accepts([one, { ...one, idSuffix: 'b', role: 'up' }])).toBe(false)
    expect(accepts([one], { group: { frame: 'divider' } })).toBe(false)
    expect(accepts([{ ...one, role: 'turbo' }])).toBe(false)
    expect(accepts([one])).toBe(true)
  })
})
