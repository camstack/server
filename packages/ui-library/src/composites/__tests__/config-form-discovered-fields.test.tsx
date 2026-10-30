// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * `broker-select` and a `select` that discovers its options.
 *
 * Disarm: make the select fetch without waiting for `dependsOn` (drop `ready`
 * from `enabled`) and "does not fetch until the broker is picked" fails; render
 * `field.options` only and "lists the candidates" fails.
 */
import type { ConfigField } from '@camstack/types'
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

interface DiscoverInput {
  readonly kind: string
  readonly config: Record<string, unknown>
}
interface Candidate {
  readonly kind: string
  readonly suggestedName: string
  readonly config: Record<string, unknown>
}

const asked: DiscoverInput[] = []
let candidates: readonly Candidate[] = []
let failure: Error | null = null

vi.mock('../../generated/system-hooks', () => ({
  useBrokerList: () => ({
    data: [
      { id: 'b1', name: 'Home HA', kind: 'home-assistant', status: 'connected' },
      { id: 'b2', name: 'Other', kind: 'another-kind', status: 'connected' },
    ],
    isLoading: false,
  }),
  useNotificationOutputDiscoverTargets: (
    input: DiscoverInput,
    options: { readonly enabled: boolean },
  ) => {
    if (options.enabled) asked.push(input)
    if (!options.enabled)
      return { data: undefined, isLoading: false, isFetching: false, isError: false, error: null }
    if (failure !== null)
      return { data: undefined, isLoading: false, isFetching: false, isError: true, error: failure }
    return { data: candidates, isLoading: false, isFetching: false, isError: false, error: null }
  },
}))

const { FormField } = await import('../config-form-field')
const { BrokerPickerSlotProvider } = await import('../../contexts/broker-picker-slot')

const brokerField: ConfigField = {
  type: 'broker-select',
  key: 'brokerId',
  label: 'Broker',
  brokerKind: 'home-assistant',
}
const serviceField: ConfigField = {
  type: 'select',
  key: 'service',
  label: 'Service',
  options: [],
  discoverOptions: { kind: 'homeassistant', dependsOn: ['brokerId'] },
}

function Form({ initial = {} }: { readonly initial?: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  const change = (key: string, value: unknown): void =>
    setValues((prev) => ({ ...prev, [key]: value }))
  return (
    <>
      <FormField field={brokerField} values={values} onChange={change} />
      <FormField field={serviceField} values={values} onChange={change} />
      <output data-testid="values">{JSON.stringify(values)}</output>
    </>
  )
}

describe('broker-select', () => {
  it('mounts the host picker with the field kind', () => {
    const Picker = ({
      kind,
      onChange,
    }: {
      kind: string
      value: string | null
      onChange: (id: string | null) => void
    }) => <button type="button" onClick={() => onChange('b9')}>{`picker:${kind}`}</button>
    render(
      <BrokerPickerSlotProvider picker={Picker}>
        <Form />
      </BrokerPickerSlotProvider>,
    )
    fireEvent.click(screen.getByText('picker:home-assistant'))
    expect(screen.getByTestId('values').textContent).toContain('"brokerId":"b9"')
  })

  it('without a host picker lists only the brokers of its kind', () => {
    render(<Form />)
    expect(screen.getByRole('option', { name: 'Home HA' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Other' })).toBeNull()
  })
})

describe('select with discoverOptions', () => {
  beforeEach(() => {
    asked.length = 0
    failure = null
    candidates = [
      {
        kind: 'homeassistant',
        suggestedName: 'Pixel 7',
        config: { service: 'mobile_app_pixel_7', brokerId: 'b1' },
      },
      {
        kind: 'homeassistant',
        suggestedName: 'Mail relay',
        config: { service: 'smtp_relay', brokerId: 'b1' },
      },
    ]
  })

  it('does not fetch until the broker is picked, and says what it waits for', () => {
    render(<Form />)
    expect(asked).toHaveLength(0)
    expect(screen.getByTestId('config-select-service-status')).toHaveTextContent(
      'Fill in the fields above',
    )
  })

  it('lists the candidates with their names after the broker is picked, storing the id', async () => {
    render(<Form />)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'b1' } })
    await waitFor(
      () => expect(screen.getByRole('option', { name: 'Pixel 7' })).toBeInTheDocument(),
      {
        timeout: 3000,
      },
    )
    expect(asked.at(-1)).toEqual({ kind: 'homeassistant', config: { brokerId: 'b1' } })
    fireEvent.change(screen.getAllByRole('combobox')[1]!, {
      target: { value: 'mobile_app_pixel_7' },
    })
    expect(screen.getByTestId('values').textContent).toContain('"service":"mobile_app_pixel_7"')
  })

  it('keeps free text when the fetch fails, saying why', async () => {
    failure = new Error('broker unreachable')
    render(<Form initial={{ brokerId: 'b1' }} />)
    await waitFor(
      () =>
        expect(screen.getByTestId('config-select-service-status')).toHaveTextContent(
          'broker unreachable',
        ),
      { timeout: 3000 },
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my_service' } })
    expect(screen.getByTestId('values').textContent).toContain('"service":"my_service"')
  })

  it('keeps free text when nothing was found, saying so', async () => {
    candidates = []
    render(<Form initial={{ brokerId: 'b1' }} />)
    await waitFor(
      () =>
        expect(screen.getByTestId('config-select-service-status')).toHaveTextContent(
          'Nothing was found',
        ),
      { timeout: 3000 },
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
