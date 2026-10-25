/**
 * H4 (D690 review): the scope pre-selector every list field shares speaks the
 * admin UI's language — the mode words and the accessible name.
 */
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/en.json'
import itJson from '../../../i18n/it.json'
import { ruleScopeDraftOf } from '../rule-scope-model'
import { RuleScopeField } from '../RuleScopeField'

async function renderIn(language: 'en' | 'it'): Promise<void> {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, it: { translation: itJson } },
    lng: language,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  render(
    <I18nextProvider i18n={i18n}>
      <RuleScopeField
        draft={ruleScopeDraftOf<number>(undefined, undefined)}
        onChange={() => {}}
        exceptOffered
        plural="devices"
        describe={(id) => String(id)}
        renderPicker={() => null}
      />
    </I18nextProvider>,
  )
}

describe('RuleScopeField — i18n', () => {
  it('speaks Italian under it', async () => {
    await renderIn('it')
    expect(screen.getByRole('radiogroup', { name: 'Quali dispositivi' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Solo i selezionati' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Tutti tranne i selezionati' })).toBeTruthy()
    expect(screen.getByText('Tutti i dispositivi — nessuna restrizione.')).toBeTruthy()
  })

  it('keeps the English words under en', async () => {
    await renderIn('en')
    expect(screen.getByRole('radiogroup', { name: 'Which devices' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Only these' })).toBeTruthy()
  })
})
