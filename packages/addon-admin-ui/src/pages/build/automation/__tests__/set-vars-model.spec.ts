/**
 * The rows of a `set` step: a record edited as an ordered list, where a rename
 * keeps the row's place and its value, and a second blank row cannot be added
 * over the first (two rows cannot share a name).
 */
import { describe, expect, it } from 'vitest'
import { addVar, canAddVar, removeVar, renameVar, setVarRows, setVarValue } from '../set-vars-model'

describe('set-vars-model', () => {
  const vars = { room: 'kitchen', level: 3 }

  it('lists the rows in the stored order', () => {
    expect(setVarRows(vars)).toEqual([
      { name: 'room', value: 'kitchen' },
      { name: 'level', value: 3 },
    ])
  })

  it('a rename keeps the place and the value', () => {
    expect(Object.entries(renameVar(vars, 0, 'zone'))).toEqual([
      ['zone', 'kitchen'],
      ['level', 3],
    ])
  })

  it('a rename onto a name another row holds is refused: nothing changes', () => {
    expect(renameVar(vars, 0, 'level')).toBe(vars)
  })

  it('sets a value as text, adds one blank row at most, and removes a row', () => {
    expect(setVarValue(vars, 1, '{{vars.score}}')).toEqual({
      room: 'kitchen',
      level: '{{vars.score}}',
    })
    const added = addVar(vars)
    expect(Object.keys(added)).toEqual(['room', 'level', ''])
    expect(canAddVar(vars)).toBe(true)
    expect(canAddVar(added)).toBe(false)
    expect(addVar(added)).toBe(added)
    expect(removeVar(vars, 0)).toEqual({ level: 3 })
  })
})
