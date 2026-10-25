/**
 * The automation editor's device picker reads the SHARED fleet query.
 *
 * It used to be `system.trpcClient.deviceManager.listAll.query({ projection:
 * 'slim' })` inside a `useQuery` keyed `['automation','devices']` with its own
 * `staleTime: 60_000`. The projection was already right; the CLIENT was not,
 * and that is the half D274 cannot see:
 *
 *   - `applyFleetQueryDefaults` registers the window on the tRPC key PREFIX
 *     `[['deviceManager','listAll']]`. `['automation','devices']` does not
 *     match it, so the registration never applied and the local 60 s window was
 *     a second owner of exactly the thing D274 exists to give one owner.
 *   - The ~20 mutation handlers that invalidate `[['deviceManager']]` do not
 *     match it either. A device renamed or adopted while the editor was open
 *     never appeared in the picker.
 *   - It fetched its own copy of a fleet the sidebar search already holds warm.
 *
 * The assertion is the request shape: which client, which projection, whose
 * window — never wall clock.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  FleetListInput,
  FleetListOptions,
  FleetListResult,
} from '../../../system/__tests__/fleet-read-spy'
import { type FleetRow, fleetListResult } from '../../../system/__tests__/fleet-read-spy'

const FLEET_ROWS: readonly FleetRow[] = [
  { id: 42, name: 'Serratura front door', stableId: 'lock-42', type: 'lock' },
  { id: 101, name: 'Camera atrio', stableId: 'cam-101', type: 'camera', location: 'Atrio' },
  // A container is a parent grouping node, never an automation target.
  { id: 7, name: 'Atrio hub', stableId: 'container-7', type: 'container' },
]

const listAllHook = vi.fn(
  (_input?: FleetListInput, _options?: FleetListOptions): FleetListResult =>
    fleetListResult(FLEET_ROWS),
)

/** Named so the spec can assert the RAW client is never reached. */
const mockListAllRaw = vi.fn(() => Promise.resolve([]))

vi.mock('@camstack/ui-library', () => ({
  useDeviceManagerListAll: (input?: FleetListInput, options?: FleetListOptions) =>
    listAllHook(input, options),
  useSystem: () => ({
    trpcClient: { deviceManager: { listAll: { query: mockListAllRaw } } },
  }),
}))

import { useAutomationDevices } from '../automation-data'

describe('useAutomationDevices', () => {
  it('reads the fleet through the shared client, slim, with no window of its own', () => {
    renderHook(() => useAutomationDevices())

    expect(listAllHook).toHaveBeenCalled()
    for (const [input, options] of listAllHook.mock.calls) {
      expect(input?.projection).toBe('slim')
      // D274 owns the window on the query client. A local `staleTime` here is
      // the second owner the ADR exists to remove.
      expect(options?.staleTime).toBeUndefined()
    }
    expect(mockListAllRaw).not.toHaveBeenCalled()
  })

  it('carries every field the picker reads — id, name, stableId, type, location — sorted by name, containers dropped', () => {
    const { result } = renderHook(() => useAutomationDevices())
    // `stableId` is the load-bearing one: an expression binding addresses a
    // device BY it, and slim keeps it (slim drops only `config`, `metadata`
    // and `sourceInfo`). Losing it would silently re-point bindings.
    // `type` and `location` feed the picker's Type / Location filters; an
    // absent location is `null` (unknown), never a made-up room.
    expect(result.current).toEqual([
      { id: 101, name: 'Camera atrio', stableId: 'cam-101', type: 'camera', location: 'Atrio' },
      { id: 42, name: 'Serratura front door', stableId: 'lock-42', type: 'lock', location: null },
    ])
  })
})
