import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAddonBundle } from '../addon-i18n'
import { createAddonI18n } from '../use-addon-t'

const en = {
  title: 'Models',
  greeting: 'Hello {{name}}',
  items_one: '{{count}} item',
  items_other: '{{count}} items',
  confirm: 'Delete <b>{{name}}</b> now?',
  nested: { deep: 'Deep' },
}
const itBundle = {
  title: 'Modelli',
  greeting: 'Ciao {{name}}',
  items_one: '{{count}} elemento',
  items_other: '{{count}} elementi',
  confirm: 'Eliminare <b>{{name}}</b> ora?',
  nested: { deep: 'Profondo' },
}

const { useT, Trans } = createAddonI18n('spec-ns', { en, it: itBundle })

function Probe(): React.ReactElement {
  const { t } = useT()
  return (
    <div>
      <span data-testid="title">{t('title')}</span>
      <span data-testid="greeting">{t('greeting', { name: 'Ada' })}</span>
      <span data-testid="plural">{t('items', { count: 2 })}</span>
      <span data-testid="singular">{t('items', { count: 1 })}</span>
      <span data-testid="nested">{t('nested.deep')}</span>
      <p data-testid="trans">
        <Trans i18nKey="confirm" values={{ name: '<x>' }} components={{ b: <strong /> }} />
      </p>
    </div>
  )
}

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
})

describe('addon i18n', () => {
  it('renders English and interpolates, pluralises and nests', () => {
    document.documentElement.lang = 'en'
    render(<Probe />)
    expect(screen.getByTestId('title').textContent).toBe('Models')
    expect(screen.getByTestId('greeting').textContent).toBe('Hello Ada')
    expect(screen.getByTestId('plural').textContent).toBe('2 items')
    expect(screen.getByTestId('singular').textContent).toBe('1 item')
    expect(screen.getByTestId('nested').textContent).toBe('Deep')
  })

  it('follows the html lang the host sets, live', async () => {
    document.documentElement.lang = 'en'
    render(<Probe />)
    await act(async () => {
      document.documentElement.lang = 'it-IT'
      await Promise.resolve()
    })
    expect(screen.getByTestId('title').textContent).toBe('Modelli')
    expect(screen.getByTestId('plural').textContent).toBe('2 elementi')
  })

  it('falls back to English for an unknown language', () => {
    document.documentElement.lang = 'fr'
    render(<Probe />)
    expect(screen.getByTestId('title').textContent).toBe('Models')
  })

  it('wraps inline elements without letting a value become markup', () => {
    document.documentElement.lang = 'en'
    render(<Probe />)
    expect(screen.getByTestId('trans').innerHTML).toBe('Delete <strong>&lt;x&gt;</strong> now?')
  })

  it('a registered bundle replaces the bundled one without touching call sites', async () => {
    document.documentElement.lang = 'it'
    render(<Probe />)
    await act(async () => {
      registerAddonBundle('spec-ns', 'it', { ...itBundle, title: 'Dal hub' })
    })
    expect(screen.getByTestId('title').textContent).toBe('Dal hub')
  })

  it('answers an unknown key with the key itself', () => {
    function Missing(): React.ReactElement {
      const { t } = useT()
      // @ts-expect-error the key is deliberately not in the bundle
      return <span data-testid="missing">{t('nope.nothing')}</span>
    }
    render(<Missing />)
    expect(screen.getByTestId('missing').textContent).toBe('nope.nothing')
  })
})
