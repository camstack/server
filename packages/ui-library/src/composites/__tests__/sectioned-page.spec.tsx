// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Globe } from 'lucide-react'
import { SectionedPage } from '../sectioned-page'

describe('SectionedPage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/system/network')
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('renders the page title and section strip (OSD template)', () => {
    render(
      <SectionedPage
        icon={Globe}
        title="Network"
        defaultSection="addresses"
        sections={[
          { id: 'addresses', label: 'Addresses', content: <div>addresses body</div> },
          { id: 'diagnostics', label: 'Diagnostics', content: <div>diagnostics body</div> },
        ]}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Network' })).toBeTruthy()
    expect(screen.getByRole('tablist', { name: 'Network sections' })).toBeTruthy()
    expect(screen.getByText('addresses body')).toBeTruthy()
  })

  it('switches section via Tabs and writes ?tab=', () => {
    render(
      <SectionedPage
        title="Network"
        defaultSection="addresses"
        sections={[
          { id: 'addresses', label: 'Addresses', content: <div>addresses body</div> },
          { id: 'diagnostics', label: 'Diagnostics', content: <div>diagnostics body</div> },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics' }))
    expect(screen.getByText('diagnostics body')).toBeTruthy()
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('diagnostics')
  })

  it('drops ownedParams when leaving a section', () => {
    window.history.replaceState(null, '', '/system/network?tab=remote-access&integration=cf')
    render(
      <SectionedPage
        title="Network"
        defaultSection="addresses"
        sections={[
          {
            id: 'remote-access',
            label: 'Remote Access',
            content: <div>remote</div>,
            ownedParams: ['integration'],
          },
          { id: 'addresses', label: 'Addresses', content: <div>addresses</div> },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Addresses' }))
    const params = new URLSearchParams(window.location.search)
    expect(params.get('tab')).toBe('addresses')
    expect(params.get('integration')).toBeNull()
  })
})
