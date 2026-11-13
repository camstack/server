/**
 * `SourceSelector` with `intent: 'action'` — the device modal asking what a
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
import { describe, expect, it, vi } from 'vitest'
import {
  withDeviceSearchHub,
  type SearchHubDevice,
} from '../../../../../test-setup/device-search-hub'
import '../../../../../i18n'
import { SourceSelector } from '../SourceSelector'
import type { ActionPickDraft } from '../SourceSelectorAction'

vi.mock('../../../../../../../ui-library/src/contexts/system-context.js', () => ({
  useSystem: () => ({
    trpcClient: {
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
]

const CAPS = new Map<number, readonly string[]>([
  [1, ['cover']],
  [2, ['switch']],
  [3, ['pet-feeder', 'switch']],
  [4, ['switch']],
])

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useDeviceManagerListAll: () => ({ status: 'success', data: fleet }),
}))

vi.mock('../../../../device-do-action/use-device-bound-caps', () => ({
  useDevicesBoundCaps: () => ({ status: 'success', data: CAPS, error: null }),
}))

function Harness(props: {
  readonly initial?: ActionPickDraft
  readonly round?: readonly number[]
  readonly excludeTypes?: readonly string[]
}) {
  const [draft, setDraft] = useState<ActionPickDraft>(
    props.initial ?? { target: null, actionId: null },
  )
  return (
    <>
      <output data-testid="draft">{JSON.stringify(draft)}</output>
      <SourceSelector
        kind="action"
        intent="action"
        value={draft}
        onChange={setDraft}
        allowTriggerDevice
        {...(props.round === undefined ? {} : { roundDevices: props.round })}
        {...(props.excludeTypes === undefined ? {} : { excludeTypes: props.excludeTypes })}
      />
    </>
  )
}

const SEARCH_FLEET: readonly SearchHubDevice[] = [
  { id: 1, name: 'Kitchen blind', type: DeviceType.Cover, location: 'Kitchen', caps: ['cover'] },
  { id: 2, name: 'Lamp', type: DeviceType.Light, location: 'Kitchen', caps: ['switch'] },
  {
    id: 3,
    name: 'Feeder',
    type: DeviceType.PetFeeder,
    location: 'Kitchen',
    caps: ['pet-feeder', 'switch'],
  },
  { id: 4, name: 'Hall hub', type: DeviceType.Container, location: 'Kitchen', caps: ['switch'] },
]

function mount(props: Parameters<typeof Harness>[0] = {}) {
  render(withDeviceSearchHub(<Harness {...props} />, SEARCH_FLEET))
}

const draft = (): ActionPickDraft => JSON.parse(screen.getByTestId('draft').textContent ?? '{}')
const commands = () =>
  within(screen.getByTestId('action-command-column'))
    .queryAllByRole('radio')
    .map((r) => r.getAttribute('data-testid')?.replace('action-row-', ''))
const pickDevice = async (name: RegExp): Promise<void> => {
  fireEvent.click(await screen.findByRole('checkbox', { name }))
}

describe('SourceSelector intent action — by device', () => {
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
    expect(draft()).toEqual({ target: { kind: 'devices', ids: [1] }, actionId: 'cover.open' })
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
    mount({ initial: { target: { kind: 'devices', ids: [3] }, actionId: 'petFeeder.feed' } })
    await pickDevice(/Lamp/)
    expect(draft()).toEqual({ target: { kind: 'devices', ids: [3, 2] }, actionId: null })
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

describe('SourceSelector intent action — by action', () => {
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
    fireEvent.change(screen.getByTestId('action-search'), { target: { value: 'open' } })
    expect(commands()).toContain('cover.open')
    expect(commands()).not.toContain('petFeeder.feed')
  })

  it('switching mode keeps a compatible pick', () => {
    mount({ initial: { target: { kind: 'devices', ids: [2, 3] }, actionId: 'switch.on' } })
    fireEvent.click(screen.getByRole('radio', { name: /By action|byAction/ }))
    expect(draft()).toEqual({ target: { kind: 'devices', ids: [2, 3] }, actionId: 'switch.on' })
    fireEvent.click(screen.getByRole('radio', { name: /By device|byDevice/ }))
    expect(draft()).toEqual({ target: { kind: 'devices', ids: [2, 3] }, actionId: 'switch.on' })
  })
})

function cleanupAndMount(props: Parameters<typeof Harness>[0]): void {
  cleanup()
  mount(props)
}
