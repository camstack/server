import { describe, expect, it } from 'vitest'
import { assertValidDeclaration } from '@camstack/types'
import { alexaRecordKinds } from '../broker-record-kinds.js'

describe('the record kinds import-alexa declares', () => {
  it('declares each kind under its own name, which the records service accepts', () => {
    for (const [key, kind] of Object.entries(alexaRecordKinds)) {
      expect(key).toBe(kind.name)
      expect(() => assertValidDeclaration(key, kind.declaration)).not.toThrow()
    }
  })
})
