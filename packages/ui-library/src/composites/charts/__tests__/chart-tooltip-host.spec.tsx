import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChartTooltipSpec } from '../chart-tooltip-host'
import { UPlotHost } from '../uplot-host'

function spec(): ChartTooltipSpec {
  return {
    xMin: 0,
    xMax: 100,
    stops: [0, 50, 100],
    resolve: (dataX) => ({
      heading: `t ${String(dataX)}`,
      lines: [{ id: 'temp', label: 'Temperature', value: '20 °C' }],
      liveText: `t ${String(dataX)}, Temperature 20 °C`,
    }),
  }
}

function mount(): HTMLElement {
  const { container } = render(
    <UPlotHost
      optionsKey="k"
      buildOptions={() => ({ series: [{}] })}
      data={[
        [0, 50, 100],
        [1, 2, 3],
      ]}
      height={40}
      tooltip={spec()}
      kind="lines"
      label="Temperature"
    />,
  )
  const el = container.querySelector('[data-chart-shell]')
  if (!(el instanceof HTMLElement)) throw new Error('chart shell missing')
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 40,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  })
  return el
}

function send(el: HTMLElement, event: PointerEvent): void {
  act(() => {
    el.dispatchEvent(event)
  })
}

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointerleave',
  pointerType: 'mouse' | 'touch',
  clientX: number,
  clientY: number,
): PointerEvent {
  return new window.PointerEvent(type, {
    pointerType,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  })
}

function textOf(role: 'tooltip'): string {
  return screen.getByRole(role).textContent ?? ''
}

describe('chart tooltip host', () => {
  it('arrow keys move the selection and expose it to screen readers', () => {
    const el = mount()
    el.focus()
    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(textOf('tooltip')).toContain('t 0')
    expect(textOf('tooltip')).toContain('20 °C')
    const live = document.querySelector('[data-chart-tooltip-live]')
    expect(live?.getAttribute('aria-live')).toBe('polite')
    expect(live?.textContent).toContain('Temperature 20 °C')
    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(textOf('tooltip')).toContain('t 50')
    fireEvent.keyDown(el, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('a tap selects and a second tap hides', () => {
    const el = mount()
    send(el, pointer('pointerdown', 'touch', 50, 10))
    send(el, pointer('pointerup', 'touch', 50, 10))
    expect(textOf('tooltip')).toContain('t 50')
    send(el, pointer('pointerdown', 'touch', 50, 10))
    send(el, pointer('pointerup', 'touch', 50, 10))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('a horizontal scrub locks scrolling', () => {
    const el = mount()
    send(el, pointer('pointerdown', 'touch', 10, 10))
    const move = pointer('pointermove', 'touch', 40, 12)
    send(el, move)
    expect(move.defaultPrevented).toBe(true)
    expect(textOf('tooltip')).toContain('20 °C')
  })

  it('a gesture that starts vertical does not select and does not lock scroll', () => {
    const el = mount()
    send(el, pointer('pointerdown', 'touch', 10, 10))
    const vertical = pointer('pointermove', 'touch', 12, 40)
    send(el, vertical)
    send(el, pointer('pointerup', 'touch', 12, 40))
    expect(vertical.defaultPrevented).toBe(false)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('mouse hover follows the point and leaving hides it; a tap outside hides a pin', () => {
    const el = mount()
    send(el, pointer('pointermove', 'mouse', 40, 10))
    expect(textOf('tooltip')).toContain('t 40')
    send(el, pointer('pointerleave', 'mouse', 0, 0))
    expect(screen.queryByRole('tooltip')).toBeNull()

    send(el, pointer('pointerdown', 'touch', 50, 10))
    send(el, pointer('pointerup', 'touch', 50, 10))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    send(document.body, pointer('pointerdown', 'touch', 1, 1))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
