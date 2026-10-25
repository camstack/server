import { describe, expect, it } from 'vitest'
import { vocabularyCapTitle, vocabularyFieldLabel } from '../vocabulary-field-label'

describe('vocabularyFieldLabel', () => {
  it('uses the vocabulary noun and appends a declared unit', () => {
    expect(vocabularyCapTitle('temperature-sensor', 'en')).toBe('Temperature')
    expect(vocabularyCapTitle('temperature-sensor', 'it')).toBe('Temperatura')
    expect(vocabularyCapTitle('binary', 'en')).toBe('Binary sensor')
    expect(vocabularyFieldLabel('temperature-sensor', 'celsius', 'en')).toBe('Temperature (°C)')
    expect(vocabularyFieldLabel('binary', 'on', 'en')).toBe('On')
    expect(vocabularyFieldLabel('binary', 'on', 'it')).toBe('Acceso')
    expect(vocabularyFieldLabel('binary', 'lastChangedAt', 'en')).toBe('Last change')
    expect(vocabularyFieldLabel('temperature-sensor', 'lastFetchedAt', 'it')).toBe(
      'Ultimo aggiornamento',
    )
  })
})
