import { compileHelper, type Composition, type GroupHelperSpec } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { GroupTriggersSection } from '../GroupTriggersSection'

const BUTTON = { addonId: 'demo', stableId: 'button-1' }

vi.mock('../../device/customize/assignments/use-source-candidates', () => ({
  useCandidateDevices: () => ({
    kind: 'known',
    value: [
      {
        id: 7,
        addonId: BUTTON.addonId,
        stableId: BUTTON.stableId,
        name: 'Hall button',
        type: 'sensor',
        integration: 'demo',
        location: null,
      },
    ],
  }),
}))

vi.mock('../../device/customize/assignments/CustomizeDevicePickerDialog', () => ({
  CustomizeDevicePickerDialog: (props: {
    readonly open: boolean
    readonly onConfirm: (picked: readonly { readonly ref: typeof BUTTON }[]) => void
  }) =>
    props.open ? (
      <button
        type="button"
        data-testid="fake-pick"
        onClick={() => props.onConfirm([{ ref: BUTTON }])}
      />
    ) : null,
}))

function compositionOf(over: Partial<GroupHelperSpec> = {}): Composition {
  const spec: GroupHelperSpec = {
    kind: 'group',
    templateId: 'light',
    aggregate: 'any',
    active: 'at-least-one',
    members: [
      {
        source: { addonId: 'demo', stableId: 'lamp-1' },
        cap: 'switch',
        fieldPath: 'on',
      },
    ],
    ...over,
  }
  const compiled = compileHelper(spec)
  if (!compiled.ok) throw new Error('did not compile')
  return compiled.composition
}

describe('the group Triggers section', () => {
  it('adds a trigger through the group spec, never beside it', async () => {
    const save = vi.fn(async (_next: Composition) => ({
      kind: 'saved' as const,
    }))
    render(<GroupTriggersSection composition={compositionOf()} saving={false} save={save} />)
    fireEvent.click(screen.getByTestId('group-trigger-add'))
    fireEvent.click(screen.getByText('Pick a device'))
    fireEvent.click(screen.getByTestId('fake-pick'))
    fireEvent.click(screen.getByText('Save trigger'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const saved: Composition | undefined = save.mock.calls[0]?.[0]
    const helper = saved?.helper
    expect(helper?.kind === 'group' && helper.triggers).toEqual([
      {
        id: 't1',
        source: { kind: 'fired', device: BUTTON },
        action: { kind: 'on' },
      },
    ])
  })

  it("shows the backend's refusal by name and keeps the draft", async () => {
    const save = vi.fn(async (_next: Composition) => ({
      kind: 'refused' as const,
      reason: 'a group without a device needs a trigger',
    }))
    render(<GroupTriggersSection composition={compositionOf()} saving={false} save={save} />)
    fireEvent.click(screen.getByTestId('group-trigger-add'))
    fireEvent.click(screen.getByText('Pick a device'))
    fireEvent.click(screen.getByTestId('fake-pick'))
    fireEvent.click(screen.getByText('Save trigger'))
    expect(await screen.findByText(/needs a trigger/)).toBeTruthy()
    expect(screen.getByTestId('group-trigger-draft')).toBeTruthy()
  })

  it('removes a trigger and renders nothing for a group type that takes none', async () => {
    const save = vi.fn(async (_next: Composition) => ({
      kind: 'saved' as const,
    }))
    const withOne = compositionOf({
      triggers: [
        {
          id: 't1',
          source: { kind: 'fired', device: BUTTON },
          action: { kind: 'off' },
        },
      ],
    })
    const { unmount } = render(
      <GroupTriggersSection composition={withOne} saving={false} save={save} />,
    )
    expect(screen.getByTestId('group-trigger-t1').textContent).toContain('Hall button → off')
    fireEvent.click(screen.getByText('Remove'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    unmount()
    const base = compositionOf()
    const helper = base.helper
    if (helper === undefined || helper.kind !== 'group') throw new Error('not a group')
    render(
      <GroupTriggersSection
        composition={{ ...base, helper: { ...helper, templateId: 'motion' } }}
        saving={false}
        save={save}
      />,
    )
    expect(screen.queryByTestId('group-triggers-card')).toBeNull()
  })
})
