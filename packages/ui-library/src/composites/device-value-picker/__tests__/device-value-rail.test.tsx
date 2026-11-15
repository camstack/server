// @vitest-environment jsdom
/**
 * The filter rail while a search narrows the fleet: its facets collapse to one
 * option each and the rail draws nothing. That re-render must keep the same
 * hooks (React #300 "Rendered fewer hooks than expected" on a phone).
 */
import type { DeviceSearchFacets } from '@camstack/types'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../generated/system-hooks', () => ({
  useIntegrationsList: () => ({ data: [] }),
  useAddonsList: () => ({ data: [] }),
}))

import { NO_FACETS } from '../device-value-picker-model'
import { DeviceValueRail } from '../device-value-rail'

afterEach(cleanup)

const WIDE: DeviceSearchFacets = {
  locations: [
    { value: 'Kitchen', count: 2 },
    { value: 'Hall', count: 3 },
  ],
  integrations: [
    { id: 'a', label: 'A', count: 2 },
    { id: 'b', label: 'B', count: 3 },
  ],
  types: [
    { value: 'light', count: 2 },
    { value: 'camera', count: 3 },
  ],
}

const NARROW: DeviceSearchFacets = {
  locations: [{ value: 'Hall', count: 1 }],
  integrations: [{ id: 'b', label: 'B', count: 1 }],
  types: [{ value: 'camera', count: 1 }],
}

describe('DeviceValueRail', () => {
  it('keeps its hooks when the facets collapse to nothing to choose between', () => {
    const view = render(
      <DeviceValueRail facets={WIDE} selection={NO_FACETS} onToggle={() => undefined} />,
    )
    expect(view.container.querySelector('nav')).not.toBeNull()
    expect(() =>
      view.rerender(
        <DeviceValueRail facets={NARROW} selection={NO_FACETS} onToggle={() => undefined} />,
      ),
    ).not.toThrow()
    expect(view.container.querySelector('nav')).toBeNull()
    expect(() =>
      view.rerender(
        <DeviceValueRail facets={WIDE} selection={NO_FACETS} onToggle={() => undefined} />,
      ),
    ).not.toThrow()
    expect(view.container.querySelector('nav')).not.toBeNull()
  })
})
