import {
  BUILTIN_REMOTE_COMPONENTS,
  type RemoteLayoutComponent,
  type RemoteLayoutPayload,
} from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { RemoteLayoutEditor } from '../RemoteLayoutEditor'

let served: readonly RemoteLayoutComponent[] | undefined = BUILTIN_REMOTE_COMPONENTS

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useRemoteLayoutComponentsListComponents: () => ({
      data: served,
      isError: false,
      refetch: vi.fn(),
    }),
  }
})

const START: RemoteLayoutPayload = {
  columns: 6,
  rows: 6,
  buttons: [{ id: 'b1', row: 0, col: 5, rowSpan: 1, colSpan: 1, role: 'power' }],
}

function Harness({
  start = START,
  onGrid,
}: {
  readonly start?: RemoteLayoutPayload
  readonly onGrid: (g: RemoteLayoutPayload) => void
}) {
  const [grid, setGrid] = useState(start)
  return (
    <RemoteLayoutEditor
      value={grid}
      onChange={(next) => {
        setGrid(next)
        onGrid(next)
      }}
    />
  )
}

afterEach(() => {
  served = BUILTIN_REMOTE_COMPONENTS
  vi.restoreAllMocks()
})

describe('Add component', () => {
  it('lists the served components and puts the picked one on the first free spot', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    expect(screen.getByTestId('palette-list').querySelectorAll('li').length).toBe(
      BUILTIN_REMOTE_COMPONENTS.length,
    )
    fireEvent.click(screen.getByTestId('palette-item-core:dpad'))
    expect(latest.groups).toHaveLength(1)
    expect(latest.groups?.[0]).toMatchObject({ id: 'dpad', row: 0, col: 0, frame: 'dpad' })
    expect(latest.buttons.filter((b) => b.groupId === 'dpad')).toHaveLength(5)
    // The new group is selected, so its inspector shows.
    expect(screen.getByTestId('remote-group-inspector')).toBeTruthy()
  })

  it('stays open after a pick, says what was added, and takes a second component', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    fireEvent.click(screen.getByTestId('palette-item-core:dpad'))
    expect(screen.getByTestId('palette-list')).toBeTruthy()
    expect(screen.getByTestId('palette-added').textContent).toContain('D-pad')
    fireEvent.click(screen.getByTestId('palette-item-core:keypad'))
    expect(latest.groups?.map((g) => g.id)).toEqual(['dpad', 'keypad'])
  })

  it('narrows the list with the search box', () => {
    render(<Harness onGrid={() => undefined} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'keypad' } })
    expect(screen.getByTestId('palette-list').querySelectorAll('li').length).toBe(1)
    fireEvent.change(screen.getByTestId('palette-search'), { target: { value: 'zzzz' } })
    expect(screen.queryByTestId('palette-list')).toBeNull()
  })

  it('says why a component does not fit and leaves the layout alone', () => {
    const tiny: RemoteLayoutPayload = { columns: 2, rows: 2, buttons: [] }
    let latest = tiny
    render(<Harness start={tiny} onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    fireEvent.click(screen.getByTestId('palette-item-core:keypad'))
    expect(screen.getByTestId('remote-layout-refusal').textContent).toMatch(/leave the grid/i)
    expect(latest.buttons).toHaveLength(0)
  })

  it('shows a loading state, not an empty palette, until the list answers', () => {
    served = undefined
    render(<Harness onGrid={() => undefined} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    expect(screen.getByTestId('palette-loading')).toBeTruthy()
    expect(screen.queryByTestId('palette-list')).toBeNull()
  })
})

describe('moving on the grid', () => {
  function stubBounds(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 600,
      bottom: 600,
      width: 600,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }

  it('shows every cell and the landing footprint while a button is dragged, then moves it', () => {
    stubBounds()
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    const button = screen.getByTestId('remote-grid-button-b1')
    // 6 × 6 grid of 100px cells; the key sits at (0, 5), grabbed in its cell.
    fireEvent.pointerDown(button, { button: 0, clientX: 550, clientY: 50 })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 350 })
    expect(screen.getAllByTestId('remote-grid-cell')).toHaveLength(36)
    expect(screen.getByTestId('remote-drop-target').getAttribute('data-valid')).toBe('true')
    fireEvent.pointerUp(window)
    expect(latest.buttons[0]).toMatchObject({ row: 3, col: 2 })
    expect(screen.queryByTestId('remote-drop-target')).toBeNull()
  })

  it('marks a landing on another key invalid and leaves the layout as it was', () => {
    stubBounds()
    const start: RemoteLayoutPayload = {
      ...START,
      buttons: [
        ...START.buttons,
        { id: 'b2', row: 3, col: 2, rowSpan: 1, colSpan: 1, role: 'mute' },
      ],
    }
    let latest = start
    render(<Harness start={start} onGrid={(g) => (latest = g)} />)
    fireEvent.pointerDown(screen.getByTestId('remote-grid-button-b1'), {
      button: 0,
      clientX: 550,
      clientY: 50,
    })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 350 })
    expect(screen.getByTestId('remote-drop-target').getAttribute('data-valid')).toBe('false')
    fireEvent.pointerUp(window)
    expect(latest).toBe(start)
    expect(screen.getByTestId('remote-layout-refusal').textContent).toMatch(/overlap/i)
  })

  it('a press that never moves is a click: it selects and moves nothing', () => {
    stubBounds()
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    const button = screen.getByTestId('remote-grid-button-b1')
    fireEvent.pointerDown(button, { button: 0, clientX: 550, clientY: 50 })
    fireEvent.pointerUp(window)
    fireEvent.click(button)
    expect(latest).toBe(START)
    expect(screen.getByTestId('remote-inspector')).toBeTruthy()
  })

  it('Escape cancels a drag', () => {
    stubBounds()
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.pointerDown(screen.getByTestId('remote-grid-button-b1'), {
      button: 0,
      clientX: 550,
      clientY: 50,
    })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 350 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('remote-drop-target')).toBeNull()
    expect(latest).toBe(START)
  })

  it('moves a key with the arrow keys, and refuses at the edge', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    const button = screen.getByTestId('remote-grid-button-b1')
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    expect(latest.buttons[0]).toMatchObject({ row: 1, col: 5 })
    fireEvent.keyDown(screen.getByTestId('remote-grid-button-b1'), { key: 'ArrowRight' })
    expect(screen.getByTestId('remote-layout-refusal').textContent).toMatch(/outside|grid/i)
  })

  it('moves a whole group by its handle', () => {
    stubBounds()
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    fireEvent.click(screen.getByTestId('palette-item-core:dpad'))
    expect(latest.groups?.[0]).toMatchObject({ row: 0, col: 0 })
    const handle = screen.getByTestId('remote-group-handle-dpad')
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(latest.groups?.[0]).toMatchObject({ row: 1, col: 0 })
    expect(latest.buttons.filter((b) => b.groupId === 'dpad').map((b) => b.row)).toEqual([
      1, 2, 2, 2, 3,
    ])
  })

  it('ungroups keeping the keys, and deletes a group with its keys', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-add-component'))
    fireEvent.click(screen.getByTestId('palette-item-core:dpad'))
    fireEvent.click(screen.getByTestId('remote-group-ungroup'))
    expect(latest.groups).toBeUndefined()
    expect(latest.buttons).toHaveLength(6)

    fireEvent.click(screen.getByTestId('remote-add-component'))
    fireEvent.click(screen.getByTestId('palette-item-core:dpad'))
    fireEvent.click(screen.getByTestId('remote-group-delete'))
    expect(latest.groups).toBeUndefined()
    expect(latest.buttons).toHaveLength(6)
  })
})

describe('what a key shows', () => {
  it('an icon key and a colour key carry no visible text, but keep their name', () => {
    const layout: RemoteLayoutPayload = {
      columns: 3,
      rows: 1,
      buttons: [
        { id: 'v', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'volume_up', icon: 'power' },
        {
          id: 'r',
          row: 0,
          col: 1,
          rowSpan: 1,
          colSpan: 1,
          role: 'custom:color_red',
          label: 'Red',
          tone: 'red',
        },
        { id: 'o', row: 0, col: 2, rowSpan: 1, colSpan: 1, role: 'ok' },
      ],
    }
    render(<Harness start={layout} onGrid={() => undefined} />)
    const icon = screen.getByTestId('remote-grid-button-v')
    expect(icon.getAttribute('aria-label')).toBe('Volume up')
    expect(icon.textContent).toBe('')
    const colour = screen.getByTestId('remote-grid-button-r')
    expect(colour.getAttribute('aria-label')).toBe('Red')
    expect(colour.textContent).toBe('')
    // No icon, no colour: the text stays.
    expect(screen.getByTestId('remote-grid-button-o').textContent).not.toBe('')
  })
})
