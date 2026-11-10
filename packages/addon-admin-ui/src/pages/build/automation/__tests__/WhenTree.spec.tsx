/**
 * The When tree editor: nested blocks, the row-type menu, reorder and collapse,
 * no in-tree warnings, the label picker and a stored legacy class.
 */
import {
  type AutomationRecipe,
  AutomationRecipeSchema,
  type AutomationWhen,
  DeviceType,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render as plainRender, screen, within } from '@testing-library/react'
import { type ReactElement, useState } from 'react'
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
    useSystem: () => ({
      trpcClient: {
        notificationRules: {
          getConditionCatalog: {
            query: () => Promise.reject(new Error('no taxonomy')),
          },
        },
      },
    }),
    useDeviceManagerGetDevice: () => ({ data: undefined }),
    useZonesListZones: () => ({ data: [] }),
    useFaceGalleryListIdentities: () => ({
      data: [{ id: 'id-anna', name: 'Anna' }],
    }),
    usePlateGalleryListPlates: () => ({
      data: [{ text: 'AB123CD' }, { text: 'AB123CD' }],
    }),
  }
})

import type { AutomationDevice } from '../automation-data'
import { EMPTY_RECIPE } from '../recipe-parts'
import type { AutomationRunTrace } from '@camstack/types'
import { whenRunView } from '../../flow/trace-view'
import { WhenTree } from '../WhenTree'

function render(ui: ReactElement) {
  return plainRender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  )
}

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

  it('shows no warning inside the tree: the refusal belongs to the save path', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [
            IS_ROW,
            {
              kind: 'all',
              children: [{ kind: 'manual' }, { kind: 'interval', minutes: 5 }],
            },
          ],
        })}
      />,
    )
    expect(screen.queryByTestId('when-issue')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not tell an empty IF that nothing can start the automation', () => {
    render(
      <WhenTree
        hideRule
        recipe={recipeOf({ kind: 'all', children: [] })}
        devices={DEVICES}
        onChange={() => {}}
      />,
    )
    expect(screen.queryByText(/nothing can ever start/)).toBeNull()
  })

  it('moves a row down and a block up among its siblings', () => {
    let last: AutomationRecipe | null = null
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [{ kind: 'manual' }, { kind: 'any', children: [IS_ROW] }],
        })}
        onRecipe={(r) => (last = r)}
      />,
    )
    const ups = screen.getAllByRole('button', { name: 'Move up' })
    const downs = screen.getAllByRole('button', { name: 'Move down' })
    // manual row, the ANY block, and the row inside it (alone: both disabled)
    expect(ups).toHaveLength(3)
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true)
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(downs[0] as HTMLElement)
    expect(JSON.stringify(last)).toContain(
      JSON.stringify({
        kind: 'all',
        children: [{ kind: 'any', children: [IS_ROW] }, { kind: 'manual' }],
      }),
    )
    const rows = screen.getAllByTestId('when-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['device-is', 'manual'])
  })

  it('collapses a block to a one-line summary and opens it again', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [{ kind: 'manual' }, { kind: 'any', children: [IS_ROW, { kind: 'manual' }] }],
        })}
      />,
    )
    const block = screen.getAllByTestId('when-block')[1] as HTMLElement
    const toggle = within(block).getByRole('button', {
      name: 'Collapse this block',
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    const collapsed = screen.getAllByTestId('when-block')[1] as HTMLElement
    expect(within(collapsed).queryAllByTestId('when-row')).toHaveLength(0)
    expect(within(collapsed).getByTestId('when-block-summary').textContent).toMatch(/2 rows/)
    fireEvent.click(within(collapsed).getByRole('button', { name: 'Expand this block' }))
    expect(
      within(screen.getAllByTestId('when-block')[1] as HTMLElement).getAllByTestId('when-row'),
    ).toHaveLength(2)
  })

  it('keeps a collapsed block collapsed when it moves', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [{ kind: 'manual' }, { kind: 'any', children: [IS_ROW] }],
        })}
      />,
    )
    const block = screen.getAllByTestId('when-block')[1] as HTMLElement
    fireEvent.click(within(block).getByRole('button', { name: 'Collapse this block' }))
    fireEvent.click(
      within(screen.getAllByTestId('when-block')[1] as HTMLElement).getByRole('button', {
        name: 'Move up',
      }),
    )
    expect(screen.getAllByTestId('when-row')).toHaveLength(1)
    expect(screen.getAllByTestId('when-row')[0]?.getAttribute('data-kind')).toBe('manual')
    expect(screen.getByTestId('when-block-summary')).toBeTruthy()
  })

  it('labels the ungroup button in words', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [{ kind: 'any', children: [IS_ROW] }],
        })}
      />,
    )
    const button = screen.getByRole('button', { name: /Ungroup/ })
    expect(button.textContent).toContain('Ungroup')
    fireEvent.click(button)
    expect(screen.getAllByTestId('when-block')).toHaveLength(1)
  })

  it('files animal species, known faces and plates under the macro', () => {
    render(
      <Harness
        initial={recipeOf({
          kind: 'all',
          children: [
            {
              kind: 'detection',
              subjects: [{ macro: 'animal' }],
              deviceIds: [101],
            },
          ],
        })}
      />,
    )
    const labelOptions = (): string[] =>
      Array.from(
        (screen.getByTestId('subject-label') as HTMLSelectElement).options,
        (o) => o.textContent ?? '',
      )
    expect(labelOptions()).toContain('dog')

    fireEvent.change(screen.getByTestId('subject-macro'), {
      target: { value: 'person' },
    })
    expect(labelOptions()).toContain('Anna')

    fireEvent.change(screen.getByTestId('subject-macro'), {
      target: { value: 'vehicle' },
    })
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
      {
        path: 'when.0',
        kind: 'any',
        outcome: 'pass',
        reason: 'one event fired',
      },
      {
        path: 'when.0.0',
        kind: 'detection',
        outcome: 'pass',
        reason: 'animal seen',
      },
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
