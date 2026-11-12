/**
 * Selecting a remote button never pops the command modal on its own:
 *  - an unfinished binding shows an empty "Choose" row, and the modal opens only on click;
 *  - a stored call the vocabulary cannot name is read-only, with Change; Change opens the modal.
 */
import type { RemoteBinding } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import type { AutomationDevice } from '../../../pages/build/automation/automation-data'

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  ItemFormDialog: (props: { readonly children: ReactNode }) => (
    <div data-testid="command-picker-dialog">{props.children}</div>
  ),
}))

vi.mock('../../device/customize/source-selector/SourceSelectorAction', () => ({
  SourceSelectorAction: () => <div />,
}))

import { BindingPanel } from '../BindingPanel'
import { BLANK_ACTION } from '../remote-config-model'

const TV = 901
const DEVICES: readonly AutomationDevice[] = [
  { id: TV, name: 'Television', stableId: 'tv', type: 'switch' },
]

function mount(binding: RemoteBinding | undefined) {
  render(
    <BindingPanel
      role={{ role: 'power', name: null, custom: false, inLayout: true }}
      name="Power"
      binding={binding}
      devices={DEVICES}
      transmitters={[]}
      testable={false}
      testResult={null}
      onBind={vi.fn()}
      onClear={vi.fn()}
      onTest={vi.fn()}
    />,
  )
}

const dialog = () => screen.queryByTestId('command-picker-dialog')

describe('BindingPanel — the command modal opens only on a click', () => {
  it('an unfinished binding shows an empty Choose row, and opens the modal only on click', () => {
    mount({ action: BLANK_ACTION })
    expect(screen.getByTestId('command-step')).toBeTruthy()
    expect(dialog()).toBeNull()
    fireEvent.click(screen.getByTestId('command-step-change'))
    expect(dialog()).not.toBeNull()
  })

  it('a stored call the vocabulary cannot name stays read-only with Change, which opens the modal', () => {
    mount({
      action: { kind: 'cap', deviceId: TV, cap: 'switch', method: 'frobnicate', args: { x: 1 } },
    })
    expect(screen.queryByTestId('command-step')).toBeNull()
    expect(dialog()).toBeNull()
    expect(screen.getByTestId('code-power').textContent).toContain('frobnicate')
    fireEvent.click(screen.getByTestId('edit-power'))
    expect(dialog()).not.toBeNull()
  })

  it('a known command reads as its call, and Change shows the sentence without popping the modal', () => {
    mount({
      action: { kind: 'cap', deviceId: TV, cap: 'switch', method: 'setState', args: { on: true } },
    })
    expect(screen.queryByTestId('command-step')).toBeNull()
    fireEvent.click(screen.getByTestId('edit-power'))
    expect(screen.getByTestId('command-step')).toBeTruthy()
    expect(dialog()).toBeNull()
  })
})
