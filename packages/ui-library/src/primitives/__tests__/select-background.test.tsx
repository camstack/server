/**
 * A Select owns its background and text colour.
 *
 * Regression guard for the dark-mode "invisible options" bug: a caller passed
 * `bg-surface-2` (not a theme token), `cn()` (twMerge) let it evict the
 * primitive's `bg-surface`, the select ended up transparent with near-white
 * text and the native popup painted white. The primitive must keep a themed
 * background whatever the caller passes.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Select } from '../select'

const classesOf = (className?: string): string[] => {
  render(<Select aria-label="codec" className={className} options={[{ value: 'a', label: 'a' }]} />)
  return screen.getByLabelText('codec').className.split(/\s+/)
}

describe('Select — themed background', () => {
  it('has the surface background and foreground text by default', () => {
    const classes = classesOf()
    expect(classes).toContain('bg-surface')
    expect(classes).toContain('text-foreground')
  })

  it.each([
    'bg-surface-2',
    'bg-red-500',
    'bg-transparent',
  ])('keeps them when a caller passes %s', (callerBg) => {
    const classes = classesOf(`${callerBg} min-w-[120px]`)
    expect(classes).toContain('bg-surface')
    expect(classes).not.toContain(callerBg)
    expect(classes).toContain('min-w-[120px]')
  })
})
