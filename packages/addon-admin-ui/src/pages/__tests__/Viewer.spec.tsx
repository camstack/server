import { resetHubMountForTests } from '@camstack/ui-library'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ViewerPage } from '../Viewer'

/**
 * The Viewer page is the admin UI's frame around the hub-served viewer.
 * Same origin, so the hub's session cookie reaches the frame and the
 * viewer's own `auth.exchangeSession` bootstrap signs it in — nothing is
 * injected, nothing is invented (D425).
 */

beforeEach(() => {
  resetHubMountForTests()
  document.head.innerHTML = ''
})

afterEach(() => {
  resetHubMountForTests()
  document.head.innerHTML = ''
})

function renderPage() {
  return render(
    <MemoryRouter>
      <ViewerPage />
    </MemoryRouter>,
  )
}

describe('ViewerPage', () => {
  it('frames the viewer at the root mount, with the permissions a live view needs', () => {
    renderPage()
    const frame = screen.getByTitle('CamStack viewer')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/viewer/camstack/')
    const allow = frame.getAttribute('allow') ?? ''
    // Intercom, PiP and fullscreen are features the viewer uses; a frame
    // that omits them silently disables the buttons inside it.
    for (const feature of ['microphone', 'fullscreen', 'picture-in-picture', 'autoplay']) {
      expect(allow).toContain(feature)
    }
  })

  it('under the Home Assistant relay: no frame, and the reason is on the page', () => {
    document.head.innerHTML =
      '<base href="/api/camstack/p/g1/"><meta name="camstack-mount" content="/api/camstack/p/g1/">'
    renderPage()
    expect(screen.queryByTitle('CamStack viewer')).toBeNull()
    expect(screen.getByTestId('viewer-unavailable-under-mount')).toBeTruthy()
  })
})
