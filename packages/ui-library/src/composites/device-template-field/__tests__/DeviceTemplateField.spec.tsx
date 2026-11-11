import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactElement, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Verdict =
  | { ok: true; aliases: { alias: string; deviceId: number | null; allowed: boolean }[] }
  | { ok: false; refusal: { reason: string; message: string } }
const hub: { check: Verdict } = { check: { ok: true, aliases: [] } }

vi.mock('../../../contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: { deviceManager: { listSiteZones: { query: () => new Promise(() => undefined) } } },
  }),
}))

/** The insert dialog's device column is the picker panel over `deviceManager.search`. */
const STUFA_ITEM = {
  id: 1,
  name: 'Stufa veranda',
  type: 'sensor',
  location: null,
  integrationId: null,
  integrationLabel: null,
  online: true,
  disabled: false,
  compatible: true,
  values: [],
}
const searchAnswer = {
  items: [STUFA_ITEM],
  nextCursor: null,
  total: 1,
  compatibleTotal: 1,
  fleetTotal: 1,
  hiddenIncompatible: 0,
  facets: { locations: [], integrations: [], types: [] },
  suggested: [],
  missingIds: [],
}
vi.mock('../../../trpc-react', () => ({
  trpc: {
    deviceManager: {
      search: {
        useInfiniteQuery: () => ({
          data: { pages: [searchAnswer] },
          isPending: false,
          isError: false,
          isFetching: false,
          isFetchingNextPage: false,
          hasNextPage: false,
          fetchNextPage: () => undefined,
          refetch: () => undefined,
        }),
      },
    },
  },
}))

vi.mock('../../../generated/system-hooks', () => ({
  useDeviceManagerSearch: () => ({ data: searchAnswer, isError: false, isPending: false }),
  useDeviceManagerListAll: () => ({
    status: 'success',
    data: [
      {
        id: 1,
        name: 'Stufa veranda',
        alias: 'stufa',
        type: 'sensor',
        location: null,
        parentDeviceId: null,
      },
    ],
  }),
  useDeviceManagerListDeviceIdsByCaps: () => ({ status: 'success', data: [] }),
  useDeviceManagerGetWireableFields: () => ({
    status: 'success',
    data: {
      caps: [
        {
          cap: 'temperature-sensor',
          fields: [
            { path: 'temperature', kind: 'number' },
            { path: 'label', kind: 'string' },
          ],
        },
        {
          cap: 'climate',
          fields: [
            { path: 'temperature', kind: 'number' },
            { path: 'mode', kind: 'enum' },
          ],
        },
      ],
    },
  }),
  useDeviceStateGetSnapshot: () => ({
    status: 'success',
    data: {
      'temperature-sensor': { temperature: 21, label: 'veranda' },
      climate: { mode: 'heat' },
    },
  }),
  useDeviceManagerCheckDeviceTemplates: (_input: unknown, opts?: { enabled?: boolean }) => ({
    status: 'success',
    data: opts?.enabled === false ? undefined : { results: [hub.check] },
  }),
  useDeviceManagerRenderDeviceTemplates: () => ({
    status: 'success',
    data: { results: [{ ok: true, text: 'Now 21.0 C', trace: [] }] },
  }),
}))

const { DeviceTemplateField } = await import('../DeviceTemplateField')
type FieldProps = Parameters<typeof DeviceTemplateField>[0]

function renderUi(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function Harness(props: Partial<FieldProps> & { readonly initial: string }) {
  const [value, setValue] = useState(props.initial)
  return (
    <>
      <DeviceTemplateField label="Text" {...props} value={value} onChange={setValue} />
      <output data-testid="stored">{value}</output>
    </>
  )
}
const stored = () => screen.getByTestId('stored').textContent

/** Device → value → Insert, through the real picker. */
function pickAndInsert(rowTestId: string) {
  fireEvent.click(screen.getByTestId('device-template-field-insert'))
  fireEvent.click(screen.getByRole('option', { name: /Stufa veranda/ }))
  fireEvent.click(screen.getByTestId(rowTestId))
  fireEvent.click(screen.getByTestId('device-template-insert-confirm'))
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close() {
    this.open = false
  }
  hub.check = { ok: true, aliases: [] }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

describe('DeviceTemplateField', () => {
  it('shows device references as chips with the device name as tooltip, keeping the text', () => {
    renderUi(<Harness initial="Now {{ stufa.temperature | round(1) }} degrees" />)
    const chips = screen.getByTestId('device-template-field-chips')
    expect(chips.textContent).toContain('Now ')
    expect(chips.textContent).toContain('stufa.temperature')
    expect(chips.textContent).toContain(' degrees')
    expect(chips.querySelector('[title="Stufa veranda"]')).not.toBeNull()
  })

  it('plain text with no device reference stays a plain input', () => {
    renderUi(<Harness initial="hello" />)
    expect(screen.queryByTestId('device-template-field-chips')).toBeNull()
    expect(screen.getByTestId('device-template-field-input')).toBeTruthy()
  })

  it('removing a chip removes exactly that token from the stored text', () => {
    renderUi(<Harness initial="a {{ stufa.temperature }} b" />)
    fireEvent.click(screen.getByRole('button', { name: /Remove stufa.temperature/ }))
    expect(stored()).toBe('a  b')
  })

  it('a number slot offers only number fields', () => {
    renderUi(<Harness initial="" accepts="number" />)
    fireEvent.click(screen.getByTestId('device-template-field-insert'))
    fireEvent.click(screen.getByRole('option', { name: /Stufa veranda/ }))
    expect(screen.getByTestId('device-value-temperature-sensor.temperature')).toBeTruthy()
    expect(screen.getByTestId('device-value-climate.temperature')).toBeTruthy()
    expect(screen.queryByTestId('device-value-temperature-sensor.label')).toBeNull()
    expect(screen.queryByTestId('device-value-climate.mode')).toBeNull()
  })

  it('inserts the short token when the field name is unique on the device', () => {
    renderUi(<Harness initial="Mode: " />)
    pickAndInsert('device-value-climate.mode')
    expect(stored()).toBe('Mode: {{ stufa.mode }}')
  })

  it('spells the cap out when the field name is ambiguous', () => {
    renderUi(<Harness initial="" />)
    pickAndInsert('device-value-climate.temperature')
    expect(stored()).toBe('{{ stufa.climate.temperature }}')
  })

  it('shows the hub refusal under the field', () => {
    hub.check = { ok: false, refusal: { reason: 'syntax', message: 'unexpected end of template' } }
    renderUi(<Harness initial="{{ stufa.temperature | }}" />)
    expect(screen.getByTestId('device-template-field-refusal').textContent).toBe(
      'unexpected end of template',
    )
  })

  it('names a device alias nobody has', () => {
    hub.check = { ok: true, aliases: [{ alias: 'ghost', deviceId: null, allowed: false }] }
    renderUi(<Harness initial="{{ ghost.temperature }}" />)
    expect(screen.getByTestId('device-template-field-unknown').textContent).toContain('ghost')
  })

  it('previews the rendered text when asked and the template is vetted', () => {
    hub.check = { ok: true, aliases: [{ alias: 'stufa', deviceId: 1, allowed: true }] }
    renderUi(<Harness initial="{{ stufa.temperature }}" preview />)
    expect(screen.getByTestId('device-template-field-preview').textContent).toContain('Now 21.0 C')
  })

  it('writes the copyable camera alias when the picked device is the one the text is for', () => {
    renderUi(<Harness initial="" thisDevice={{ deviceId: 1 }} />)
    pickAndInsert('device-value-climate.mode')
    expect(stored()).toBe('{{ camera.mode }}')
  })

  it('without a device the text is for, the same pick writes the device alias', () => {
    renderUi(<Harness initial="" />)
    pickAndInsert('device-value-climate.mode')
    expect(stored()).toBe('{{ stufa.mode }}')
  })
})
