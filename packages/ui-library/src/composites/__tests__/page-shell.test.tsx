// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Activity } from 'lucide-react'
import { PageShell } from '../page-shell'

describe('PageShell', () => {
  it('renders title, icon, actions and nav', () => {
    render(
      <PageShell
        icon={Activity}
        title="Cluster"
        subtitle="nodes"
        actions={<button type="button">Refresh</button>}
        nav={<nav aria-label="Sections">pills</nav>}
      >
        <p>body</p>
      </PageShell>,
    )
    expect(screen.getByRole('heading', { name: 'Cluster' })).toBeTruthy()
    expect(screen.getByText('nodes')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('skips the header when only children are set', () => {
    const { container } = render(
      <PageShell>
        <p>only-body</p>
      </PageShell>,
    )
    expect(container.querySelector('h1')).toBeNull()
    expect(screen.getByText('only-body')).toBeTruthy()
  })
})
