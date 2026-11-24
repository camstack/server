/// <reference types="@testing-library/jest-dom" />

/**
 * Renaming a zone is a draft: typing and leaving the field write nothing, the
 * check button (or Enter) saves once, cancel (or Escape) drops it.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { SiteZonesPanel } from '../SiteZonesPanel'

expect.extend(jestDomMatchers)

vi.mock('../LocationIconPicker', () => ({ LocationIconPicker: () => null }))

function renderPanel(onRename: (from: string, to: string) => void) {
  render(
    <SiteZonesPanel
      zones={[{ zoneKey: 'night', label: 'Night zone', icon: null, locationKeys: ['bedroom'] }]}
      busy={false}
      onRename={onRename}
      onDelete={() => undefined}
      onPickIcon={() => undefined}
    />,
  )
}

function startRename(): HTMLInputElement {
  fireEvent.click(screen.getAllByTitle('Rename the zone')[0])
  return screen.getByRole('textbox', { name: 'Rename Night zone' })
}

describe('SiteZonesPanel rename', () => {
  it('writes nothing on typing or blur, and one rename on Save', () => {
    const onRename = vi.fn()
    renderPanel(onRename)
    const input = startRename()
    fireEvent.change(input, { target: { value: 'Sleeping area' } })
    fireEvent.blur(input)
    expect(onRename).not.toHaveBeenCalled()
    expect(input).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith('Night zone', 'Sleeping area')
  })

  it('Cancel drops the draft and writes nothing', () => {
    const onRename = vi.fn()
    renderPanel(onRename)
    const input = startRename()
    fireEvent.change(input, { target: { value: 'Sleeping area' } })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getAllByTitle('Rename the zone')[0]).toHaveTextContent('Night zone')
  })
})
