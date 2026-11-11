/**
 * "Started by" reads which trigger row started the run. A standalone action
 * list or a scheduler has no trigger rows, so the picker does not offer it
 * there; inside an automation it does.
 */
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { LeafKindPickerModal } from '../LeafKindPickerModal'
import { leafKindLabel } from '../recipe-parts'
import { TriggerRowsProvider } from '../trigger-rows-context'

// jsdom has no <dialog> modal API.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

function Modal() {
  return (
    <LeafKindPickerModal
      open
      onOpenChange={() => undefined}
      mode="add"
      context="guard"
      underNot={false}
      treeFull={false}
      onPick={() => undefined}
    />
  )
}

describe('LeafKindPickerModal', () => {
  it('outside an automation: "started by" is not offered, the other conditions are', () => {
    render(<Modal />)
    expect(screen.queryByText(leafKindLabel('triggered-by'))).toBeNull()
    expect(screen.getAllByText(leafKindLabel('device-is')).length).toBeGreaterThan(0)
  })

  it('inside an automation: "started by" is offered', () => {
    render(
      <TriggerRowsProvider when={{ kind: 'manual' }}>
        <Modal />
      </TriggerRowsProvider>,
    )
    expect(screen.getAllByText(leafKindLabel('triggered-by')).length).toBeGreaterThan(0)
  })
})
