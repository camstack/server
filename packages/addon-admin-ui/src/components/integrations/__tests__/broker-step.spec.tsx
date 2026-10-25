/**
 * BrokerStep — the integration wizard's "existing-or-new broker" gate for
 * `device-adoption` addons (Approach A). The operator either picks an
 * already-registered broker of the required `kind`, or creates a fresh one
 * on-the-fly via `broker.add`; either path resolves to a single `brokerId`
 * the wizard stores as the integration's only setting.
 *
 * Partial-mock of `@camstack/ui-library`: only the broker hooks are stubbed
 * so the real `BrokerForm` / `FormBuilder` keep their implementations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const mockAdd = vi.fn()
const mockReset = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useBrokerList: () => ({
      data: [
        {
          id: 'ha_001',
          addonId: 'provider-homeassistant',
          name: 'Home',
          kind: 'home-assistant',
          status: 'connected',
          info: {},
          lastCheckedAt: null,
          error: null,
        },
        {
          id: 'mqtt_001',
          addonId: 'mqtt-broker',
          name: 'Mosquitto',
          kind: 'mqtt',
          status: 'connected',
          info: {},
          lastCheckedAt: null,
          error: null,
        },
      ],
      isLoading: false,
    }),
    useBrokerListProviders: () => ({
      data: [
        {
          addonId: 'provider-homeassistant',
          kinds: [{ kind: 'home-assistant', label: 'Home Assistant' }],
        },
        { addonId: 'mqtt-broker', kinds: [{ kind: 'mqtt', label: 'MQTT' }] },
      ],
    }),
    useBrokerAdd: () => ({
      mutateAsync: mockAdd,
      isPending: false,
      isError: false,
      reset: mockReset,
    }),
    // BrokerForm (embedded in the create-new path) reads these — provide a
    // minimal one-field schema and a no-op Test mutation so it renders.
    useBrokerGetSettingsSchema: () => ({
      data: {
        sections: [
          {
            id: 'conn',
            title: 'Conn',
            columns: 1,
            fields: [
              {
                type: 'text',
                key: 'baseUrl',
                label: 'HA base URL',
                placeholder: 'http://homeassistant:8123',
              },
            ],
          },
        ],
      },
      isLoading: false,
    }),
    useBrokerTestSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  }
})

import { BrokerStep } from '../BrokerStep'

// Minimal fetch stub so AlexaLoginStep (rendered for kind='alexa') doesn't
// throw on absent global fetch.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BrokerStep', () => {
  it('lists existing brokers of the required kind and emits the chosen brokerId', () => {
    const onResolved = vi.fn()
    render(<BrokerStep kind="home-assistant" onResolved={onResolved} onBack={() => {}} />)

    // Only HA brokers of the required kind are offered (mqtt is filtered out).
    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.queryByText('Mosquitto')).toBeNull()

    fireEvent.click(screen.getByText('Home'))
    fireEvent.click(screen.getByRole('button', { name: /use this broker/i }))
    expect(onResolved).toHaveBeenCalledWith('ha_001')
  })

  it('creates a new broker via broker.add and resolves the returned id', async () => {
    mockAdd.mockReset()
    mockAdd.mockResolvedValue({ id: 'ha_777' })
    const onResolved = vi.fn()
    render(<BrokerStep kind="home-assistant" onResolved={onResolved} onBack={() => {}} />)

    // Switch to the create-new path; the name input + BrokerForm render.
    fireEvent.click(screen.getByRole('button', { name: /create new/i }))
    const nameInput = screen.getByPlaceholderText('My Home Assistant')
    fireEvent.change(nameInput, { target: { value: 'My HA' } })

    // Fill the BrokerForm's one schema-driven field.
    const baseUrl = screen.getByPlaceholderText('http://homeassistant:8123')
    fireEvent.change(baseUrl, { target: { value: 'http://ha:8123' } })

    // Submit the BrokerForm (its primary action carries the "Create broker" label).
    fireEvent.click(screen.getByRole('button', { name: /create broker/i }))

    // `handleCreate` awaits `add.mutateAsync` then `onResolved` — flush.
    await Promise.resolve()
    await Promise.resolve()

    expect(mockAdd).toHaveBeenCalledWith({
      kind: 'home-assistant',
      name: 'My HA',
      settings: { baseUrl: 'http://ha:8123' },
      addonId: 'provider-homeassistant',
    })
    expect(onResolved).toHaveBeenCalledWith('ha_777')
  })

  it('renders AlexaLoginStep by default for kind="alexa" (not the broker list)', () => {
    render(<BrokerStep kind="alexa" onResolved={vi.fn()} onBack={() => {}} />)

    // The mode-toggle shows the "Login interactively" tab (alexa-specific).
    expect(screen.getByRole('button', { name: /login interactively/i })).toBeTruthy()

    // The default mode is alexa-login, so AlexaLoginStep is rendered.
    // Its idle state shows "Start login".
    expect(screen.getByRole('button', { name: /start login/i })).toBeTruthy()

    // The broker list (which would show "Use this broker") is NOT rendered yet.
    expect(screen.queryByRole('button', { name: /use this broker/i })).toBeNull()
  })
})
