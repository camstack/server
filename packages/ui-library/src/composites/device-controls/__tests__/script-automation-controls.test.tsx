// @vitest-environment jsdom
/**
 * Script and Automation controls.
 *
 * Both types were control-kind `dummy` while carrying a cap with real runtime
 * state, so the whole surface rendered as "Controls coming soon". Most of what
 * is asserted here is about NOT claiming more than the provider gives:
 *
 *  - `lastRunAt` / `lastTriggeredAt` of 0 means NEVER RUN, and must not render
 *    as 1 Jan 1970;
 *  - `lastError` is never written by the only provider that creates these
 *    devices, so an empty one renders NOTHING rather than "Last error: —",
 *    which would read as "checked, no errors";
 *  - `isRunning` is never written for an automation, so triggering one must
 *    not apply an optimistic spinner nothing will ever clear.
 *
 * Harness mirrors misc-heroes.test.tsx: `useDeviceCapability` is mocked and
 * dispatches on the caller's own `cap` accessor against a sentinel proxy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

interface CapSlot {
  cap: unknown
  slice: unknown
  available: boolean
}

type CapName = 'scriptRunner' | 'automationControl'

let slots: Record<CapName, CapSlot>

const SENTINELS: Record<CapName, { __cap: CapName }> = {
  scriptRunner: { __cap: 'scriptRunner' },
  automationControl: { __cap: 'automationControl' },
}

function makeFakeProxy(): unknown {
  return {
    scriptRunner: SENTINELS.scriptRunner,
    automationControl: SENTINELS.automationControl,
    state: {
      scriptRunner: { __slice: 'scriptRunner' },
      automationControl: { __slice: 'automationControl' },
    },
  }
}

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: (opts: { cap: (d: unknown) => unknown }) => {
    const picked = opts.cap(makeFakeProxy())
    const tag = (picked as { __cap?: CapName } | undefined)?.__cap
    if (tag !== undefined && slots[tag] !== undefined) {
      const slot = slots[tag]
      return { dev: {}, cap: slot.cap, slice: slot.slice, available: slot.available }
    }
    return { dev: {}, cap: undefined, slice: undefined, available: false }
  },
}))

import {
  AutomationHeroCard,
  AutomationInlineControl,
  lastRunLabel,
  ScriptHeroCard,
  ScriptInlineControl,
} from '../script-automation-controls'

const trpc = {} as never

const scriptCap = { run: vi.fn(), stop: vi.fn() }
const automationCap = { enable: vi.fn(), disable: vi.fn(), trigger: vi.fn() }

function scriptSlice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isRunning: false,
    lastRunAt: 0,
    lastRunSuccess: null,
    lastError: null,
    lastChangedAt: 1,
    ...over,
  }
}

function automationSlice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    isRunning: false,
    lastTriggeredAt: 0,
    lastError: null,
    lastChangedAt: 1,
    ...over,
  }
}

function withScript(slice: Record<string, unknown> | undefined, available = true): void {
  slots = {
    scriptRunner: { cap: slice === undefined ? undefined : scriptCap, slice, available },
    automationControl: { cap: undefined, slice: undefined, available: false },
  }
}

function withAutomation(slice: Record<string, unknown> | undefined, available = true): void {
  slots = {
    scriptRunner: { cap: undefined, slice: undefined, available: false },
    automationControl: { cap: slice === undefined ? undefined : automationCap, slice, available },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('lastRunLabel', () => {
  it('returns NOTHING for 0 — which means never run, not the epoch', () => {
    // "1 Jan 1970" next to a script sends an operator hunting a clock problem
    // that does not exist.
    expect(lastRunLabel(0, 1_800_000_000_000)).toBeNull()
  })

  it('reads in the units a person uses', () => {
    const now = 1_800_000_000_000
    expect(lastRunLabel(now - 10_000, now)).toBe('just now')
    expect(lastRunLabel(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(lastRunLabel(now - 3 * 3_600_000, now)).toBe('3 h ago')
  })

  it('never reports a negative age from a clock that ran ahead', () => {
    const now = 1_800_000_000_000
    expect(lastRunLabel(now + 60_000, now)).toBe('just now')
  })
})

describe('ScriptHeroCard', () => {
  it('renders nothing when the device has no script-runner cap', () => {
    withScript(undefined)
    const { container } = render(<ScriptHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing until the slice has landed — never a half state', () => {
    slots = {
      scriptRunner: { cap: scriptCap, slice: undefined, available: false },
      automationControl: { cap: undefined, slice: undefined, available: false },
    }
    const { container } = render(<ScriptHeroCard trpc={trpc} deviceId={1} features={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('runs an idle script', () => {
    withScript(scriptSlice())
    render(<ScriptHeroCard trpc={trpc} deviceId={7} features={undefined} />)
    const button = screen.getByTestId('script-run')
    expect(button.getAttribute('data-running')).toBe('false')
    fireEvent.click(button)
    expect(scriptCap.run).toHaveBeenCalledWith({})
    expect(scriptCap.stop).not.toHaveBeenCalled()
  })

  it('the SAME button stops a running one', () => {
    // Two buttons would mean a Stop that is disabled almost always — a
    // permanent invitation to click something that does nothing.
    withScript(scriptSlice({ isRunning: true }))
    render(<ScriptHeroCard trpc={trpc} deviceId={7} features={undefined} />)
    const button = screen.getByTestId('script-run')
    expect(button.getAttribute('data-running')).toBe('true')
    fireEvent.click(button)
    expect(scriptCap.stop).toHaveBeenCalledWith({})
    expect(scriptCap.run).not.toHaveBeenCalled()
  })

  it('says "never run" instead of a date, when it never has', () => {
    withScript(scriptSlice())
    render(<ScriptHeroCard trpc={trpc} deviceId={7} features={undefined} />)
    expect(screen.getByTestId('last-run').textContent).toBe('never run')
  })

  it('shows NO error line when there is no error', () => {
    // The HA provider never writes `lastError`, so a permanent "Last error: —"
    // would read as "checked, nothing wrong".
    withScript(scriptSlice())
    render(<ScriptHeroCard trpc={trpc} deviceId={7} features={undefined} />)
    expect(screen.queryByTestId('last-error')).toBeNull()
  })

  it('shows the error when there IS one', () => {
    withScript(scriptSlice({ lastError: 'service unavailable' }))
    render(<ScriptHeroCard trpc={trpc} deviceId={7} features={undefined} />)
    expect(screen.getByTestId('last-error').textContent).toContain('service unavailable')
  })

  it('does not act while the device is unavailable', () => {
    withScript(scriptSlice(), false)
    render(<ScriptHeroCard trpc={trpc} deviceId={7} features={undefined} />)
    fireEvent.click(screen.getByTestId('script-run'))
    expect(scriptCap.run).not.toHaveBeenCalled()
  })
})

describe('ScriptInlineControl', () => {
  it('is the run button plus the last run, nothing taller', () => {
    withScript(scriptSlice({ lastRunAt: Date.now() - 5 * 60_000 }))
    render(<ScriptInlineControl trpc={trpc} deviceId={7} features={undefined} />)
    expect(screen.getByTestId('script-run')).toBeTruthy()
    expect(screen.getByTestId('last-run').textContent).toBe('5 min ago')
  })
})

describe('AutomationHeroCard', () => {
  it('renders nothing without the cap', () => {
    withAutomation(undefined)
    const { container } = render(
      <AutomationHeroCard trpc={trpc} deviceId={1} features={undefined} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('toggles enabled through the right method', () => {
    withAutomation(automationSlice({ enabled: true }))
    render(<AutomationHeroCard trpc={trpc} deviceId={9} features={undefined} />)
    fireEvent.click(screen.getAllByTestId('automation-enabled')[0] as HTMLElement)
    expect(automationCap.disable).toHaveBeenCalledWith({})
    expect(automationCap.enable).not.toHaveBeenCalled()
  })

  it('enables a disabled one', () => {
    withAutomation(automationSlice({ enabled: false }))
    render(<AutomationHeroCard trpc={trpc} deviceId={9} features={undefined} />)
    fireEvent.click(screen.getAllByTestId('automation-enabled')[0] as HTMLElement)
    expect(automationCap.enable).toHaveBeenCalledWith({})
  })

  it('TRIGGERS even while disabled — that is the cap contract', () => {
    // A disabled automation ignores its trigger block but still runs on a
    // manual trigger, which is exactly how an operator tests one before
    // switching it on.
    withAutomation(automationSlice({ enabled: false }))
    render(<AutomationHeroCard trpc={trpc} deviceId={9} features={undefined} />)
    const trigger = screen.getByTestId('automation-trigger')
    expect((trigger as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(trigger)
    expect(automationCap.trigger).toHaveBeenCalledWith({})
  })

  it('says "never triggered" rather than showing the epoch', () => {
    withAutomation(automationSlice())
    render(<AutomationHeroCard trpc={trpc} deviceId={9} features={undefined} />)
    expect(screen.getByTestId('last-run').textContent).toBe('never triggered')
  })

  it('reports enabled state on the state glyph', () => {
    withAutomation(automationSlice({ enabled: true }))
    render(<AutomationHeroCard trpc={trpc} deviceId={9} features={undefined} />)
    expect(screen.getByTestId('automation-state').getAttribute('data-enabled')).toBe('true')
  })
})

describe('AutomationInlineControl', () => {
  it('is the enabled pill plus a trigger', () => {
    withAutomation(automationSlice({ enabled: true }))
    render(<AutomationInlineControl trpc={trpc} deviceId={9} features={undefined} />)
    expect(screen.getByTestId('automation-enabled').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('automation-trigger')).toBeTruthy()
  })
})
