/**
 * The When tree editor: nested blocks, the row-type menu, the engine's refusal
 * shown on the block at fault, the label picker and a stored legacy class.
 */
import { type AutomationRecipe, AutomationRecipeSchema, DeviceType } from '@camstack/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../FieldPicker', async () => {
  const actual = await vi.importActual<typeof import('../FieldPicker')>('../FieldPicker')
  return {
    ...actual,
    FieldPicker: () => null,
    useFieldDescriptor: () => ({ path: 'hopperLevel', kind: 'number' }),
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
