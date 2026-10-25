/**
 * StationarySection reads the device fleet only to resolve a parked object's
 * camera name — the guard here is the query SHAPE, not the rendered output:
 * `isCamera: true` + `projection: 'slim'` instead of the unfiltered `{}` this
 * (and ten sibling sections across detection-intelligence/recordings) used to
 * pass. Fetching every device to filter cameras client side was measured at
 * ~900 rows returned per mount to answer a question the server can answer in
 * ~a dozen. A mock that ignores the call's arguments (most component specs
 * here do) would not catch a regression back to `{}`; asserting on the exact
 * input does.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

interface ListAllInput {
  readonly isCamera?: boolean
  readonly projection?: string
}
interface ListAllOptions {
  readonly staleTime?: number
}

const listAllSpy = vi.fn((_input?: ListAllInput, _options?: ListAllOptions) => ({
  data: [{ id: 1, name: 'Front Gate' }],
}))

vi.mock('@camstack/ui-library', () => ({
  useDeviceManagerListAll: (input?: ListAllInput, options?: ListAllOptions) =>
    listAllSpy(input, options),
}))

vi.mock('../use-stationary-objects.js', () => ({
  useStationaryObjects: () => ({
    rows: [
      {
        id: 'park-1',
        deviceId: 1,
        className: 'car',
        label: null,
        becameStationaryAt: Date.now() - 60_000,
        keyFrameMediaKey: undefined,
      },
    ],
    isLoading: false,
  }),
}))

vi.mock('../../../lib/authed-media.js', () => ({
  EVENT_MEDIA_BASE: '/addon/pipeline-analytics/event-media',
  useAuthedImage: () => ({ src: undefined }),
}))

import { StationarySection } from '../StationarySection'

describe('StationarySection', () => {
  it('asks device-manager for cameras only, slim, and sets no window of its own', () => {
    render(<StationarySection />)
    expect(listAllSpy).toHaveBeenCalledTimes(1)
    const [input, options] = listAllSpy.mock.calls[0]
    expect(input?.isCamera).toBe(true)
    expect(input?.projection).toBe('slim')
    // Since D274 the caching window is registered once on the query client,
    // not copied here. The outcome it buys (N observers → one fetch) is
    // measured against a real client in
    // `packages/ui-library/src/lib/__tests__/fleet-query-defaults.spec.tsx`.
    expect(options?.staleTime).toBeUndefined()
  })
})
