/**
 * The When tree editor: nested blocks, the row-type menu, the engine's refusal
 * shown on the block at fault, the label picker and a stored legacy class.
 */
import {
  type AutomationRecipe,
  AutomationRecipeSchema,
  type AutomationWhen,
  DeviceType,
} from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return {
    ...actual,
    FieldPicker: () => null,
    useFieldDescriptor: (sel: { readonly fieldPath: string }) =>
      sel.fieldPath === 'weight'
        ? { path: 'weight', kind: 'number', quantity: 'mass' }
        : { path: 'hopperLevel', kind: 'number' },
  }
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceManagerGetDevice: () => ({ data: undefined }),
    useZonesListZones: () => ({ data: [] }),
    useFaceGalleryListIdentities: () => ({ data: [{ id: 'id-anna', name: 'Anna' }] }),
    usePlateGalleryListPlates: () => ({ data: [{ text: 'AB123CD' }, { text: 'AB123CD' }] }),
  }
})

import type { AutomationDevice } from '../automation-data'
import { EMPTY_RECIPE } from '../recipe-parts'
import type { AutomationRunTrace } from '@camstack/types'
import { whenRunView } from '../../flow/trace-view'
import { WhenTree } from '../WhenTree'

const DEVICES: readonly AutomationDevice[] = [
  { id: 101, name: 'Kitchen', stableId: 'cam-101', type: DeviceType.Camera },
]

function Harness({
  initial,
  onRecipe,
}: {
  readonly initial: AutomationRecipe
  readonly onRecipe?: (recipe: AutomationRecipe) => void
}) {
  const [recipe, setRecipe] = useState(initial)
  return (
    <WhenTree
      recipe={recipe}
      devices={DEVICES}
      onChange={(next) => {
        setRecipe(next)
        onRecipe?.(next)
      }}
    />
  )
}

const IS_ROW = {
  kind: 'device-is',
  deviceId: 7,
  cap: 'pet-feeder',
  fieldPath: 'hopperLevel',
  operator: 'eq',
  value: 3,
} as const

function recipeOf(when: AutomationRecipe['when']): AutomationRecipe {
  return { ...EMPTY_RECIPE, when }
}

describe('WhenTree', () => {
  it('adds a nested block from inside a block, with its own add-row', () => {
    render(<Harness initial={recipeOf({ kind: 'all', children: [IS_ROW] })} />)
    expect(screen.getAllByTestId('when-block')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Add block/ }))
    const blocks = screen.getAllByTestId('when-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]?.getAttribute('data-kind')).toBe('any')
    expect(within(blocks[1] as HTMLElement).getAllByTestId('when-row')).toHaveLength(1)
    expect(within(blocks[1] as HTMLElement).getByRole('button', { name: /Add row/ })).toBeTruthy()
  })

  it('changes a row from state to event through the one type menu', () => {
    let last: AutomationRecipe | null = null
    render(
      <Harness
        initial={recipeOf({ kind: 'all', children: [IS_ROW] })}
        onRecipe={(r) => (last = r)}
      />,
    )
    expect(screen.getByTestId('when-row-nature').textContent).toBe('State')
    const typeMenu = within(screen.getByTestId('when-row-type')).getByRole('combobox')
    fireEvent.focus(typeMenu)
    fireEvent.click(typeMenu)
    fireEvent.click(screen.getByTestId('when-kind-device-becomes'))
    expect(screen.getByTestId('when-row-nature').textContent).toBe('Event')
    expect(last).not.toBeNull()
    expect(JSON.stringify(last)).toContain('"device-becomes"')
  })

  it('shows the refusal for two events at once on the offending AND block', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [
            IS_ROW,
            { kind: 'all', children: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }] },
          ],
        })}
      />,
    )
    const issues = screen.getAllByTestId('when-issue')
    expect(issues).toHaveLength(1)
    const blocks = screen.getAllByTestId('when-block')
    expect(within(blocks[1] as HTMLElement).getByTestId('when-issue')).toBe(issues[0])
  })

  it('files animal species, known faces and plates under the macro', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [{ kind: 'detection', subjects: [{ macro: 'animal' }], deviceIds: [101] }],
        })}
      />,
    )
    const labelOptions = (): string[] =>
      Array.from(
        (screen.getByTestId('subject-label') as HTMLSelectElement).options,
        (o) => o.textContent ?? '',
      )
    expect(labelOptions()).toContain('dog')

    fireEvent.change(screen.getByTestId('subject-macro'), { target: { value: 'person' } })
    expect(labelOptions()).toContain('Anna')

    fireEvent.change(screen.getByTestId('subject-macro'), { target: { value: 'vehicle' } })
    expect(labelOptions().filter((l) => l.includes('AB123CD'))).toHaveLength(1)
  })

  it('shows a stored legacy `dog` as animal narrowed to dog', () => {
    const legacy = {
      triggers: [{ kind: 'detection', classes: ['dog'], deviceIds: [101] }],
      actions: [{ kind: 'action', actionId: 'internal:feed-dog' }],
    }
    const parsed = AutomationRecipeSchema.parse(legacy)
    render(<Harness initial={parsed} />)
    expect((screen.getByTestId('subject-macro') as HTMLSelectElement).value).toBe('animal')
    expect((screen.getByTestId('subject-label') as HTMLSelectElement).value).toBe('dog')
  })
})

describe('WhenTree with a selected run', () => {
  const DEVICE_IS: AutomationWhen = {
    kind: 'device-is',
    deviceId: 7,
    cap: 'scale',
    fieldPath: 'weight',
    operator: 'gt',
    value: 0.01,
    unit: 'g',
  }
  const EVENT: AutomationWhen = {
    kind: 'detection',
    subjects: [{ macro: 'animal' }],
    deviceIds: [101],
  }
  const TRACE: AutomationRunTrace = {
    runId: 'r1',
    startedAt: 1,
    endedAt: 2,
    trigger: {
      kind: 'detection',
      path: 'when.0.0',
      outcome: 'pass',
      reason: 'animal seen',
      vars: { className: 'animal', trackId: 'trk-1' },
    },
    conditions: [
      { path: 'when', kind: 'all', outcome: 'fail', reason: '' },
      { path: 'when.0', kind: 'any', outcome: 'pass', reason: 'one event fired' },
      { path: 'when.0.0', kind: 'detection', outcome: 'pass', reason: 'animal seen' },
      {
        path: 'when.1',
        kind: 'device-is',
        outcome: 'fail',
        reason: 'weight is below 10 g',
        cap: 'scale',
        fieldPath: 'weight',
        operator: 'gt',
        expected: 0.01,
        observed: 0.004,
      },
    ],
    steps: [],
    outcome: 'skipped-conditions',
    repeat: 1,
    lastAt: 2,
  }
  const recipe = recipeOf({
    kind: 'all',
    children: [{ kind: 'any', children: [EVENT] }, DEVICE_IS],
  })

  function renderRun() {
    render(
      <WhenTree recipe={recipe} devices={DEVICES} onChange={() => {}} run={whenRunView(TRACE)} />,
    )
  }

  it('tones every row and every sub-block by its own path', () => {
    renderRun()
    const [root, anyBlock] = screen.getAllByTestId('when-block')
    expect(root?.className).toContain('border-danger')
    expect(anyBlock?.className).toContain('border-success')
    const [eventRow, stateRow] = screen.getAllByTestId('when-row')
    expect(eventRow?.className).toContain('border-success')
    expect(stateRow?.className).toContain('border-danger')
  })

  it('shows the row value in the row unit, not the stored one', () => {
    renderRun()
    const stateRow = within(screen.getAllByTestId('when-row')[1] as HTMLElement)
    expect(within(stateRow.getByTestId('trace-expected')).getByText('10 g')).toBeTruthy()
    expect(within(stateRow.getByTestId('trace-observed')).getByText('4 g')).toBeTruthy()
    expect(stateRow.queryByText('0.01')).toBeNull()
  })

  it('shows the trigger vars inside the event row only', () => {
    renderRun()
    const [eventRow, stateRow] = screen.getAllByTestId('when-row')
    expect(within(eventRow as HTMLElement).getByText('trk-1')).toBeTruthy()
    expect(within(stateRow as HTMLElement).queryByTestId('trace-vars')).toBeNull()
  })

  it('paints nothing without a selected run', () => {
    render(<WhenTree recipe={recipe} devices={DEVICES} onChange={() => {}} />)
    expect(screen.queryByTestId('trace-result')).toBeNull()
  })
})
