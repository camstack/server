import { describe, expect, it } from 'vitest'
import { comparePins, findNativeControls, inScope } from '../check-no-native-form-controls'

describe('check-no-native-form-controls', () => {
  it('flags select, input, textarea and button, multi-line openers included', () => {
    const src = [
      '<select value={a} onChange={f}>',
      '<input type="checkbox" />',
      '<textarea',
      '  rows={3}',
      '/>',
      '<button type="button">x</button>',
    ].join('\n')
    expect(findNativeControls(src).map((f) => f.tag)).toEqual([
      'select',
      'input',
      'textarea',
      'button',
    ])
  })

  it('leaves library components, generics and comments alone', () => {
    const src = [
      '<Select options={o} />',
      '<Button>ok</Button>',
      '<Input value={v} />',
      '// <select> in prose',
      ' * <button> in a doc block',
      'const m: Map<string, Array<selectOption>> = new Map()',
    ].join('\n')
    expect(findNativeControls(src)).toEqual([])
  })

  it('honours a ui-check-ok marker on the same or the previous line', () => {
    expect(findNativeControls('<button // ui-check-ok: a selectable card\n')).toEqual([])
    expect(findNativeControls('// ui-check-ok: card\n<button type="button">')).toEqual([])
    expect(findNativeControls('<button type="button">')).toHaveLength(1)
  })

  it('scopes to admin-ui and addon sources, not the library, specs or non-tsx', () => {
    expect(inScope('packages/addon-admin-ui/src/pages/A.tsx')).toBe(true)
    expect(inScope('packages/addon-model-studio/src/page.tsx')).toBe(true)
    expect(inScope('packages/ui-library/src/primitives/select.tsx')).toBe(false)
    expect(inScope('packages/addon-admin-ui/src/pages/__tests__/A.tsx')).toBe(false)
    expect(inScope('packages/addon-admin-ui/src/pages/A.spec.tsx')).toBe(false)
    expect(inScope('packages/addon-admin-ui/src/pages/a.ts')).toBe(false)
  })

  it('fails a new file or a grown count, and asks to lower a shrunk pin', () => {
    expect(comparePins({ 'a.tsx': 2 }, { 'a.tsx': 2 })).toEqual({ worse: [], better: [] })
    expect(comparePins({ 'a.tsx': 3 }, { 'a.tsx': 2 }).worse).toHaveLength(1)
    expect(comparePins({ 'new.tsx': 1 }, {}).worse).toHaveLength(1)
    expect(comparePins({ 'a.tsx': 1 }, { 'a.tsx': 2 }).better).toHaveLength(1)
    expect(comparePins({}, { 'a.tsx': 2 }).better).toHaveLength(1)
  })
})
