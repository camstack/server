/**
 * The Terminal a camera block shows (planning#580): a Terminal another block
 * already shows is offered disabled and named, none at all links to the
 * Terminal page, and a list that has not answered is never "none".
 */
import { selectOption } from '@dominevo/ui-library/testing'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const T1 = 'term-1'
const T2 = 'term-2'

const h = vi.hoisted(() => ({
  terminals: undefined as unknown,
  compositions: undefined as unknown,
}))

vi.mock('@dominevo/ui-library', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@dominevo/ui-library')
  return {
    ...actual,
    useInstancesOfCap: () => ({
      data: h.terminals,
      isError: false,
      isLoading: false,
    }),
    useCoreBlocksListCompositions: () => ({
      data: h.compositions,
      isError: false,
    }),
  }
})

import { TerminalCameraPicker } from '../TerminalCameraPicker'

function terminalBlock(id: string, name: string, terminalId: string): unknown {
  return {
    block: {
      id,
      name,
      code: '',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      createdBy: 'test',
      status: 'running',
      lastChangedAt: 1,
      source: {
        kind: 'composition',
        composition: {
          target: { kind: 'new', type: 'camera' },
          features: [],
          helper: { kind: 'terminal', terminalId },
        },
      },
    },
    state: { kind: 'answered', state: null },
  }
}

function renderPicker(onChange = vi.fn(), ownBlockId: string | null = null): typeof onChange {
  render(
    <MemoryRouter>
      <TerminalCameraPicker value={null} ownBlockId={ownBlockId} onChange={onChange} />
    </MemoryRouter>,
  )
  return onChange
}

describe('TerminalCameraPicker', () => {
  beforeEach(() => {
    h.terminals = [
      { id: T1, name: 'BTM Hub' },
      { id: T2, name: 'Top NUC' },
    ]
    h.compositions = {
      state: 'loaded',
      views: [terminalBlock('b1', 'Hub monitor', T1)],
    }
  })

  it('offers a free Terminal and names the block that already shows the other', () => {
    const onChange = renderPicker()
    const trigger = screen.getByTestId('terminal-camera-picker')
    fireEvent.click(trigger)
    const taken = screen.getByRole('option', { name: /BTM Hub/ })
    expect(taken.textContent).toMatch(/Hub monitor/)
    expect(taken.getAttribute('aria-disabled')).toBe('true')
    selectOption(trigger, T2)
    expect(onChange).toHaveBeenCalledWith(T2)
  })

  it('keeps the Terminal of the block being edited pickable', () => {
    renderPicker(vi.fn(), 'b1')
    fireEvent.click(screen.getByTestId('terminal-camera-picker'))
    expect(screen.getByRole('option', { name: /BTM Hub/ }).getAttribute('aria-disabled')).not.toBe(
      'true',
    )
  })

  it('with no Terminal at all, links to the Terminal page', () => {
    h.terminals = []
    renderPicker()
    expect(screen.queryByTestId('terminal-camera-picker')).toBeNull()
    expect(screen.getByRole('link', { name: /terminal/i }).getAttribute('href')).toBe(
      '/system/terminal',
    )
  })

  it('a list that has not answered shows no "none" and no picker', () => {
    h.terminals = undefined
    renderPicker()
    expect(screen.queryByTestId('terminal-camera-picker')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
