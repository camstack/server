/// <reference types="@testing-library/jest-dom" />
// @vitest-environment jsdom

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

vi.mock('@camstack/ui-library', async () => {
  // Deep source imports use `.js` (TS ESM) — `.tsx` trips TS5097 under tsconfig.spec.
  const dialog = await import('../../../../../../ui-library/src/primitives/dialog.js')
  const { IconButton } = await import('../../../../../../ui-library/src/primitives/icon-button.js')
  return {
    ...dialog,
    IconButton,
    WidgetSlot: () => <div data-testid="stream-broker-widget" />,
    Select: () => null,
  }
})

import { BrokerDrillDown } from '../ClusterRowCells'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('BrokerDrillDown', () => {
  it('shows the library Close control while the dialog is open', () => {
    render(<BrokerDrillDown deviceId={101} deviceName="Front door" />)
    fireEvent.click(screen.getByRole('button', { name: 'Stream brokers of Front door' }))
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })
})
