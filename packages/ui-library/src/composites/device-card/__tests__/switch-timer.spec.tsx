// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lightFixtures } from '../__fixtures__/light'
import { plugFixtures } from '../__fixtures__/plug'
import { sirenFixtures } from '../__fixtures__/siren'
import { QUICK_RUN_SAVE_DEBOUNCE_MS } from '../../device-controls/timed-run-quick-model'
import { LightCard } from '../scenes/light/LightCard'
import { PlugCard } from '../scenes/plug/PlugCard'
import { SirenCard } from '../scenes/siren/SirenCard'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const NOW = 1_700_000_000_000

function timerActions() {
  return {
    onTimerStart: vi.fn().mockResolvedValue({ ok: true, activeUntil: NOW }),
    onTimerSave: vi.fn().mockResolvedValue(undefined),
    onTimerStop: vi.fn().mockResolvedValue(undefined),
  }
}

describe('the switch timer on a card is the shared compact control', () => {
  it('saves a value edited on the card and runs with it', () => {
    vi.useFakeTimers()
    const plug = plugFixtures(NOW).find(
      (f) => f.model.timer !== null && f.model.timer.endsAt === null,
    )
    if (plug === undefined) throw new Error('no idle plug with a timer')
    const timer = timerActions()
    render(
      <PlugCard
        model={plug.model}
        actions={{ onPower: vi.fn(), onPowerCycle: vi.fn(), ...timer }}
      />,
    )
    fireEvent.change(screen.getByTestId('dc-plug-timer-duration-minutes'), {
      target: { value: '20' },
    })
    act(() => vi.advanceTimersByTime(QUICK_RUN_SAVE_DEBOUNCE_MS))
    expect(timer.onTimerSave).toHaveBeenCalledTimes(1)
    expect(timer.onTimerSave).toHaveBeenCalledWith(20)
    fireEvent.click(screen.getByTestId('dc-plug-timer-run'))
    expect(timer.onTimerStart).toHaveBeenCalledWith(20)
  })

  it('shows on a light card whose device has the timed run', () => {
    const light = lightFixtures()[0]
    if (light === undefined) throw new Error('no light fixture')
    const timer = timerActions()
    render(
      <LightCard
        model={light.model}
        actions={{
          onPower: vi.fn(),
          onBrightness: vi.fn(),
          onColor: vi.fn(),
          onWhite: vi.fn(),
          ...timer,
        }}
      />,
    )
    expect(screen.queryByTestId('dc-plug-timer-run')).not.toBeNull()
  })

  it('shows on a siren card whose device has the timed run', () => {
    const siren = sirenFixtures()[0]
    if (siren === undefined) throw new Error('no siren fixture')
    const timer = timerActions()
    render(
      <SirenCard model={siren.model} actions={{ onTrigger: vi.fn(), onStop: vi.fn(), ...timer }} />,
    )
    expect(screen.queryByTestId('dc-plug-timer-run')).not.toBeNull()
  })

  it('draws nothing on a light without the timed run', () => {
    const light = lightFixtures()[0]
    if (light === undefined) throw new Error('no light fixture')
    render(
      <LightCard
        model={{ ...light.model, timer: null }}
        actions={{
          onPower: vi.fn(),
          onBrightness: vi.fn(),
          onColor: vi.fn(),
          onWhite: vi.fn(),
          ...timerActions(),
        }}
      />,
    )
    expect(screen.queryByTestId('dc-plug-timer-run')).toBeNull()
  })
})
