// @vitest-environment jsdom
/**
 * "On motion" is a shell corner: any card whose common carries `motionTrigger`
 * draws it bottom-left, as a text-free icon toggle; absent without the binding.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { offline } from '../__fixtures__/common'
import { plugFixtures } from '../__fixtures__/plug'
import { PlugCard } from '../scenes/plug/PlugCard'
import type { PlugCardActions } from '../scenes/plug/model'
import type { CardMotionTrigger } from '../shell/model'

afterEach(cleanup)

function actions(onMotionTrigger: PlugCardActions['onMotionTrigger']): PlugCardActions {
  return {
    onPower: vi.fn(),
    onTimerStart: vi.fn(),
    onTimerStop: vi.fn(),
    onPowerCycle: vi.fn(),
    ...(onMotionTrigger === undefined ? {} : { onMotionTrigger }),
  }
}

function mount(
  motionTrigger: CardMotionTrigger | null,
  onMotionTrigger: PlugCardActions['onMotionTrigger'] = vi.fn(),
  blocked = false,
): void {
  const base = plugFixtures(0)[0]?.model
  if (base === undefined) throw new Error('no plug fixture')
  const common = blocked ? offline(base.common) : base.common
  render(
    <PlugCard
      model={{ ...base, common: { ...common, motionTrigger } }}
      actions={actions(onMotionTrigger)}
    />,
  )
}

describe('MotionCorner', () => {
  it('is absent when the device binds no motion-trigger', () => {
    mount(null)
    expect(screen.queryByTestId('dc-motion')).toBeNull()
  })

  it('shows the served value, bottom-left, with no text', () => {
    mount({ on: true, pending: false })
    const corner = screen.getByTestId('dc-motion')
    expect(corner.getAttribute('aria-pressed')).toBe('true')
    expect(corner.getAttribute('data-corner')).toBe('bl')
    expect(corner.getAttribute('aria-label')).toBe('On motion')
    expect(corner.textContent).toBe('')
  })

  it('sends the served value flipped, once per tap', () => {
    const onMotionTrigger = vi.fn()
    mount({ on: true, pending: false }, onMotionTrigger)
    fireEvent.click(screen.getByTestId('dc-motion'))
    expect(onMotionTrigger).toHaveBeenCalledTimes(1)
    expect(onMotionTrigger).toHaveBeenCalledWith(false)
  })

  it('is disabled and busy while a change is in flight', () => {
    const onMotionTrigger = vi.fn()
    mount({ on: false, pending: true }, onMotionTrigger)
    const corner = screen.getByTestId('dc-motion')
    expect(corner.hasAttribute('disabled')).toBe(true)
    expect(corner.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(corner)
    expect(onMotionTrigger).not.toHaveBeenCalled()
  })

  it('is disabled when the card is blocked', () => {
    mount({ on: true, pending: false }, vi.fn(), true)
    expect(screen.getByTestId('dc-motion').hasAttribute('disabled')).toBe(true)
  })

  it('leaves the battery beside it, not under it', () => {
    mount({ on: true, pending: false })
    expect(screen.getByTestId('dc-battery').className).toContain('left-11')
  })
})
