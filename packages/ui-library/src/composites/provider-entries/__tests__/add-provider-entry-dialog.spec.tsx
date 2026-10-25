// @vitest-environment jsdom
/**
 * AddProviderEntryDialog + ProviderEntryPills — types in the dialog, entries
 * on the strip. Pills never invent a row from a bare type.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AddProviderEntryDialog, type ProviderEntryTypeOption } from '../AddProviderEntryDialog'
import { ProviderEntryPills, type ProviderEntryPill } from '../ProviderEntryPills'

const TYPES: readonly ProviderEntryTypeOption[] = [
  { typeId: 'modal', label: 'Modal Labs', iconUrl: '/icons/modal.svg' },
  { typeId: 'fake', label: 'Fake provider', iconUrl: null },
]

const ENTRIES: readonly ProviderEntryPill[] = [
  {
    entryId: 'entry-a',
    name: 'Production',
    typeId: 'modal',
    iconUrl: '/icons/modal.svg',
    status: 'ok',
  },
  {
    entryId: 'entry-b',
    name: 'Sandbox',
    typeId: 'fake',
    iconUrl: null,
    status: 'warning',
  },
]

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('AddProviderEntryDialog', () => {
  it('lists provider types from the collection', () => {
    render(
      <AddProviderEntryDialog
        open
        types={TYPES}
        onOpenChange={() => undefined}
        onCreate={() => undefined}
      />,
    )

    const typeSelect = screen.getByLabelText('Provider type')
    expect(typeSelect).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Modal Labs' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Fake provider' })).toBeTruthy()
  })

  it('submit calls onCreate with typeId and name', () => {
    const onCreate = vi.fn()
    render(
      <AddProviderEntryDialog
        open
        types={TYPES}
        onOpenChange={() => undefined}
        onCreate={onCreate}
      />,
    )

    fireEvent.change(screen.getByLabelText('Provider type'), { target: { value: 'fake' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Night run ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith({ typeId: 'fake', name: 'Night run' })
  })

  it('does not submit an empty name', () => {
    const onCreate = vi.fn()
    render(
      <AddProviderEntryDialog
        open
        types={TYPES}
        onOpenChange={() => undefined}
        onCreate={onCreate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('ProviderEntryPills', () => {
  it('renders entry pills by entryId and name, not bare types', () => {
    render(
      <ProviderEntryPills
        label="Training providers"
        entries={ENTRIES}
        selectedEntryId="entry-a"
        onSelect={() => undefined}
        onAdd={() => undefined}
      />,
    )

    expect(screen.getByTestId('provider-entry-pill-entry-a')).toBeTruthy()
    expect(screen.getByTestId('provider-entry-pill-entry-b')).toBeTruthy()
    expect(screen.getByText('Production')).toBeTruthy()
    expect(screen.getByText('Sandbox')).toBeTruthy()
    // Types alone must not appear as pills — only entries do.
    expect(screen.queryByTestId('provider-entry-pill-modal')).toBeNull()
    expect(screen.queryByTestId('provider-entry-pill-fake')).toBeNull()
    expect(screen.queryByText('Modal Labs')).toBeNull()
  })

  it('selects an entry and opens Add', () => {
    const onSelect = vi.fn()
    const onAdd = vi.fn()
    render(
      <ProviderEntryPills
        label="Training providers"
        entries={ENTRIES}
        selectedEntryId="entry-a"
        onSelect={onSelect}
        onAdd={onAdd}
      />,
    )

    fireEvent.click(screen.getByTestId('provider-entry-pill-entry-b'))
    expect(onSelect).toHaveBeenCalledWith('entry-b')

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })
})
