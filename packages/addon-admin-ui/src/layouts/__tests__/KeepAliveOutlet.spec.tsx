/**
 * KeepAliveOutlet — visited `/addon/*` panes stay mounted (hidden) so local
 * draft state survives leaving and returning. Non-addon routes still unmount.
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { Link, MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { KeepAliveOutlet, shouldKeepAlivePath, useKeepAliveActive } from '../KeepAliveOutlet'

function DraftPage() {
  const { pagePath } = useParams<{ pagePath: string }>()
  const [draft, setDraft] = useState('')
  const active = useKeepAliveActive()
  return (
    <div data-testid={`pane-${pagePath}`}>
      <span data-testid="page-path">{pagePath}</span>
      <span data-testid="active">{active ? 'yes' : 'no'}</span>
      <input
        data-testid="draft"
        aria-label={`draft-${pagePath}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  )
}

function DevicesPage() {
  const [n, setN] = useState(0)
  return (
    <div>
      <span data-testid="devices-count">{n}</span>
      <button type="button" onClick={() => setN((c) => c + 1)}>
        bump
      </button>
    </div>
  )
}

function Shell() {
  return (
    <div>
      <nav>
        <Link to="/addon/a">a</Link>
        <Link to="/addon/b">b</Link>
        <Link to="/addon/c">c</Link>
        <Link to="/devices">devices</Link>
      </nav>
      <KeepAliveOutlet maxCached={2} />
    </div>
  )
}

function renderApp(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/addon/:pagePath" element={<DraftPage />} />
          <Route path="/devices" element={<DevicesPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('shouldKeepAlivePath', () => {
  it('keeps only /addon paths', () => {
    expect(shouldKeepAlivePath('/addon/osd-manager')).toBe(true)
    expect(shouldKeepAlivePath('/addon')).toBe(true)
    expect(shouldKeepAlivePath('/devices')).toBe(false)
    expect(shouldKeepAlivePath('/system/pipeline')).toBe(false)
  })
})

describe('KeepAliveOutlet', () => {
  it('preserves addon draft state when leaving and returning', () => {
    renderApp('/addon/a')
    fireEvent.change(screen.getByLabelText('draft-a'), { target: { value: 'my-template' } })
    expect(screen.getByLabelText('draft-a')).toHaveValue('my-template')

    fireEvent.click(screen.getByRole('link', { name: 'devices' }))
    expect(screen.getByTestId('devices-count')).toBeInTheDocument()
    expect(screen.getByLabelText('draft-a')).toHaveValue('my-template')
    expect(within(screen.getByTestId('pane-a')).getByTestId('active')).toHaveTextContent('no')

    fireEvent.click(screen.getByRole('link', { name: 'a' }))
    expect(screen.getByLabelText('draft-a')).toHaveValue('my-template')
    expect(within(screen.getByTestId('pane-a')).getByTestId('active')).toHaveTextContent('yes')
    expect(within(screen.getByTestId('pane-a')).getByTestId('page-path')).toHaveTextContent('a')
  })

  it('does not keep non-addon route state across visits', () => {
    renderApp('/devices')
    fireEvent.click(screen.getByRole('button', { name: 'bump' }))
    expect(screen.getByTestId('devices-count')).toHaveTextContent('1')

    fireEvent.click(screen.getByRole('link', { name: 'a' }))
    fireEvent.click(screen.getByRole('link', { name: 'devices' }))
    expect(screen.getByTestId('devices-count')).toHaveTextContent('0')
  })

  it('evicts the oldest addon pane when over the LRU max', () => {
    renderApp('/addon/a')
    fireEvent.change(screen.getByLabelText('draft-a'), { target: { value: 'keep-a' } })

    fireEvent.click(screen.getByRole('link', { name: 'b' }))
    fireEvent.change(screen.getByLabelText('draft-b'), { target: { value: 'keep-b' } })

    // maxCached=2; visiting c evicts a
    fireEvent.click(screen.getByRole('link', { name: 'c' }))
    expect(screen.queryByTestId('pane-a')).not.toBeInTheDocument()
    expect(screen.getByLabelText('draft-b')).toHaveValue('keep-b')
    expect(screen.getByLabelText('draft-c')).toBeInTheDocument()

    // Returning to a remounts fresh (draft lost)
    fireEvent.click(screen.getByRole('link', { name: 'a' }))
    expect(screen.getByLabelText('draft-a')).toHaveValue('')
  })
})
