/// <reference types="@testing-library/jest-dom" />
/** Load balancing → Stale device pins names the CAMERA, never "Camera 3836". */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen } from '@testing-library/react'
import type { PlacementStats } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

vi.mock('@tanstack/react-query', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@tanstack/react-query')),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('@camstack/ui-library', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@camstack/ui-library')),
  usePipelineOrchestratorSetPipelineDevicePin: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { StalePinsCard } from '../tabs/ClusterLoadBalancingTab'

const STATS: PlacementStats = {
  policy: 'share',
  windowMs: 3_600_000,
  observedForMs: 3_600_000,
  sessionsNow: 0,
  clusterPeakSessions: 0,
  nodes: [],
  stalePins: [{ deviceId: 3836, deviceKey: 'edgetpu:usb', reason: 'absent' }],
}

describe('StalePinsCard', () => {
  it('names the camera', () => {
    render(
      <StalePinsCard
        stats={STATS}
        cameraName={(id) => (id === 3836 ? 'Camera studio' : `Camera ${id}`)}
      />,
    )
    expect(screen.getByText('Camera studio')).toBeInTheDocument()
    expect(screen.queryByText('Camera 3836')).toBeNull()
  })
})
