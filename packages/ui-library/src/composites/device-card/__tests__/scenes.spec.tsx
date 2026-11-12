// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIMATE_FIXTURES } from '../__fixtures__/climate'
import { offline, readOnly } from '../__fixtures__/common'
import { plugFixtures } from '../__fixtures__/plug'
import { ambientLayers } from '../illustrations/AmbientFx'
import { ClimateCard } from '../scenes/climate/ClimateCard'
import type { ClimateCardActions } from '../scenes/climate/model'
import { PlugCard } from '../scenes/plug/PlugCard'
import type { PlugCardActions } from '../scenes/plug/model'

afterEach(cleanup)

const NOW = 1_700_000_000_000

function plugActions(): PlugCardActions {
  return {
    onPower: vi.fn(),
    onTimerStart: vi.fn(),
    onTimerStop: vi.fn(),
    onSupply: vi.fn(),
    onConsumableReset: vi.fn(),
    onRemoteKey: vi.fn(),
  }
}

function climateActions(): ClimateCardActions {
  return {
    onPower: vi.fn(),
    onTarget: vi.fn(),
    onMode: vi.fn(),
    onFan: vi.fn(),
    onPreset: vi.fn(),
    onHeatCool: vi.fn(),
    onSwing: vi.fn(),
    onSwingHorizontal: vi.fn(),
    onRange: vi.fn(),
    onSupply: vi.fn(),
    onConsumableReset: vi.fn(),
    onRemoteKey: vi.fn(),
  }
}

/** The anatomy every card of the mockup carries, whatever its type. */
const SHELL = [
  'dc-top',
  'dc-state',
  'dc-power',
  'dc-battery',
  'dc-remote',
  'dc-name',
  'dc-scene',
  'dc-bottom-line',
  'dc-supply',
  'dc-consumables',
] as const

const present = (id: string): boolean => screen.queryByTestId(id) !== null

/** The optional blocks of the climate scene, per mockup variant. */
const CLIMATE_BLOCKS = [
  'dc-climate-humidity',
  'dc-climate-mode',
  'dc-climate-fan',
  'dc-climate-preset',
  'dc-climate-heatcool',
  'dc-climate-swing',
] as const

interface ClimateVariant {
  readonly blocks: readonly (typeof CLIMATE_BLOCKS)[number][]
  readonly fx: string | null
  readonly role: string
}

const CLIMATE_VARIANTS: Readonly<Record<string, ClimateVariant>> = {
  'climate-ac-cool': {
    blocks: ['dc-climate-humidity', 'dc-climate-mode', 'dc-climate-fan', 'dc-climate-swing'],
    fx: 'wash-down air',
    role: 'ac',
  },
  'climate-thermostat-heat': {
    blocks: ['dc-climate-humidity', 'dc-climate-mode', 'dc-climate-preset'],
    fx: 'wash-up particles-rise',
    role: 'thermostat',
  },
  'climate-floor-heat': { blocks: [], fx: 'wash-up serpentine wisps-floor', role: 'floor' },
  'climate-radiator-window': { blocks: [], fx: 'draft', role: 'radiator' },
  'climate-heater-heat': { blocks: [], fx: 'wash-up heater wisps-unit', role: 'heater' },
  'climate-ac-infrared': {
    blocks: ['dc-climate-mode', 'dc-climate-fan', 'dc-climate-swing'],
    fx: null,
    role: 'ac',
  },
  'climate-floor-idle': { blocks: [], fx: 'breathe serpentine', role: 'floor' },
  'climate-circuit-heat': {
    blocks: ['dc-climate-mode', 'dc-climate-preset', 'dc-climate-heatcool'],
    fx: 'wash-up pipe',
    role: 'hpcircuit',
  },
  'climate-ac-off': {
    blocks: ['dc-climate-humidity', 'dc-climate-mode', 'dc-climate-fan', 'dc-climate-swing'],
    fx: null,
    role: 'ac',
  },
}

describe('plug scene — the zones of each mockup variant', () => {
  it('covers both variants of the mockup page', () => {
    expect(plugFixtures(NOW).map((f) => `${f.id}:${f.orientation}`)).toEqual([
      'plug-on-running:vertical',
      'plug-off:horizontal',
    ])
  })

  for (const fixture of plugFixtures(NOW)) {
    it(`${fixture.id}: shell anatomy, power and the timed run`, () => {
      render(
        <PlugCard
          model={fixture.model}
          actions={plugActions()}
          orientation={fixture.orientation}
        />,
      )
      const card = screen.getByTestId('device-card')
      expect(card.getAttribute('data-card-kind')).toBe('plug')
      expect(card.getAttribute('data-orientation')).toBe(fixture.orientation)
      for (const id of SHELL) expect(present(id), id).toBe(true)
      expect(present('dc-plug-power')).toBe(true)
      // A running cycle shows its countdown and Stop; otherwise the picker and Start.
      const running = fixture.model.timer?.endsAt !== null
      expect(present('dc-plug-timer')).toBe(!running)
      expect(present('dc-plug-timer-stop')).toBe(running)
      expect(present('dc-plug-timer-start')).toBe(!running)
      expect(present('dc-reason')).toBe(false)
    })
  }

  it('draws no timer when the switch declares no timed run', () => {
    const [fixture] = plugFixtures(NOW)
    if (fixture === undefined) throw new Error('no plug fixture')
    render(<PlugCard model={{ ...fixture.model, timer: null }} actions={plugActions()} />)
    for (const id of ['dc-plug-timer', 'dc-plug-timer-start', 'dc-plug-timer-stop']) {
      expect(present(id), id).toBe(false)
    }
    expect(present('dc-plug-power')).toBe(true)
  })

  it('draws no corner, chip or button the device does not declare', () => {
    const [fixture] = plugFixtures(NOW)
    if (fixture === undefined) throw new Error('no plug fixture')
    const bare = {
      ...fixture.model.common,
      power: null,
      battery: null,
      supply: null,
      consumables: [],
      remote: [],
    }
    render(<PlugCard model={{ ...fixture.model, common: bare }} actions={plugActions()} />)
    for (const id of ['dc-power', 'dc-battery', 'dc-remote', 'dc-supply', 'dc-consumables']) {
      expect(present(id), id).toBe(false)
    }
  })

  it('turns the plug off from the power button', () => {
    const [fixture] = plugFixtures(NOW)
    if (fixture === undefined) throw new Error('no plug fixture')
    const actions = plugActions()
    render(<PlugCard model={fixture.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-plug-power'))
    expect(actions.onPower).toHaveBeenCalledWith(false)
  })
})

describe('climate scene — the zones of each mockup variant', () => {
  const vertical = CLIMATE_FIXTURES.filter((f) => f.orientation === 'vertical')

  it('has a variant row for every vertical fixture, and the horizontal one', () => {
    expect(vertical.map((f) => f.id).sort()).toEqual(Object.keys(CLIMATE_VARIANTS).sort())
    expect(CLIMATE_FIXTURES.filter((f) => f.orientation === 'horizontal').map((f) => f.id)).toEqual(
      ['climate-ac-cool-horizontal'],
    )
  })

  for (const fixture of CLIMATE_FIXTURES) {
    const variant = CLIMATE_VARIANTS[fixture.id.replace(/-horizontal$/, '')]
    it(`${fixture.id}: only the blocks its variant declares`, () => {
      if (variant === undefined) throw new Error(`no variant for ${fixture.id}`)
      render(
        <ClimateCard
          model={fixture.model}
          actions={climateActions()}
          orientation={fixture.orientation}
        />,
      )
      const card = screen.getByTestId('device-card')
      expect(card.getAttribute('data-card-kind')).toBe('climate')
      expect(card.getAttribute('data-orientation')).toBe(fixture.orientation)
      for (const id of SHELL) expect(present(id), id).toBe(true)
      expect(present('dc-climate-dial')).toBe(true)
      expect(present('dc-climate-target')).toBe(true)
      expect(present('dc-climate-power')).toBe(true)
      for (const id of CLIMATE_BLOCKS) expect(present(id), id).toBe(variant.blocks.includes(id))
      expect(card.querySelector('[data-fx]')?.getAttribute('data-fx') ?? null).toBe(variant.fx)
      expect(card.querySelector('[data-role]')?.getAttribute('data-role')).toBe(variant.role)
      expect(ambientLayers(fixture.model.role, fixture.model.activity).join(' ')).toBe(
        variant.fx ?? '',
      )
    })
  }
})

describe('shell behaviour shared by every scene', () => {
  const fixture = plugFixtures(NOW)[0]
  if (fixture === undefined) throw new Error('no plug fixture')

  it('an offline device says it once, in the top line, and commands nothing', () => {
    const actions = plugActions()
    const common = offline(fixture.model.common)
    render(<PlugCard model={{ ...fixture.model, common }} actions={actions} />)
    expect(screen.getAllByText(common.offlineLabel ?? 'Offline')).toHaveLength(1)
    expect(screen.queryByTestId('dc-reason')).toBeNull()
    const power = screen.getByTestId('dc-plug-power')
    expect(power).toHaveProperty('disabled', true)
    fireEvent.click(power)
    expect(actions.onPower).not.toHaveBeenCalled()
  })

  it('a read-only viewer sees the state and commands nothing', () => {
    const actions = plugActions()
    render(
      <PlugCard
        model={{ ...fixture.model, common: readOnly(fixture.model.common) }}
        actions={actions}
      />,
    )
    expect(present('dc-reason')).toBe(true)
    expect(screen.getByTestId('dc-plug-power')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('dc-plug-timer-stop')).toHaveProperty('disabled', true)
  })

  it('opens the consumables popover and resets an item', () => {
    const actions = plugActions()
    render(<PlugCard model={fixture.model} actions={actions} />)
    expect(present('dc-consumables-pop')).toBe(false)
    fireEvent.click(within(screen.getByTestId('dc-consumables')).getAllByRole('button')[0]!)
    const pop = screen.getByTestId('dc-consumables-pop')
    fireEvent.click(within(pop).getByRole('button', { name: 'Sostituite' }))
    expect(actions.onConsumableReset).toHaveBeenCalledWith('battery')
  })

  it('opens the history view from the state corner and comes back', () => {
    render(<PlugCard model={fixture.model} actions={plugActions()} />)
    fireEvent.click(screen.getByTestId('dc-state'))
    expect(screen.getByTestId('device-card').getAttribute('data-view')).toBe('history')
    expect(present('dc-history')).toBe(true)
    expect(present('dc-scene')).toBe(false)
    fireEvent.click(screen.getByTestId('dc-back'))
    expect(present('dc-scene')).toBe(true)
  })

  it('sends a remote key from the remote view', () => {
    const actions = plugActions()
    render(<PlugCard model={fixture.model} actions={actions} />)
    fireEvent.click(screen.getByTestId('dc-remote'))
    const view = screen.getByTestId('dc-remote-view')
    fireEvent.click(within(view).getByRole('button', { name: /30 min/ }))
    expect(actions.onRemoteKey).toHaveBeenCalledWith('run30')
  })
})

describe('a host that names the device itself', () => {
  it('drops the name from the plug and the climate card and keeps the rest of the shell', () => {
    const plug = plugFixtures(NOW)[0]
    const climate = CLIMATE_FIXTURES[0]
    if (plug === undefined || climate === undefined) throw new Error('no fixtures')
    render(<PlugCard model={plug.model} actions={plugActions()} showName={false} />)
    expect(present('dc-name')).toBe(false)
    expect(present('dc-top')).toBe(true)
    expect(present('dc-scene')).toBe(true)
    cleanup()
    render(<ClimateCard model={climate.model} actions={climateActions()} showName={false} />)
    expect(present('dc-name')).toBe(false)
    expect(present('dc-scene')).toBe(true)
  })
})
