// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Trash2 } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SWIPE_CELL_CLASS,
  type SwipeAction,
  SwipeActionsTray,
  useSwipeActions,
} from '../swipe-actions'

const TRAY_WIDTH = 128
const HINT_KEY = 'camstack.swipe-actions.hint-seen'

interface RowProps {
  readonly actions?: readonly SwipeAction[]
  readonly onRowClick?: () => void
  readonly hint?: boolean
  readonly lead?: ReactNode
  readonly rest?: ReactNode
}

function Row({ actions = [], onRowClick, hint, lead, rest }: RowProps): JSX.Element {
  const swipe = useSwipeActions({ hint })
  return (
    <table>
      <tbody>
        <tr data-testid="row" onClick={onRowClick} {...swipe.rowProps}>
          <td className={SWIPE_CELL_CLASS}>Kitchen window</td>
          <td className={SWIPE_CELL_CLASS}>
            <SwipeActionsTray swipe={swipe} actions={actions} label="Row actions" lead={lead}>
              {rest}
            </SwipeActionsTray>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

function action(onClick: () => void = () => {}): SwipeAction {
  return { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onClick }
}

function row(): HTMLElement {
  return screen.getByTestId('row')
}

function offsetOf(el: HTMLElement): string {
  return el.style.getPropertyValue('--swipe-x')
}

/** jsdom lays nothing out: give the tray a width, as a displayed tray has. */
function setTrayWidth(width: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-swipe-tray') ? width : 0
    },
  })
}

function drag(el: HTMLElement, dx: number, dy = 0): void {
  fireEvent.pointerDown(el, { clientX: 300, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 300 + dx, clientY: 100 + dy, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 300 + dx, clientY: 100 + dy, pointerId: 1 })
}

beforeEach(() => {
  setTrayWidth(TRAY_WIDTH)
  HTMLElement.prototype.setPointerCapture = () => {}
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('swipe actions — the gesture', () => {
  it('opens the tray when the row is swiped left past the threshold', () => {
    render(<Row actions={[action()]} />)
    drag(row(), -80)
    expect(row().hasAttribute('data-swipe-open')).toBe(true)
    expect(offsetOf(row())).toBe(`-${TRAY_WIDTH}px`)
  })

  it('settles closed after a swipe that uncovers too little', () => {
    render(<Row actions={[action()]} />)
    drag(row(), -20)
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
    expect(offsetOf(row())).toBe('0px')
  })

  it('leaves a mostly vertical move to the page scroll', () => {
    render(<Row actions={[action()]} />)
    drag(row(), -40, 120)
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
  })

  it('does not also activate the row with the click that ends a swipe', () => {
    const onRowClick = vi.fn()
    render(<Row actions={[action()]} onRowClick={onRowClick} />)
    drag(row(), -80)
    fireEvent.click(row())
    expect(onRowClick).not.toHaveBeenCalled()
    // Only that one click: the next tap is the operator's.
    fireEvent.click(row())
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('is off where the tray is not displayed (a wide layout)', () => {
    setTrayWidth(0)
    const onRowClick = vi.fn()
    render(<Row actions={[action()]} onRowClick={onRowClick} />)
    drag(row(), -80)
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
    fireEvent.click(row())
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('closes when the operator touches anything outside the row', () => {
    render(<Row actions={[action()]} />)
    drag(row(), -80)
    fireEvent.pointerDown(document.body)
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
  })
})

describe('swipe actions — without the gesture', () => {
  it('opens when a tray button takes focus, so the keyboard reaches every action', () => {
    render(<Row actions={[action()]} />)
    fireEvent.focus(screen.getByRole('button', { name: 'Delete' }))
    expect(row().hasAttribute('data-swipe-open')).toBe(true)
  })

  it('closes on Escape', () => {
    render(<Row actions={[action()]} />)
    fireEvent.focus(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.keyDown(row(), { key: 'Escape' })
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
  })

  it('runs the action, closes, and does not activate the row', () => {
    const onClick = vi.fn()
    const onRowClick = vi.fn()
    render(<Row actions={[action(onClick)]} onRowClick={onRowClick} />)
    fireEvent.focus(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).not.toHaveBeenCalled()
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
  })

  it('names the group of actions for assistive technology', () => {
    render(<Row actions={[action()]} />)
    expect(screen.getByRole('group', { name: 'Row actions' })).not.toBeNull()
  })
})

describe('swipe actions — the tray slots', () => {
  it('puts the lead slot before the actions and the rest after them', () => {
    render(
      <Row
        actions={[action()]}
        lead={<button type="button">Run 30 min</button>}
        rest={<button type="button">Reboot</button>}
      />,
    )
    const names = screen.getAllByRole('button').map((button) => button.textContent)
    expect(names).toEqual(['Run 30 min', 'Delete', 'Reboot'])
  })

  it('renders no tray at all with no action and no slot', () => {
    const { container } = render(<Row />)
    expect(container.querySelector('[data-swipe-tray]')).toBeNull()
  })
})

describe('swipe actions — the one-time hint', () => {
  it('peeks the row open and settles, then never again in this browser', () => {
    vi.useFakeTimers()
    const first = render(<Row actions={[action()]} hint />)
    act(() => vi.advanceTimersByTime(700))
    expect(offsetOf(row())).toBe('-24px')
    expect(row().hasAttribute('data-swipe-open')).toBe(false)
    act(() => vi.advanceTimersByTime(800))
    expect(offsetOf(row())).toBe('0px')
    expect(window.localStorage.getItem(HINT_KEY)).not.toBeNull()
    first.unmount()

    render(<Row actions={[action()]} hint />)
    act(() => vi.advanceTimersByTime(700))
    expect(offsetOf(row())).toBe('0px')
  })

  it('plays on ONE row when every row of a list asks for it', () => {
    vi.useFakeTimers()
    render(
      <>
        <Row actions={[action()]} hint />
        <Row actions={[action()]} hint />
      </>,
    )
    act(() => vi.advanceTimersByTime(700))
    const offsets = screen.getAllByTestId('row').map(offsetOf)
    expect(offsets).toEqual(['-24px', '0px'])
  })

  it('does not play where the tray is not displayed', () => {
    setTrayWidth(0)
    vi.useFakeTimers()
    render(<Row actions={[action()]} hint />)
    act(() => vi.advanceTimersByTime(700))
    expect(offsetOf(row())).toBe('0px')
    expect(window.localStorage.getItem(HINT_KEY)).toBeNull()
  })

  it('does not play, and does not throw, when storage is blocked', () => {
    vi.useFakeTimers()
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<Row actions={[action()]} hint />)
    act(() => vi.advanceTimersByTime(700))
    expect(offsetOf(row())).toBe('0px')
    blocked.mockRestore()
  })
})
