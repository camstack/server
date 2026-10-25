/**
 * Every Button variant must set its OWN text colour.
 *
 * Regression guard for the light-mode invisible-text class of bug: the
 * `outline` variant shipped without a `text-*` class, so it inherited whatever
 * the ancestor happened to define. With `color-scheme: dark` pinned on :root
 * that inherited colour was the UA white, and an outline button on a light
 * surface rendered white-on-white — the label was in the DOM, laid out (the
 * button was sized to it) and invisible.
 *
 * The rule is stated positively so a NEW variant added without a colour fails
 * here rather than in a screenshot months later.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button, type ButtonProps } from '../button'

const VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'outline'] as const

/** A class that resolves to a theme-aware (or explicit) text colour. */
const TEXT_COLOUR = /(^|\s)text-(foreground|primary-foreground|foreground-muted|white)(\s|$)/

describe('Button — every variant declares a text colour', () => {
  for (const variant of VARIANTS) {
    it(`\`${variant}\` sets its own text colour`, () => {
      render(<Button variant={variant satisfies ButtonProps['variant']}>Label</Button>)
      const className = screen.getByRole('button').className
      expect(className).toMatch(TEXT_COLOUR)
    })
  }

  it('renders the label as text so a colour bug is the only way to lose it', () => {
    render(<Button variant="outline">Everything supported</Button>)
    expect(screen.getByRole('button').textContent).toBe('Everything supported')
  })
})
