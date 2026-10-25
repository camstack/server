import { describe, expect, it } from 'vitest'
import { darkColors, defaultTheme, lightColors } from '../defaults'
import { themeToRootCss } from '../theme-to-root-css'

describe('themeToRootCss', () => {
  const css = themeToRootCss(defaultTheme)

  it('emits the light palette on :root and the dark one under prefers-color-scheme', () => {
    const [root, dark] = css.split('@media (prefers-color-scheme:dark)')
    expect(root).toContain(`--color-primary:${lightColors.primary}`)
    expect(root).not.toContain(darkColors.primary)
    expect(dark).toContain(`--color-primary:${darkColors.primary}`)
    expect(dark).toContain(`--color-background:${darkColors.background}`)
  })

  it('uses the variable names themeToCss uses', () => {
    expect(css).toContain('--color-primary-foreground:')
    expect(css).toContain('--color-foreground-muted:')
    expect(css).toContain(`--radius-xl:${defaultTheme.radius.xl}px`)
    expect(css).toContain(`--spacing-2xl:${defaultTheme.spacing['2xl']}px`)
  })

  it('leaves the provider colours out and carries no Tailwind directive', () => {
    expect(css).not.toContain('provider')
    expect(css).not.toContain('@theme')
  })
})
