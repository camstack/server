// @vitest-environment jsdom
/**
 * The Wave-E connected cards against a fake hub: which method a command
 * reaches. A button presses through `button`, a script runs and stops through
 * `script-runner`, an automation switches and triggers through
 * `automation-control`, an update installs through `update`, a control sets
 * its value through `control`, and a notifier sends its test through
 * `notifier`. A method the binding does not implement draws no control.
 */
import {
  type AutomationControlStatus,
  type ControlStatus,
  DeviceType,
  type NotifierStatus,
  type ScriptRunnerStatus,
  type UpdateStatus,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import {
  ConnectedAutomationCard,
  ConnectedButtonCard,
  ConnectedScriptCard,
} from '../connected/ConnectedActionCards'
import { ConnectedControlCard } from '../connected/ConnectedControlCard'
import { ConnectedNotifierCard } from '../connected/ConnectedNotifierCard'
import { ConnectedUpdateCard } from '../connected/ConnectedUpdateCard'

const hub = vi.hoisted(() => ({
  button: { press: vi.fn() },
  script: { run: vi.fn(), stop: vi.fn() },
  automation: { enable: vi.fn(), disable: vi.fn(), trigger: vi.fn() },
  update: { installUpdate: vi.fn() },
  control: { setValue: vi.fn() },
  notifier: { send: vi.fn() },
  scriptSlice: null as ScriptRunnerStatus | null,
  automationSlice: null as AutomationControlStatus | null,
  updateSlice: null as UpdateStatus | null,
  controlSlice: null as ControlStatus | null,
  notifierSlice: null as NotifierStatus | null,
  pressable: true,
  missing: [] as readonly string[],
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
  useOptionalSystem: () => null,
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    button: hub.pressable ? hub.button : undefined,
    scriptRunner: hub.scriptSlice === null ? undefined : hub.script,
    automationControl: hub.automationSlice === null ? undefined : hub.automation,
    update: hub.updateSlice === null ? undefined : hub.update,
    control: hub.controlSlice === null ? undefined : hub.control,
    notifier: hub.notifierSlice === null ? undefined : hub.notifier,
    state: {
      scriptRunner: hub.scriptSlice ?? undefined,
      automationControl: hub.automationSlice ?? undefined,
      update: hub.updateSlice ?? undefined,
      control: hub.controlSlice ?? undefined,
      notifier: hub.notifierSlice ?? undefined,
    },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', async () => {
  const { useCommandNotice } = await import('../connected/use-command-notice')
  return {
    useCardCommon: () => {
      const { notice, fail, succeed } = useCommandNotice()
      const common = plugFixtures(0)[0]?.model.common
      if (common === undefined) throw new Error('no plug fixture')
      return {
        common: {
          ...common,
          power: null,
          consumables: null,
          supply: null,
          remote: null,
          battery: null,
          notice,
        },
        actions: {},
        deviceType: DeviceType.Generic,
        role: null,
        features: [],
        implements: (_cap: string, method: string): boolean => !hub.missing.includes(method),
        fail,
        succeed,
      }
    },
  }
})

const allFns = (): readonly ReturnType<typeof vi.fn>[] => [
  ...Object.values(hub.button),
  ...Object.values(hub.script),
  ...Object.values(hub.automation),
  ...Object.values(hub.update),
  ...Object.values(hub.control),
  ...Object.values(hub.notifier),
]

beforeEach(() => {
  for (const fn of allFns()) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.scriptSlice = null
  hub.automationSlice = null
  hub.updateSlice = null
  hub.controlSlice = null
  hub.notifierSlice = null
  hub.pressable = true
  hub.missing = []
})
afterEach(cleanup)

const SCRIPT: ScriptRunnerStatus = {
  isRunning: false,
  lastRunAt: 0,
  lastRunSuccess: null,
  lastError: null,
  lastChangedAt: 0,
}
const AUTOMATION: AutomationControlStatus = {
  enabled: true,
  isRunning: false,
  lastTriggeredAt: 0,
  lastError: null,
  lastChangedAt: 0,
}

describe('a button', () => {
  it('presses through button', async () => {
    render(<ConnectedButtonCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-button-press'))
    await vi.waitFor(() => expect(hub.button.press).toHaveBeenCalledWith({}))
  })
})

describe('a script', () => {
  it('runs, and stops while it runs', async () => {
    hub.scriptSlice = SCRIPT
    render(<ConnectedScriptCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-script-run'))
    await vi.waitFor(() => expect(hub.script.run).toHaveBeenCalledWith({}))
    cleanup()
    hub.scriptSlice = { ...SCRIPT, isRunning: true }
    render(<ConnectedScriptCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-script-stop'))
    await vi.waitFor(() => expect(hub.script.stop).toHaveBeenCalledWith({}))
  })

  it('draws no Stop when the binding cannot stop', () => {
    hub.scriptSlice = { ...SCRIPT, isRunning: true }
    hub.missing = ['stop']
    render(<ConnectedScriptCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-script-stop')).toBeNull()
  })
})

describe('an automation', () => {
  it('disables and triggers through automation-control', async () => {
    hub.automationSlice = AUTOMATION
    render(<ConnectedAutomationCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-automation-enabled'))
    await vi.waitFor(() => expect(hub.automation.disable).toHaveBeenCalledWith({}))
    expect(hub.automation.enable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-automation-trigger'))
    await vi.waitFor(() => expect(hub.automation.trigger).toHaveBeenCalledWith({}))
  })

  it('enables a disabled one', async () => {
    hub.automationSlice = { ...AUTOMATION, enabled: false }
    render(<ConnectedAutomationCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-automation-enabled'))
    await vi.waitFor(() => expect(hub.automation.enable).toHaveBeenCalledWith({}))
  })
})

describe('an update', () => {
  it('installs through update when a newer version is offered', async () => {
    hub.updateSlice = {
      currentVersion: '1.0',
      availableVersion: '1.1',
      updatable: true,
      state: null,
      inProgress: false,
    }
    render(<ConnectedUpdateCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-update-install'))
    await vi.waitFor(() => expect(hub.update.installUpdate).toHaveBeenCalledWith({}))
  })

  it('offers no install when the binding cannot install', () => {
    hub.updateSlice = {
      currentVersion: '1.0',
      availableVersion: '1.1',
      updatable: true,
      state: null,
      inProgress: false,
    }
    hub.missing = ['installUpdate']
    render(<ConnectedUpdateCard deviceId={1} optimistic={false} />)
    expect(screen.queryByTestId('dc-update-install')).toBeNull()
  })
})

describe('a control', () => {
  it('steps a number through control.setValue', async () => {
    hub.controlSlice = {
      kind: 'numeric',
      value: 55,
      options: [],
      lastChangedAt: 0,
      min: 30,
      max: 80,
      step: 5,
    }
    render(<ConnectedControlCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-control-up'))
    await vi.waitFor(() =>
      expect(hub.control.setValue).toHaveBeenCalledWith({
        control: { kind: 'numeric', value: 60 },
      }),
    )
  })

  it('saves a text through control.setValue', async () => {
    hub.controlSlice = { kind: 'text', value: 'Bentornati', options: [], lastChangedAt: 0 }
    render(<ConnectedControlCard deviceId={1} optimistic={false} />)
    fireEvent.change(screen.getByTestId('dc-control-entry'), { target: { value: 'Ciao' } })
    fireEvent.click(screen.getByTestId('dc-control-entry-save'))
    await vi.waitFor(() =>
      expect(hub.control.setValue).toHaveBeenCalledWith({
        control: { kind: 'text', value: 'Ciao' },
      }),
    )
  })
})

describe('a notifier', () => {
  it('sends its test through notifier.send', async () => {
    hub.notifierSlice = {
      lastSentAt: 0,
      lastError: null,
      queueDepth: 0,
      supports: { image: false, priority: false, data: false, actions: false, recipients: false },
    }
    render(<ConnectedNotifierCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-notifier-test'))
    await vi.waitFor(() =>
      expect(hub.notifier.send).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'CamStack' }),
      ),
    )
  })
})
