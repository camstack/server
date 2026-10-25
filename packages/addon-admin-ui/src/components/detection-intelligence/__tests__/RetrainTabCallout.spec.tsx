import { fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { RetrainTabCallout } from '../RetrainTabCallout.js'
import { RETRAIN_HREF } from '../../../lib/events-page-url.js'

function LocationProbe(): JSX.Element {
  const { pathname, search } = useLocation()
  return (
    <div data-testid="location">
      {pathname}
      {search}
    </div>
  )
}

describe('RetrainTabCallout', () => {
  it('navigates to /addon/training when the CTA is clicked', () => {
    render(
      <MemoryRouter initialEntries={['/library?tab=events&section=feed']}>
        <Routes>
          <Route
            path="/library"
            element={
              <>
                <RetrainTabCallout />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="/addon/training"
            element={
              <>
                <div>training-page</div>
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Training' }))
    expect(screen.getByTestId('location').textContent).toBe(RETRAIN_HREF)
  })
})
