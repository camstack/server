// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from '../badge'

describe('Badge', () => {
  it('keeps the legacy tint for existing callers', () => {
    render(<Badge variant="success">ok</Badge>)
    const el = screen.getByText('ok')
    expect(el.className).toContain('bg-success/15')
    expect(el.className).not.toContain('bg-success-fill')
  })

  it.each([
    ['success', 'bg-success-fill', 'text-success-on'],
    ['warning', 'bg-warning-fill', 'text-warning-on'],
    ['danger', 'bg-danger-fill', 'text-danger-on'],
    ['info', 'bg-info-fill', 'text-info-on'],
    ['primary', 'bg-primary-fill', 'text-primary-on'],
    ['neutral', 'bg-neutral-fill', 'text-neutral-on'],
  ] as const)('fill %s uses its fill + on tokens', (variant, bg, fg) => {
    render(
      <Badge variant={variant} style="fill">
        x
      </Badge>,
    )
    const el = screen.getByText('x')
    expect(el.className).toContain(bg)
    expect(el.className).toContain(fg)
  })

  it('sm size and a leading icon', () => {
    render(
      <Badge style="fill" size="sm" icon={<svg data-testid="i" />}>
        s
      </Badge>,
    )
    const el = screen.getByText('s')
    expect(el.className).toContain('text-[10px]')
    expect(el.className).toContain('gap-1')
    expect(screen.getByTestId('i')).not.toBeNull()
  })

  it('dashed applies only to an outline', () => {
    render(
      <Badge style="outline" dashed>
        o
      </Badge>,
    )
    render(
      <Badge style="fill" dashed>
        f
      </Badge>,
    )
    expect(screen.getByText('o').className).toContain('border-dashed')
    expect(screen.getByText('f').className).not.toContain('border-dashed')
  })
})
