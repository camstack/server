// @vitest-environment jsdom
/** The read-only shortcut list shows what is registered with the provider. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HotkeyProvider, useHotkey } from '@camstack/ui-library'
import '../../../i18n'
import { HotkeysCard, formatCombo } from '../HotkeysCard'

afterEach(cleanup)

function Registers(): null {
  useHotkey('mod+k', () => undefined, { label: 'Focus the search field' })
  return null
}

describe('HotkeysCard', () => {
  it('lists a registered binding with its label', () => {
    render(
      <HotkeyProvider platform="other">
        <Registers />
        <HotkeysCard />
      </HotkeyProvider>,
    )
    expect(screen.getByText('Focus the search field')).toBeTruthy()
    expect(screen.getByText('Ctrl+K')).toBeTruthy()
  })

  it('says so when nothing is registered', () => {
    render(
      <HotkeyProvider platform="other">
        <HotkeysCard />
      </HotkeyProvider>,
    )
    expect(screen.getByText('No shortcuts are active on this page.')).toBeTruthy()
  })

  it('spells a combo per platform', () => {
    expect(formatCombo('mod+shift+z', 'mac')).toBe('⇧⌘Z')
    expect(formatCombo('mod+shift+z', 'other')).toBe('Ctrl+Shift+Z')
  })
})
