// @vitest-environment jsdom
import type { ConfigInstanceSelectField } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InstancePickerSlotProvider } from '../../contexts/instance-picker-slot'
import type { LinkableInstance } from '../../hooks/use-instances-of-cap'
import { FormField } from '../config-form-field'

const asked: { functionCap: string; kind?: string }[] = []

function linkable(id: string, usable: boolean): LinkableInstance {
  return {
    id,
    name: `name-${id}`,
    kind: 'mqtt',
    addonId: 'addon-x',
    state: usable ? 'ok' : 'error',
    stateLabel: null,
    usable,
  }
}

vi.mock('../../hooks/use-instances-of-cap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/use-instances-of-cap')>()
  return {
    ...actual,
    useInstancesOfCap: (filter: { functionCap: string; kind?: string }) => {
      asked.push(filter)
      return {
        data: [linkable('good', true), linkable('bad', false)],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      }
    },
  }
})

const FIELD: ConfigInstanceSelectField = {
  type: 'instance-select',
  key: 'brokerId',
  label: 'Broker',
  functionCap: 'broker',
  kind: 'mqtt',
}

describe('instance-select field', () => {
  it('lists the usable instances of the cap and kind, and writes the chosen id', () => {
    const onChange = vi.fn()
    render(<FormField field={FIELD} values={{ brokerId: '' }} onChange={onChange} />)
    expect(asked.at(-1)).toEqual({ functionCap: 'broker', kind: 'mqtt' })
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('name-good')
    expect(options).not.toContain('name-bad')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'good' } })
    expect(onChange).toHaveBeenCalledWith('brokerId', 'good')
  })

  it('words the empty choice of an optional link with the field noneLabel', () => {
    render(
      <FormField
        field={{ ...FIELD, noneLabel: 'Default relay' }}
        values={{ brokerId: '' }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Default relay')
  })

  it('keeps the chosen instance visible even when it is not usable', () => {
    render(<FormField field={FIELD} values={{ brokerId: 'bad' }} onChange={vi.fn()} />)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('name-bad')
  })

  it('mounts the host picker with the cap and kind when the host provided one', () => {
    const seen: unknown[] = []
    render(
      <InstancePickerSlotProvider
        picker={(props) => {
          seen.push(props)
          return <span>host picker</span>
        }}
      >
        <FormField field={FIELD} values={{ brokerId: 'good' }} onChange={vi.fn()} />
      </InstancePickerSlotProvider>,
    )
    expect(screen.getByText('host picker')).toBeTruthy()
    expect(seen[0]).toMatchObject({ functionCap: 'broker', kind: 'mqtt', value: 'good' })
  })

  it('hands the host picker disabled and required, which an optional link turns off', () => {
    const seen: { disabled?: boolean; required?: boolean }[] = []
    const picker = (props: { disabled?: boolean; required?: boolean }) => {
      seen.push(props)
      return <span>host picker</span>
    }
    render(
      <InstancePickerSlotProvider picker={picker}>
        <FormField
          field={{ ...FIELD, required: false, disabled: true }}
          values={{ brokerId: '' }}
          onChange={vi.fn()}
        />
      </InstancePickerSlotProvider>,
    )
    expect(seen[0]).toMatchObject({ disabled: true, required: false })
    seen.length = 0
    render(
      <InstancePickerSlotProvider picker={picker}>
        <FormField
          field={{ ...FIELD, required: true }}
          values={{ brokerId: '' }}
          onChange={vi.fn()}
        />
      </InstancePickerSlotProvider>,
    )
    expect(seen[0]).toMatchObject({ required: true })
  })
})
