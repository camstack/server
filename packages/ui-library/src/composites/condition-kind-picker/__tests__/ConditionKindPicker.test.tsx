// @vitest-environment jsdom
/**
 * <ConditionKindPicker>: the modal over `buildKindPicker`.
 *
 *  - typing "stable" then Enter picks the best ENABLED match (`device-is`);
 *  - in a guard an event row stays visible, disabled, with its reason, and a
 *    click on it picks nothing;
 *  - a search that matches nothing says so;
 *  - arrow keys walk the enabled rows and Enter picks the highlighted one;
 *  - a pick is remembered per `recentKey` and offered next time.
 */
import type { AutomationLeafKind } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConditionKindPicker, type ConditionKindPickerProps } from '../ConditionKindPicker'

beforeAll(() => {
  // jsdom has no <dialog> modal API.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

const textsOf: ConditionKindPickerProps['textsOf'] = (kind) => ({
  label: kind === 'device-is' ? 'Device value is' : `Label ${kind}`,
  description: kind === 'device-is' ? 'A value is held stable for a while' : `About ${kind}`,
  example: `example ${kind}`,
})

function setup(over: Partial<ConditionKindPickerProps> = {}) {
  const onPick = vi.fn<(kind: AutomationLeafKind) => void>()
  const onOpenChange = vi.fn()
  render(
    <ConditionKindPicker
      open
      onOpenChange={onOpenChange}
      title="Add a condition"
      context="trigger"
      underNot={false}
      treeFull={false}
      textsOf={textsOf}
      categoryLabelOf={(c) => `Cat ${c}`}
      reasonOf={(r) => `Reason ${r}`}
      onPick={onPick}
      {...over}
    />,
  )
  return { onPick, onOpenChange }
}

const search = () => screen.getByRole('searchbox')

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('ConditionKindPicker', () => {
  it('focuses the search on open and picks the best enabled match with Enter', () => {
    const { onPick } = setup()
    expect(document.activeElement).toBe(search())
    fireEvent.change(search(), { target: { value: 'stable' } })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledExactlyOnceWith('device-is')
  })

  it('shows group headers with their count', () => {
    setup()
    expect(screen.getByText('Cat cameras')).toBeTruthy()
    expect(screen.getByTestId('kind-group-cameras').textContent).toContain('3')
  })

  it('keeps an event row visible but disabled in a guard, with its reason, and ignores a click', () => {
    const { onPick } = setup({ context: 'guard' })
    const row = screen.getByRole('option', { name: /Label detection/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('Reason event-in-guard')
    fireEvent.click(row)
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: /Device value is/ }))
    expect(onPick).toHaveBeenCalledExactlyOnceWith('device-is')
  })

  it('says so when nothing matches, and Enter picks nothing', () => {
    const { onPick } = setup()
    fireEvent.change(search(), { target: { value: 'zzzzqq' } })
    expect(screen.getByText('Nothing matches “zzzzqq”')).toBeTruthy()
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('walks enabled rows with the arrow keys and picks the highlighted one', () => {
    const { onPick } = setup({ context: 'guard' })
    // Guard: events are disabled, so the first enabled row is a state.
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    const first = onPick.mock.calls[0]?.[0]
    expect(first).toBeDefined()
    expect(['device-is', 'time-is', 'stationary-present', 'expression']).toContain(first)
  })

  it('highlights the kind of the row being changed, not the first row', () => {
    setup({ current: 'device-is' })
    const selected = screen.getAllByRole('option').filter((o) => o.ariaSelected === 'true')
    expect(selected.map((o) => o.textContent)).toEqual([expect.stringContaining('Device value is')])
  })

  it('picks the first row with Enter on an empty search when adding, though nothing is highlighted', () => {
    const { onPick } = setup()
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledExactlyOnceWith('detection')
  })

  it('picks the row being changed with Enter on an empty search', () => {
    const { onPick } = setup({ current: 'device-is' })
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledExactlyOnceWith('device-is')
  })

  it('highlights nothing when adding a row, until the operator types', () => {
    setup()
    const selected = () => screen.getAllByRole('option').filter((o) => o.ariaSelected === 'true')
    expect(selected()).toHaveLength(0)
    fireEvent.change(search(), { target: { value: 'stable' } })
    expect(selected().map((o) => o.textContent)).toEqual([
      expect.stringContaining('Device value is'),
    ])
  })

  it('offers suggested and recently used kinds only while the search is empty', () => {
    setup({ suggested: ['detection'] })
    expect(screen.getByTestId('kind-section-suggested')).toBeTruthy()
    fireEvent.change(search(), { target: { value: 'camera' } })
    expect(screen.queryByTestId('kind-section-suggested')).toBeNull()
  })

  it('remembers a pick per recentKey', () => {
    setup({ recentKey: 'when' })
    fireEvent.click(screen.getByRole('option', { name: /Device value is/ }))
    cleanup()
    setup({ recentKey: 'when' })
    expect(screen.getByTestId('kind-section-recent').textContent).toContain('Device value is')
  })

  it('works when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { onPick } = setup({ recentKey: 'when' })
    fireEvent.click(screen.getByRole('option', { name: /Device value is/ }))
    expect(onPick).toHaveBeenCalledWith('device-is')
    spy.mockRestore()
  })

  it('disables every row when the tree is full', () => {
    const { onPick } = setup({ treeFull: true })
    fireEvent.click(screen.getByRole('option', { name: /Device value is/ }))
    expect(onPick).not.toHaveBeenCalled()
  })
})
