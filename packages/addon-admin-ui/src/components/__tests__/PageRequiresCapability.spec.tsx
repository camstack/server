/**
 * A page whose providing capability is ABSENT reads as not installed, with a
 * way to install it. Pending and unknown never do (D315): pending is progress,
 * unknown says the check failed.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

let mockPresence: 'pending' | 'present' | 'absent' | 'unknown' = 'present'
const asked: string[] = []

vi.mock('../../lib/capability-presence', () => ({
  useCapabilityPresence: (name: string) => {
    asked.push(name)
    return mockPresence
  },
}))

import { PageRequiresCapability, NavItemCapabilityGate } from '../PageRequiresCapability'
import { buildNavSections } from '../../lib/nav-items'

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function renderGate() {
  return render(
    <MemoryRouter initialEntries={['/system/pipeline']}>
      <Routes>
        <Route
          path="/system/pipeline"
          element={
            <PageRequiresCapability path="/system/pipeline">
              <div data-testid="page">the page</div>
            </PageRequiresCapability>
          }
        />
        <Route path="/system/addons" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('PageRequiresCapability', () => {
  beforeEach(() => {
    mockPresence = 'present'
    asked.length = 0
  })

  it('mounts the page only when the capability is present', () => {
    renderGate()
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(asked).toContain('pipeline-orchestrator')
  })

  it('does not mount the page and offers the install link when absent', () => {
    mockPresence = 'absent'
    renderGate()
    expect(screen.queryByTestId('page')).toBeNull()
    expect(screen.getByTestId('page-not-installed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /addons/i }))
    expect(screen.getByTestId('where').textContent).toBe('/system/addons')
  })

  it('shows progress, never "not installed", while the registry has not answered', () => {
    mockPresence = 'pending'
    renderGate()
    expect(screen.queryByTestId('page')).toBeNull()
    expect(screen.queryByTestId('page-not-installed')).toBeNull()
    expect(screen.getByTestId('page-presence-pending')).toBeTruthy()
  })

  it('says the check failed, not "not installed", when the read errored', () => {
    mockPresence = 'unknown'
    renderGate()
    expect(screen.queryByTestId('page-not-installed')).toBeNull()
    expect(screen.getByTestId('page-presence-unknown')).toBeTruthy()
  })
})

describe('NavItemCapabilityGate', () => {
  it('reports absent ONLY for an answered absence', () => {
    const seen: boolean[] = []
    for (const presence of ['pending', 'unknown', 'present', 'absent'] as const) {
      mockPresence = presence
      render(
        <NavItemCapabilityGate capability="pipeline-orchestrator">
          {(absent) => {
            seen.push(absent)
            return null
          }}
        </NavItemCapabilityGate>,
      )
    }
    expect(seen.slice(-4)).toEqual([false, false, false, true])
  })
})

describe('the nav declares the providing capability', () => {
  it('carries requiresCapability on the Pipeline entry', () => {
    const items = buildNavSections({
      t: (_k: string, d?: string) => d ?? _k,
      isAdmin: true,
    }).flatMap((s) => s.items)
    expect(items.find((i) => i.path === '/system/pipeline')?.requiresCapability).toBe(
      'pipeline-orchestrator',
    )
    expect(items.find((i) => i.path === '/devices')?.requiresCapability).toBeUndefined()
  })
})
