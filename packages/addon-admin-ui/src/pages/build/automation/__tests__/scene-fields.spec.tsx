/**
 * The scene blocks and the run mode: what the editor builds is exactly what the
 * recipe schema accepts, and survives the save → generated code → reopen trip.
 */
import {
  type AutomationRecipe,
  AutomationRecipeSchema,
  type AutomationTrigger,
  DeviceType,
  generateAutomationBlock,
} from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useZonesListZones: ({ deviceId }: { deviceId: number }) => ({
      data: deviceId === 101 ? [{ id: 'zone-bowl', name: 'Bowl' }] : [],
    }),
  }
})

import type { AutomationDevice } from '../automation-data'
import { parseRecipeFromCode } from '../recipe-from-code'
import { newTrigger } from '../recipe-parts'
import { defaultRunMode, runModeOf, withRunMode } from '../RunModeSelector'
import { DetectionFields, StationaryFields } from '../SceneFields'

const DEVICES: readonly AutomationDevice[] = [
  { id: 101, name: 'Kitchen', stableId: 'cam-101', type: DeviceType.Camera },
  { id: 102, name: 'Garage', stableId: 'cam-102', type: DeviceType.Camera },
]

type DetectionTrigger = Extract<AutomationTrigger, { kind: 'detection' }>

function DetectionHarness({ onTrigger }: { readonly onTrigger: (t: DetectionTrigger) => void }) {
  const seed = newTrigger('detection')
  const [trigger, setTrigger] = useState<DetectionTrigger>(
    seed.kind === 'detection' ? seed : { kind: 'detection', classes: [], deviceIds: [] },
  )
  return (
    <DetectionFields
      trigger={trigger}
      devices={DEVICES}
      onChange={(next) => {
        setTrigger(next)
        onTrigger(next)
      }}
    />
  )
}

function recipeWith(triggers: AutomationRecipe['triggers']): AutomationRecipe {
  return {
    triggers,
    actions: [{ kind: 'action', actionId: 'internal:feed-dog', variables: { grams: 30 } }],
  }
}

describe('scene blocks build recipe parts the schema accepts', () => {
  it('a fresh detection trigger is refused until a class and a camera are picked', () => {
    expect(AutomationRecipeSchema.safeParse(recipeWith([newTrigger('detection')])).success).toBe(
      false,
    )
    const picked: AutomationTrigger = {
      kind: 'detection',
      classes: ['animal'],
      deviceIds: [101],
    }
    expect(AutomationRecipeSchema.safeParse(recipeWith([picked])).success).toBe(true)
  })

  it('picking class, camera and zone in the editor yields a valid trigger without empty keys', () => {
    let last: DetectionTrigger | null = null
    render(<DetectionHarness onTrigger={(t) => (last = t)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Animal' }))
    fireEvent.change(screen.getByLabelText('Add camera'), { target: { value: '101' } })
    fireEvent.click(screen.getByRole('button', { name: 'Bowl' }))

    expect(last).toEqual({
      kind: 'detection',
      classes: ['animal'],
      deviceIds: [101],
      zones: ['zone-bowl'],
    })

    // Un-picking the only zone removes the key: absence means the whole scene.
    fireEvent.click(screen.getByRole('button', { name: 'Bowl' }))
    expect(last).toEqual({ kind: 'detection', classes: ['animal'], deviceIds: [101] })
    expect(last !== null && 'zones' in last).toBe(false)
  })

  it('the stopped-object trigger toggles its phase', () => {
    const seed = newTrigger('stationary')
    if (seed.kind !== 'stationary') throw new Error('expected a stationary trigger')
    const onChange = vi.fn()
    render(<StationaryFields trigger={seed} devices={DEVICES} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Left' }))
    expect(onChange).toHaveBeenCalledWith({ ...seed, phase: 'departed' })
  })
})

describe('run mode', () => {
  it('single drops the key, so an untouched recipe stays identical', () => {
    const base = recipeWith([{ kind: 'manual' }])
    expect(withRunMode(base, { mode: 'single' })).toEqual(base)
    expect('runMode' in withRunMode(base, { mode: 'single' })).toBe(false)
  })

  it('each mode starts with an amount the schema accepts', () => {
    for (const name of ['single', 'restart', 'queued', 'parallel', 'cooldown'] as const) {
      const recipe = withRunMode(recipeWith([{ kind: 'manual' }]), defaultRunMode(name))
      expect(AutomationRecipeSchema.safeParse(recipe).success).toBe(true)
      expect(runModeOf(recipe).mode).toBe(name)
    }
  })
})

describe('editing to recipe round trip', () => {
  it('detection, interval, parked-object condition, action variables and run mode survive save and reopen', () => {
    const recipe: AutomationRecipe = {
      triggers: [
        {
          kind: 'detection',
          classes: ['animal'],
          deviceIds: [101],
          zones: ['zone-bowl'],
          minScore: 0.6,
        },
        { kind: 'stationary', deviceIds: [101], phase: 'appeared' },
        { kind: 'interval', minutes: 480 },
      ],
      conditions: {
        kind: 'all',
        children: [{ kind: 'stationary-present', deviceId: 101 }],
      },
      actions: [{ kind: 'action', actionId: 'internal:feed-dog', variables: { grams: 30 } }],
      runMode: { mode: 'cooldown', minutes: 60 },
    }
    expect(AutomationRecipeSchema.safeParse(recipe).success).toBe(true)

    const code = generateAutomationBlock({ name: 'Feed the dog', recipe })
    const reopened = parseRecipeFromCode(code)

    expect(reopened.ok).toBe(true)
    if (reopened.ok) expect(reopened.recipe).toEqual(recipe)
  })
})
