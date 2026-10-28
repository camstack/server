import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

vi.mock('../use-live-value', () => ({
  useLiveValue: () => ({ kind: 'value', value: 87 }),
}))
const { AssignmentRow } = await import('../AssignmentRow')
const { AssignmentSection, AvailabilityNotice } = await import('../AssignmentSection')

describe('AssignmentRow', () => {
  it('shows name, detail, meta and the live value; ✕ removes', () => {
    const onRemove = vi.fn()
    render(
      <AssignmentRow
        name="Batteria nativa"
        detail="Reolink"
        meta="Native"
        value={{ deviceId: 103, cap: 'battery', path: 'level' }}
        onRemove={onRemove}
        removeLabel="Remove Batteria nativa"
      />,
    )
    expect(screen.getByText('87 %')).toBeTruthy()
    expect(screen.getByText('Reolink')).toBeTruthy()
    expect(screen.getByText('Native')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Batteria nativa' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
  it('a row without onRemove has no ✕ (the camera itself, a native battery, an implied device)', () => {
    render(
      <AssignmentRow
        name="Camera motion"
        detail={null}
        meta="always included"
        value={null}
        removeLabel="Remove"
      />,
    )
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })
  it('a problem is a warning on the row, not a hidden row', () => {
    render(
      <AssignmentRow
        name="ha:gone"
        detail={null}
        meta={null}
        value={null}
        problem="device not found — kept until you remove it"
        removeLabel="Remove"
        onRemove={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/kept until you remove it/)
  })
  it('a busy row keeps its ✕ but disables it (review M2)', () => {
    render(
      <AssignmentRow
        name="PIR"
        detail={null}
        meta={null}
        value={null}
        removeLabel="Remove PIR"
        onRemove={vi.fn()}
        busy
      />,
    )
    expect(screen.getByRole('button', { name: 'Remove PIR' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('AssignmentSection / AvailabilityNotice', () => {
  it('"+ Add" only when the card can add', () => {
    const { rerender } = render(
      <AssignmentSection id="t" title="Doorbell" addLabel="+ Add source" onAdd={vi.fn()}>
        rows
      </AssignmentSection>,
    )
    expect(screen.getByRole('button', { name: '+ Add source' })).toBeTruthy()
    rerender(
      <AssignmentSection id="t" title="Doorbell" addLabel="+ Add source">
        rows
      </AssignmentSection>,
    )
    expect(screen.queryByRole('button', { name: '+ Add source' })).toBeNull()
  })
  it('pending is "Checking…", unknown carries its reason (D315)', () => {
    const { rerender } = render(<AvailabilityNotice availability={{ kind: 'pending' }} />)
    expect(screen.getByRole('status').textContent).toMatch(/Checking/)
    rerender(<AvailabilityNotice availability={{ kind: 'unknown', reason: 'older server' }} />)
    expect(screen.getByRole('alert').textContent).toMatch(/older server/)
  })
  it('the section is a region named by its title (review L1)', () => {
    render(
      <AssignmentSection id="t" title="Doorbell">
        rows
      </AssignmentSection>,
    )
    expect(screen.getByRole('region', { name: 'Doorbell' })).toBeTruthy()
  })
  it('present and absent say nothing — the card itself is the answer (review L5)', () => {
    const { container, rerender } = render(
      <AvailabilityNotice availability={{ kind: 'present', mode: 'add' }} />,
    )
    expect(container.textContent).toBe('')
    rerender(<AvailabilityNotice availability={{ kind: 'absent' }} />)
    expect(container.textContent).toBe('')
  })
})
