/**
 * The scene blocks and the run mode: what the editor builds is exactly what the
 * recipe schema accepts, and survives the save → generated code → reopen trip.
 */
import {
  type AutomationLeaf,
  type AutomationRecipe,
  AutomationRecipeSchema,
  type DetectionLeaf,
  DeviceType,
  generateAutomationBlock,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
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
    useZonesListZones: ({ deviceId }: { deviceId: number }) => ({
      data: deviceId === 101 ? [{ id: 'zone-bowl', name: 'Bowl' }] : [],
    }),
    useFaceGalleryListIdentities: () => ({ data: [] }),
    usePlateGalleryListPlates: () => ({ data: [] }),
  }
})

import type { AutomationDevice } from '../automation-data'
import { defaultRunMode, runModeOf, withRunMode } from '../RunModeSelector'
import { parseRecipeFromCode } from '../recipe-from-code'
import { newLeaf } from '../recipe-parts'
import { DetectionFields, StationaryFields } from '../SceneFields'

const DEVICES: readonly AutomationDevice[] = [
  { id: 101, name: 'Kitchen', stableId: 'cam-101', type: DeviceType.Camera },
  { id: 102, name: 'Garage', stableId: 'cam-102', type: DeviceType.Camera },
]

function detectionSeed(): DetectionLeaf {
  const seed = newLeaf('detection')
  if (seed.kind !== 'detection') throw new Error('expected a detection row')
  return seed
}

function DetectionHarness({ onLeaf }: { readonly onLeaf: (leaf: DetectionLeaf) => void }) {
  const [leaf, setLeaf] = useState<DetectionLeaf>(detectionSeed)
  return (
    <DetectionFields
      leaf={leaf}
      devices={DEVICES}
      onChange={(next) => {
        setLeaf(next)
        onLeaf(next)
      }}
    />
  )
}

function recipeWith(when: AutomationRecipe['when']): AutomationRecipe {
  return {
    when,
    actions: [
      {
        kind: 'action',
        actionId: 'internal:feed-dog',
        variables: { grams: 30 },
      },
    ],
  }
}

describe('scene rows build recipe parts the schema accepts', () => {
  it('a fresh detection row is refused until a camera is picked', () => {
    expect(AutomationRecipeSchema.safeParse(recipeWith(newLeaf('detection'))).success).toBe(false)
    const picked: AutomationLeaf = {
      kind: 'detection',
      subjects: [{ macro: 'animal' }],
      deviceIds: [101],
    }
    expect(AutomationRecipeSchema.safeParse(recipeWith(picked)).success).toBe(true)
  })

  it('picking class, camera and zone in the editor yields a valid row without empty keys', () => {
    let last: DetectionLeaf | null = null
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DetectionHarness onLeaf={(l) => (last = l)} />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByTestId('subject-macro'), { target: { value: 'animal' } })
    fireEvent.click(screen.getByRole('button', { name: /Add cameras/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Kitchen/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Bowl' }))

    expect(last).toEqual({
      kind: 'detection',
      subjects: [{ macro: 'animal' }],
      deviceIds: [101],
      zones: ['zone-bowl'],
    })

    // Un-picking the only zone removes the key: absence means the whole scene.
    fireEvent.click(screen.getByRole('button', { name: 'Bowl' }))
    expect(last).toEqual({
      kind: 'detection',
      subjects: [{ macro: 'animal' }],
      deviceIds: [101],
    })
    expect(last !== null && 'zones' in last).toBe(false)
  })

  it('the stopped-object row toggles its phase', () => {
    const seed = newLeaf('stationary')
    if (seed.kind !== 'stationary') throw new Error('expected a stationary row')
    const onChange = vi.fn()
    render(<StationaryFields leaf={seed} devices={DEVICES} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Left' }))
    expect(onChange).toHaveBeenCalledWith({ ...seed, phase: 'departed' })
  })
})

describe('run mode', () => {
  it('single drops the key, so an untouched recipe stays identical', () => {
    const base = recipeWith({ kind: 'manual' })
    expect(withRunMode(base, { mode: 'single' })).toEqual(base)
    expect('runMode' in withRunMode(base, { mode: 'single' })).toBe(false)
  })

  it('each mode starts with an amount the schema accepts', () => {
    for (const name of ['single', 'restart', 'queued', 'parallel', 'cooldown'] as const) {
      const recipe = withRunMode(recipeWith({ kind: 'manual' }), defaultRunMode(name))
      expect(AutomationRecipeSchema.safeParse(recipe).success).toBe(true)
      expect(runModeOf(recipe).mode).toBe(name)
    }
  })
})

describe('editing to recipe round trip', () => {
  it('detection, interval, parked-object state, action variables and run mode survive save and reopen', () => {
    const recipe: AutomationRecipe = {
      when: {
        kind: 'all',
        children: [
          {
            kind: 'any',
            children: [
              {
                kind: 'detection',
                subjects: [{ macro: 'animal', label: { kind: 'sub-class', className: 'dog' } }],
                deviceIds: [101],
                zones: ['zone-bowl'],
                minScore: 0.6,
              },
              { kind: 'stationary', deviceIds: [101], phase: 'appeared' },
              { kind: 'interval', minutes: 480 },
            ],
          },
          { kind: 'stationary-present', deviceId: 101 },
        ],
      },
      actions: [
        {
          kind: 'action',
          actionId: 'internal:feed-dog',
          variables: { grams: 30 },
        },
      ],
      runMode: { mode: 'cooldown', minutes: 60 },
    }
    expect(AutomationRecipeSchema.safeParse(recipe).success).toBe(true)

    const code = generateAutomationBlock({ name: 'Feed the dog', recipe })
    const reopened = parseRecipeFromCode(code)

    expect(reopened.ok).toBe(true)
    if (reopened.ok) expect(reopened.recipe).toEqual(recipe)
  })
})
