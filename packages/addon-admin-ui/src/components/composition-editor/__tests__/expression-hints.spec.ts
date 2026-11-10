import { BUILTIN_SIGNATURES } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/en.json'
import it_ from '../../../i18n/it.json'

describe('the formula autocomplete hints (ruling 11)', () => {
  it('every builtin the autocomplete offers has a hint in both languages', () => {
    for (const name of Object.keys(BUILTIN_SIGNATURES)) {
      expect(en.compositionEditor.builtins).toHaveProperty(name)
      expect(it_.compositionEditor.builtins).toHaveProperty(name)
    }
  })
})
