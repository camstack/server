/**
 * The action picker — the device modal asking what a
 * device should DO:
 *  - one device lists its own commands, grouped by cap;
 *  - several devices list only the commands ALL of them offer;
 *  - "the device that triggered this run" is a target of its own;
 *  - By action lists the fleet's commands and then only the devices offering
 *    the picked one; switching mode keeps a compatible pick.
 */
import { DeviceType } from '@camstack/types'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withDeviceSearchHub, type SearchHubDevice } from '../../../test-setup/device-search-hub'
import '../../../i18n'
import { ActionPicker, type ActionPickDraft } from '../ActionPicker'

const sirenRead = vi.hoisted(() => ({
  playChoices: (): Promise<unknown> => Promise.resolve([]),
}))

const switchRead = vi.hoisted(() => ({
  options: (): Promise<unknown> =>
    Promise.resolve({ supportsSetState: true, supportsPowerCycle: false }),
}))

vi.mock('../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
      siren: { getPlayChoices: { query: () => sirenRead.playChoices() } },
      switch: { getOptions: { query: () => switchRead.options() } },
      deviceManager: { listAll: { query: () => new Promise(() => undefined) } },
      addons: { list: { query: () => new Promise(() => undefined) } },
      integrations: { list: { query: () => new Promise(() => undefined) } },
    },
  }),
}))

function fleetRow(id: number, name: string, type: string) {
  return {
    id,
    name,
    addonId: 'provider-homeassistant',
    stableId: `dev.${id}`,
    location: 'Kitchen',
    type,
    parentDeviceId: null,
  }
}

const fleet = [
  fleetRow(1, 'Kitchen blind', 'cover'),
  fleetRow(2, 'Lamp', 'light'),
  fleetRow(3, 'Feeder', 'pet-feeder'),
  fleetRow(4, 'Hall hub', 'container'),
  fleetRow(5, 'Fan', 'fan'),
  fleetRow(6, 'Fan 2', 'fan'),
  fleetRow(7, 'Yard siren', 'siren'),
]

const CAPS = new Map<number, readonly string[]>([
  [1, ['cover']],
  [2, ['switch']],
  [3, ['pet-feeder', 'switch']],
  [4, ['switch']],
  [5, ['fan-control']],
  [6, ['fan-control']],
  [7, ['siren']],
])

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceManagerListAll: () => ({ status: 'success', data: fleet }),
}))

vi.mock('../use-device-bound-caps', () => ({
  useDevicesBoundCaps: () => ({ status: 'success', data: CAPS, error: null }),
}))

beforeEach(() => {
  try {
    localStorage.clear()
  } catch {
    // no storage in this environment: nothing was remembered either
  }
})

function Harness(props: {
  readonly initial?: ActionPickDraft
  readonly round?: readonly number[]
  readonly excludeTypes?: readonly string[]
  readonly multiple?: boolean
  readonly withArgs?: boolean
}) {
  const [draft, setDraft] = useState<ActionPickDraft>(
    props.initial ?? { target: null, actionId: null },
  )
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft)}</output>
      <ActionPicker
        value={draft}
        onChange={setDraft}
        allowTriggerDevice
        {...(props.multiple === undefined ? {} : { multiple: props.multiple })}
        {...(props.withArgs === true ? { args: <p data-testid="args-slot">args</p> } : {})}
        {...(props.round === undefined ? {} : { roundDevices: props.round })}
        {...(props.excludeTypes === undefined ? {} : { excludeTypes: props.excludeTypes })}
      />
    </>
  )
}

const SEARCH_FLEET: readonly SearchHubDevice[] = [
  {
    id: 1,
    name: 'Kitchen blind',
    type: DeviceType.Cover,
    location: 'Kitchen',
    caps: ['cover'],
  },
  {
    id: 2,
    name: 'Lamp',
    type: DeviceType.Light,
    location: 'Kitchen',
    caps: ['switch'],
  },
  {
    id: 3,
    name: 'Feeder',
    type: DeviceType.PetFeeder,
    location: 'Kitchen',
    caps: ['pet-feeder', 'switch'],
  },
  {
    id: 4,
    name: 'Hall hub',
    type: DeviceType.Container,
    location: 'Kitchen',
    caps: ['switch'],
  },
  {
    id: 5,
    name: 'Fan',
    type: DeviceType.Fan,
    location: 'Kitchen',
    caps: ['fan-control'],
  },
  {
    id: 6,
    name: 'Fan 2',
    type: DeviceType.Fan,
    location: 'Kitchen',
    caps: ['fan-control'],
  },
  {
    id: 7,
    name: 'Yard siren',
    type: DeviceType.Siren,
    location: 'Kitchen',
    caps: ['siren'],
  },
]

function mount(props: Parameters<typeof Harness>[0] = {}) {
  render(withDeviceSearchHub(<Harness {...props} />, SEARCH_FLEET))
}

const draft = (): ActionPickDraft => JSON.parse(screen.getByTestId('draft').textContent ?? '{}')
const commands = () =>
  within(screen.getByTestId('action-command-column'))
    .queryAllByRole('radio')
    .map((r) => r.getAttribute('data-testid')?.replace('action-row-', ''))
const pickDevice = async (name: RegExp | string): Promise<void> => {
  fireEvent.click(await screen.findByRole('checkbox', { name }))
}

describe('ActionPicker — by device', () => {
  it('one device lists its own commands, grouped under the cap title', async () => {
    mount()
    await pickDevice(/Kitchen blind/)
    const ids = commands()
    expect(ids).toContain('cover.open')
    expect(ids.some((id) => id?.startsWith('switch.'))).toBe(false)
    expect(
      within(screen.getByTestId('action-command-column')).getAllByRole('heading').length,
    ).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('action-row-cover.open'))
    expect(draft()).toEqual({
      target: { kind: 'devices', ids: [1] },
      actionId: 'cover.open',
    })
  })

  it('several devices list only the commands all of them offer', async () => {
    mount()
    await pickDevice(/Lamp/)
    await pickDevice(/Feeder/)
    const ids = commands()
    expect(ids).toContain('switch.on')
    expect(ids).not.toContain('petFeeder.feed')
    await pickDevice(/Kitchen blind/)
    expect(commands()).toEqual([])
    expect(screen.getByTestId('action-none')).toBeTruthy()
  })

  it('a device that drops the picked command drops the command, not the device', async () => {
    mount({
      initial: {
        target: { kind: 'devices', ids: [3] },
        actionId: 'petFeeder.feed',
      },
    })
    await pickDevice(/Lamp/)
    expect(draft()).toEqual({
      target: { kind: 'devices', ids: [3, 2] },
      actionId: null,
    })
  })

  it('never offers an excluded type: a container is not a pick (D356)', async () => {
    mount({ excludeTypes: ['container'] })
    expect(await screen.findByRole('checkbox', { name: /Lamp/ })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Hall hub/ })).toBeNull()
  })

  it('offers the device that triggered this run as a target of its own', () => {
    mount()
    fireEvent.click(screen.getByTestId('action-target-var-deviceId'))
    expect(draft().target).toEqual({ kind: 'var', name: 'deviceId' })
    // Unknown until it runs: every command the fleet offers.
    expect(commands()).toEqual(
      expect.arrayContaining(['cover.open', 'switch.on', 'petFeeder.feed']),
    )
  })

  it('offers the device of the round only inside a loop, with the loop’s common commands', () => {
    mount()
    expect(screen.queryByTestId('action-target-var-item')).toBeNull()
    cleanupAndMount({ round: [2, 3] })
    fireEvent.click(screen.getByTestId('action-target-var-item'))
    expect(commands()).toContain('switch.on')
    expect(commands()).not.toContain('petFeeder.feed')
  })
})

describe('ActionPicker — by action', () => {
  it('lists the fleet’s commands, then only the devices that offer the picked one', async () => {
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    expect(commands()).toEqual(
      expect.arrayContaining(['cover.open', 'switch.on', 'petFeeder.feed']),
    )
    fireEvent.click(screen.getByTestId('action-row-petFeeder.feed'))
    const column = within(screen.getByTestId('action-device-column'))
    await waitFor(() => {
      expect(column.getByRole('checkbox', { name: /Feeder/ })).toBeTruthy()
      expect(column.queryByRole('checkbox', { name: /Lamp/ })).toBeNull()
      expect(column.queryByRole('checkbox', { name: /Kitchen blind/ })).toBeNull()
      expect(column.queryByRole('checkbox', { name: /Hall hub/ })).toBeNull()
    })
  })

  it('searches the commands', () => {
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    fireEvent.change(screen.getByTestId('action-search'), {
      target: { value: 'open' },
    })
    expect(commands()).toContain('cover.open')
    expect(commands()).not.toContain('petFeeder.feed')
  })

  it('switching mode keeps a compatible pick', () => {
    mount({
      initial: {
        target: { kind: 'devices', ids: [2, 3] },
        actionId: 'switch.on',
      },
    })
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    expect(draft()).toEqual({
      target: { kind: 'devices', ids: [2, 3] },
      actionId: 'switch.on',
    })
    fireEvent.click(screen.getByRole('radio', { name: /By device|byDevice/ }))
    expect(draft()).toEqual({
      target: { kind: 'devices', ids: [2, 3] },
      actionId: 'switch.on',
    })
  })
})

describe('ActionPicker — behaviours the command step relies on', () => {
  it('draws the host\u2019s args under the columns only once a target and a command are picked', async () => {
    mount({ withArgs: true })
    expect(screen.queryByTestId('action-args')).toBeNull()
    await pickDevice(/Kitchen blind/)
    expect(screen.queryByTestId('action-args')).toBeNull()
    fireEvent.click(screen.getByTestId('action-row-cover.open'))
    expect(within(screen.getByTestId('action-args')).getByTestId('args-slot')).toBeTruthy()
  })

  it('a single-device surface replaces the device instead of adding one', async () => {
    mount({ multiple: false })
    fireEvent.click(await screen.findByRole('option', { name: /Lamp/ }))
    fireEvent.click(await screen.findByRole('option', { name: /Feeder/ }))
    expect(draft().target).toEqual({ kind: 'devices', ids: [3] })
  })

  it('a command whose argument one device answers is not offered to several devices', async () => {
    mount()
    await pickDevice('Fan')
    expect(commands()).toContain('fan.preset')
    await pickDevice('Fan 2')
    expect(commands()).not.toContain('fan.preset')
  })

  it('by action, a dynamic command keeps one device: the last one picked', async () => {
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    fireEvent.click(screen.getByTestId('action-row-fan.preset'))
    await pickDevice('Fan')
    await pickDevice('Fan 2')
    expect(draft()).toEqual({
      target: { kind: 'devices', ids: [6] },
      actionId: 'fan.preset',
    })
  })

  it('by action, devices wait for a command and the trigger device waits with them', () => {
    mount()
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    expect(
      screen.getByTestId('action-device-column').querySelector('input[type="checkbox"]'),
    ).toBeNull()
    expect(screen.queryByTestId('action-target-var-deviceId')).toBeNull()
    fireEvent.click(screen.getByTestId('action-row-switch.on'))
    expect(screen.getByTestId('action-target-var-deviceId')).toBeTruthy()
  })

  it('by action, a picked device that does not offer the command leaves the target', () => {
    mount({
      initial: { target: { kind: 'devices', ids: [1, 2] }, actionId: null },
    })
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    fireEvent.click(screen.getByTestId('action-row-switch.on'))
    expect(draft()).toEqual({
      target: { kind: 'devices', ids: [2] },
      actionId: 'switch.on',
    })
  })
})

function cleanupAndMount(props: Parameters<typeof Harness>[0]): void {
  cleanup()
  mount(props)
}

describe('ActionPicker — a command whose argument the device answers', () => {
  it('a siren that answers no play counts is not offered "sound N times"', async () => {
    sirenRead.playChoices = () => Promise.resolve([])
    mount()
    await pickDevice(/Yard siren/)
    await waitFor(() => expect(commands()).not.toContain('siren.triggerPlays'))
    expect(commands()).toContain('siren.trigger')
  })

  it('a siren whose play counts could not be read is still offered it', async () => {
    sirenRead.playChoices = () => Promise.reject(new Error('timeout'))
    mount()
    await pickDevice(/Yard siren/)
    await waitFor(() => expect(commands()).toContain('siren.trigger'))
    expect(commands()).toContain('siren.triggerPlays')
  })

  it('a siren with play counts is offered it', async () => {
    sirenRead.playChoices = () => Promise.resolve([1, 2, 3])
    mount()
    await pickDevice(/Yard siren/)
    await waitFor(() => expect(commands()).toContain('siren.triggerPlays'))
  })
})

describe('ActionPicker — a switch that only reports (D1058)', () => {
  const ON_OFF = ['switch.on', 'switch.off', 'switch.toggle']

  it('a switch that ANSWERED supportsSetState: false is offered no on, off or toggle', async () => {
    switchRead.options = () =>
      Promise.resolve({ supportsSetState: false, supportsPowerCycle: true })
    mount()
    await pickDevice(/^Lamp/)
    await waitFor(() => expect(commands()).not.toContain('switch.on'))
    for (const id of ON_OFF) expect(commands()).not.toContain(id)
  })

  it('a switch whose options could not be read keeps on, off and toggle', async () => {
    switchRead.options = () => Promise.reject(new Error('no getOptions'))
    mount()
    await pickDevice(/^Lamp/)
    await waitFor(() => expect(commands()).toContain('switch.on'))
    for (const id of ON_OFF) expect(commands()).toContain(id)
  })

  it('a settable switch keeps on, off and toggle', async () => {
    switchRead.options = () =>
      Promise.resolve({ supportsSetState: true, supportsPowerCycle: false })
    mount()
    await pickDevice(/^Lamp/)
    await waitFor(() => expect(commands()).toContain('switch.on'))
    for (const id of ON_OFF) expect(commands()).toContain(id)
  })
})
