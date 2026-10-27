/// <reference types="@testing-library/jest-dom" />
/**
 * The integration logo on a device page is a LINK to that integration.
 * The operator's ask (2026-09-05): "when I click the integration logo on
 * device detail, go to that integration". Before, it was decoration next to
 * a breadcrumb that did the same job three clicks away.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { IntegrationLogoLink } from '../IntegrationLogoLink'

expect.extend(jestDomMatchers)

function renderAt(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={['/devices/101']}>
      <Routes>
        <Route path="/devices/101" element={ui} />
        <Route path="/integrations/:addonId" element={<LandedOn />} />
        <Route path="/integrations" element={<div>Landed on the list</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function LandedOn() {
  const [params] = useSearchParams()
  return <div>{`Landed on integration ${params.get('instance') ?? ''}`}</div>
}

describe('IntegrationLogoLink', () => {
  it('navigates to the integration that owns the device', () => {
    renderAt(<IntegrationLogoLink provider="hikvision" integrationId="int-7" name="Casa" />)
    fireEvent.click(screen.getByRole('button', { name: /Casa/ }))
    expect(screen.getByText('Landed on integration int-7')).toBeInTheDocument()
  })

  it('falls back to the integrations list while the integration is not yet known', () => {
    renderAt(<IntegrationLogoLink provider="hikvision" integrationId={null} name={null} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Landed on the list')).toBeInTheDocument()
  })
})
