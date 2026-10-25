// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import {
  ControlColumn,
  ValueReadout,
  FILL,
  RIGHT,
  CENTER,
  Stepper,
  SlideToggle,
  ArcKnob,
} from '../atoms'

describe('ControlColumn', () => {
  it('applies the reduced control-column width and right-aligns natural-width content', () => {
    const { getByTestId } = render(
      <ControlColumn align={RIGHT} data-testid="col">
        x
      </ControlColumn>,
    )
    const el = getByTestId('col')
    expect(el.className).toContain('w-[140px]')
    expect(el.className).toContain('justify-end')
    expect(el.className).not.toContain('[&>*]:w-full')
  })
  it('center keeps natural width but centers the content (table view)', () => {
    const { getByTestId } = render(
      <ControlColumn align={CENTER} data-testid="col">
        x
      </ControlColumn>,
    )
    const el = getByTestId('col')
    expect(el.className).toContain('w-[140px]')
    expect(el.className).toContain('justify-center')
    expect(el.className).not.toContain('justify-end')
    expect(el.className).not.toContain('[&>*]:w-full')
  })
  it('fill stretches the primary (last-child) control to the full column width, still flush right', () => {
    const { getByTestId } = render(
      <ControlColumn align={FILL} data-testid="col">
        x
      </ControlColumn>,
    )
    const el = getByTestId('col')
    expect(el.className).toContain('w-[140px]')
    expect(el.className).toContain('justify-end')
    // Only the primary control fills — a leading affordance keeps natural width.
    expect(el.className).toContain('[&>*:last-child]:w-full')
  })
})

describe('ValueReadout', () => {
  it('renders value with the unit as an inline muted suffix', () => {
    const { container } = render(<ValueReadout value="60" unit="s" />)
    expect(container.textContent).toBe('60s')
    expect(container.querySelector('[data-unit]')?.textContent).toBe('s')
  })
})

describe('Stepper', () => {
  it('renders value+unit inline, fires onDelta on −/+', () => {
    let d = 0
    const { getByText, container } = render(
      <Stepper
        value={60}
        unit="s"
        onDelta={(n) => {
          d = n
        }}
      />,
    )
    expect(container.textContent).toContain('60')
    expect(container.querySelector('[data-unit]')?.textContent).toBe('s')
    fireEvent.click(getByText('+'))
    expect(d).toBe(1)
    fireEvent.click(getByText('−'))
    expect(d).toBe(-1)
  })
})

describe('SlideToggle (safety gesture)', () => {
  it('exposes the target label + calls onConfirm only after a slide', () => {
    let confirmed = false
    const { getByTestId } = render(
      <SlideToggle
        on={false}
        targetLabel="lock"
        onConfirm={() => {
          confirmed = true
        }}
      />,
    )
    fireEvent.click(getByTestId('slide-thumb')) // a tap must NOT confirm
    expect(confirmed).toBe(false)
  })

  it('calls onConfirm after a slide past threshold', () => {
    let confirmed = false
    const { getByTestId } = render(
      <SlideToggle
        on={false}
        targetLabel="lock"
        onConfirm={() => {
          confirmed = true
        }}
      />,
    )
    const thumb = getByTestId('slide-thumb')
    fireEvent.pointerDown(thumb, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(thumb, { clientX: 60, pointerId: 1 })
    fireEvent.pointerUp(thumb, { clientX: 60, pointerId: 1 })
    expect(confirmed).toBe(true)
  })
})

describe('ArcKnob', () => {
  /** A 176px gauge centred at (88, 88) at screen origin. */
  function stubRootRect(root: HTMLElement): void {
    root.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 176,
      height: 176,
      right: 176,
      bottom: 176,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  }

  it('without onDragFraction: display-only, no grab cursor', () => {
    const { container } = render(<ArcKnob fraction={0.5} color="#fff" />)
    const root = container.querySelector<HTMLElement>('.absolute.inset-0')
    const knob = root?.firstElementChild as HTMLElement
    expect(knob).toBeTruthy()
    expect(knob.className).not.toContain('cursor-grab')
  })

  it('with onDragFraction: drag straight up from centre → fraction ≈ 0.5', () => {
    let reported = -1
    const { container } = render(
      <ArcKnob
        fraction={0.5}
        color="#fff"
        onDragFraction={(f) => {
          reported = f
        }}
      />,
    )
    const root = container.querySelector<HTMLElement>('.absolute.inset-0') as HTMLElement
    stubRootRect(root)
    const knob = root.firstElementChild as HTMLElement
    expect(knob.className).toContain('cursor-grab')

    fireEvent.pointerDown(knob, { pointerId: 1, clientX: 88, clientY: 88 })
    // Pointer straight UP from centre (north): atan2(-1, 0) = -90° → fraction 0.5
    fireEvent.pointerMove(knob, { pointerId: 1, clientX: 88, clientY: 0 })
    expect(reported).toBeGreaterThan(0.45)
    expect(reported).toBeLessThan(0.55)
  })

  it('with onDragFraction: drag to SW (arc start) → fraction ≈ 0', () => {
    let reported = -1
    const { container } = render(
      <ArcKnob
        fraction={0.5}
        color="#fff"
        onDragFraction={(f) => {
          reported = f
        }}
      />,
    )
    const root = container.querySelector<HTMLElement>('.absolute.inset-0') as HTMLElement
    stubRootRect(root)
    const knob = root.firstElementChild as HTMLElement

    fireEvent.pointerDown(knob, { pointerId: 1, clientX: 88, clientY: 88 })
    // SW of centre: dx<0, dy>0 → atan2(+, -) = 135° → arc start → fraction 0
    fireEvent.pointerMove(knob, { pointerId: 1, clientX: 0, clientY: 176 })
    expect(reported).toBeGreaterThanOrEqual(0)
    expect(reported).toBeLessThan(0.05)
  })

  it('with onDragFraction: a gap angle nearer the SW start snaps to fraction 0', () => {
    let reported = -1
    const { container } = render(
      <ArcKnob
        fraction={0.5}
        color="#fff"
        onDragFraction={(f) => {
          reported = f
        }}
      />,
    )
    const root = container.querySelector<HTMLElement>('.absolute.inset-0') as HTMLElement
    stubRootRect(root)
    const knob = root.firstElementChild as HTMLElement

    fireEvent.pointerDown(knob, { pointerId: 1, clientX: 88, clientY: 88 })
    // Bottom-gap angle 125° (fromStart 350°, past the 315° midpoint) → nearer the
    // SW arc start → snaps to 0. point = centre + r·(cos125°, sin125°).
    const rad = (125 * Math.PI) / 180
    fireEvent.pointerMove(knob, {
      pointerId: 1,
      clientX: 88 + 80 * Math.cos(rad),
      clientY: 88 + 80 * Math.sin(rad),
    })
    expect(reported).toBe(0)
  })

  it('with onDragFraction: a gap angle nearer the SE end snaps to fraction 1', () => {
    let reported = -1
    const { container } = render(
      <ArcKnob
        fraction={0.5}
        color="#fff"
        onDragFraction={(f) => {
          reported = f
        }}
      />,
    )
    const root = container.querySelector<HTMLElement>('.absolute.inset-0') as HTMLElement
    stubRootRect(root)
    const knob = root.firstElementChild as HTMLElement

    fireEvent.pointerDown(knob, { pointerId: 1, clientX: 88, clientY: 88 })
    // Bottom-gap angle 55° (fromStart 280°, before the 315° midpoint) → nearer the
    // SE arc end → snaps to 1. point = centre + r·(cos55°, sin55°).
    const rad = (55 * Math.PI) / 180
    fireEvent.pointerMove(knob, {
      pointerId: 1,
      clientX: 88 + 80 * Math.cos(rad),
      clientY: 88 + 80 * Math.sin(rad),
    })
    expect(reported).toBe(1)
  })

  it('without onDragFraction: a pointer move does not throw or report', () => {
    const { container } = render(<ArcKnob fraction={0.5} color="#fff" />)
    const root = container.querySelector<HTMLElement>('.absolute.inset-0') as HTMLElement
    const knob = root.firstElementChild as HTMLElement
    // No handlers attached → firing pointer events is a no-op (does not throw).
    expect(() => {
      fireEvent.pointerDown(knob, { pointerId: 1, clientX: 88, clientY: 88 })
      fireEvent.pointerMove(knob, { pointerId: 1, clientX: 88, clientY: 0 })
    }).not.toThrow()
  })
})
