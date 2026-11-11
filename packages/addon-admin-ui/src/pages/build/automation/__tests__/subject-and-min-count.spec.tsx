/**
 * The detection leaf's sub-class options come from the served class taxonomy
 * (falling back to the static map), and the stationary-present leaf exposes
 * `minCount` as the key's presence, never a stored default.
 */
import { selectOptionLabels, waitForSelectRows } from '@camstack/ui-library/testing'
import { DeviceType, type StationaryPresentLeaf } from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

const served = vi.hoisted(() => ({ taxonomy: undefined as unknown }))

vi.mock('../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      notificationRules: {
        getConditionCatalog: {
          query: () =>
            served.taxonomy === undefined
              ? Promise.reject(new Error('no taxonomy'))
              : Promise.resolve({ taxonomy: served.taxonomy }),
        },
      },
      deviceManager: {
        listSiteZones: { query: () => new Promise(() => undefined) },
      },
    },
  }),
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useZonesListZones: () => ({ data: [] }),
    useFaceGalleryListIdentities: () => ({ data: [] }),
    usePlateGalleryListPlates: () => ({ data: [] }),
  }
})

import type { AutomationDevice } from '../automation-data'
import { StationaryPresentFields } from '../SceneFields'
import { SubjectPicker } from '../SubjectPicker'

const DEVICES: readonly AutomationDevice[] = [
  { id: 101, name: 'Kitchen', stableId: 'cam-101', type: DeviceType.Camera },
]

function wrap(node: React.ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>
  )
}

describe('sub-class labels come from the served taxonomy', () => {
  it('shows the taxonomy label for an animal sub-class', async () => {
    served.taxonomy = {
      videoClasses: [
        { kind: 'animal', label: 'Animal', parentKind: null },
        { kind: 'dog', label: 'Good boy', parentKind: 'animal' },
      ],
      audioKinds: [],
      sensorLabels: [],
      controlLabels: [],
    }
    render(
      wrap(
        <SubjectPicker
          subjects={[{ macro: 'animal' }]}
          optional={false}
          classLabelsOnly={false}
          verb="is seen"
          onChange={() => undefined}
        />,
      ),
    )
    const select = await screen.findByTestId('subject-label')
    await waitForSelectRows(select, (rows) => rows.some((r) => r.label === 'Good boy'))
  })

  it('falls back to the static sub-classes when no taxonomy is served', async () => {
    served.taxonomy = undefined
    render(
      wrap(
        <SubjectPicker
          subjects={[{ macro: 'animal' }]}
          optional={false}
          classLabelsOnly={false}
          verb="is seen"
          onChange={() => undefined}
        />,
      ),
    )
    const select = await screen.findByTestId('subject-label')
    expect(selectOptionLabels(select)).toContain('dog')
  })
})

function Harness({ onLeaf }: { readonly onLeaf: (l: StationaryPresentLeaf) => void }) {
  const [leaf, setLeaf] = useState<StationaryPresentLeaf>({
    kind: 'stationary-present',
    deviceId: 101,
  })
  return (
    <StationaryPresentFields
      leaf={leaf}
      devices={DEVICES}
      onChange={(next) => {
        setLeaf(next)
        onLeaf(next)
      }}
    />
  )
}

describe('stationary-present minCount', () => {
  it('stores a count above one and drops the key at one', () => {
    served.taxonomy = undefined
    let last: StationaryPresentLeaf | null = null
    render(wrap(<Harness onLeaf={(l) => (last = l)} />))
    const input = screen.getByTestId('stationary-present-min-count')
    fireEvent.change(input, { target: { value: '3' } })
    expect(last).toMatchObject({ minCount: 3 })
    fireEvent.change(input, { target: { value: '1' } })
    expect(last).not.toHaveProperty('minCount')
  })
})
