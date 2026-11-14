// @vitest-environment jsdom
/**
 * The rail's frame in the phone sheet: it keeps its own height in the flow
 * (never squashed by the flex column, which painted the facets over the search
 * box) and scrolls inside itself when it is tall.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceValueRailFrame } from '../device-value-rail'

afterEach(cleanup)

describe('DeviceValueRailFrame', () => {
  it('stays in normal flow: non-shrinking, bounded and self-scrolling', () => {
    render(
      <DeviceValueRailFrame open>
        <span>facets</span>
      </DeviceValueRailFrame>,
    )
    const cls = screen.getByTestId('dvp-rail-frame').className.split(' ')
    expect(cls).toContain('shrink-0')
    expect(cls).toContain('overflow-y-auto')
    expect(cls).not.toContain('absolute')
    expect(cls).not.toContain('hidden')
  })

  it('is hidden while the rail is closed', () => {
    render(
      <DeviceValueRailFrame open={false}>
        <span>facets</span>
      </DeviceValueRailFrame>,
    )
    expect(screen.getByTestId('dvp-rail-frame').className.split(' ')).toContain('hidden')
  })
})
