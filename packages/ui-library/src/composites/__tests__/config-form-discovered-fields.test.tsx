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
let loading = false

vi.mock('../../hooks/use-broker-instances', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/use-broker-instances')>(
    '../../hooks/use-broker-instances',
  )
  return {
    ...actual,
    useBrokerInstances: (input: { kind?: string }) => ({
      data: [
        { id: 'b1', name: 'Home HA', kind: 'home-assistant', state: 'ok', usable: true },
        { id: 'b2', name: 'Other', kind: 'another-kind', state: 'ok', usable: true },
      ].filter((b) => input.kind === undefined || b.kind === input.kind),
      isLoading: false,
    }),
  }
})

vi.mock('../../generated/system-hooks', () => ({
  useNotificationOutputDiscoverTargets: (
    input: DiscoverInput,
    options: { readonly enabled: boolean },
  ) => {
    if (options.enabled) asked.push(input)
    if (!options.enabled)
      return { data: undefined, isLoading: false, isFetching: false, isError: false, error: null }
    if (loading)
      return { data: undefined, isLoading: true, isFetching: true, isError: false, error: null }
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
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2), {
      timeout: 3000,
    })
    expect(asked.at(-1)).toEqual({ kind: 'homeassistant', config: { brokerId: 'b1' } })
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'pixel' } })
    expect(screen.queryByTestId('config-select-service-option-smtp_relay')).toBeNull()
    fireEvent.click(screen.getByTestId('config-select-service-option-mobile_app_pixel_7'))
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

const relayField: ConfigField = {
  type: 'select',
  key: 'smtpInstanceId',
  label: 'Relay',
  options: [],
  discoverOptions: {
    kind: 'email',
    dependsOn: ['smtpAddonId'],
    noneLabel: 'Default relay',
    missingLabel: 'missing relay',
  },
}

function RelayForm({ initial = {} }: { readonly initial?: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  return (
    <>
      <FormField
        field={relayField}
        values={values}
        onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
      />
      <output data-testid="values">{JSON.stringify(values)}</output>
    </>
  )
}

describe('optional discovered picker (noneLabel)', () => {
  beforeEach(() => {
    asked.length = 0
    failure = null
    loading = false
    candidates = [
      { kind: 'email', suggestedName: 'Office relay', config: { smtpInstanceId: 'relay-1' } },
      { kind: 'email', suggestedName: 'Backup relay', config: { smtpInstanceId: 'relay-2' } },
    ]
  })

  it('offers the default relay as the empty choice and the relays by name', async () => {
    render(<RelayForm initial={{ smtpAddonId: 'smtp', smtpInstanceId: 'relay-1' }} />)
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(1), { timeout: 3000 })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.focus(screen.getByRole('combobox'))
    fireEvent.mouseDown(screen.getByRole('combobox'))
    expect(screen.getByTestId('config-select-smtpInstanceId-option-relay-2')).toHaveTextContent(
      'Backup relay',
    )
    fireEvent.click(screen.getByTestId('config-select-smtpInstanceId-option-'))
    expect(screen.getByTestId('values').textContent).toContain('"smtpInstanceId":""')
  })

  it('names a relay the answered list no longer holds, never as the default', async () => {
    render(<RelayForm initial={{ smtpAddonId: 'smtp', smtpInstanceId: 'relay-gone' }} />)
    await waitFor(
      () => expect(screen.getByRole('combobox')).toHaveDisplayValue('missing relay relay-gone'),
      { timeout: 3000 },
    )
  })

  it('does not call a relay missing while the list has not answered', () => {
    loading = true
    render(<RelayForm initial={{ smtpAddonId: 'smtp', smtpInstanceId: 'relay-1' }} />)
    expect(screen.getByRole('combobox')).toHaveDisplayValue('relay-1')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('config-select-smtpInstanceId-status')).toHaveTextContent('Loading')
  })

  it('stays a picker with only the default when the provider holds no relay', async () => {
    candidates = []
    render(<RelayForm initial={{ smtpAddonId: 'smtp' }} />)
    await waitFor(() => expect(asked).toHaveLength(1), { timeout: 3000 })
    expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', 'Default relay')
    expect(screen.queryByTestId('config-select-smtpInstanceId-status')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
