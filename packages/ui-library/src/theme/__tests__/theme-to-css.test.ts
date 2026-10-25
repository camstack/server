import { themeToCss } from '../theme-to-css'
import { defaultTheme } from '../defaults'

describe('themeToCss', () => {
  it('generates .dark block with dark color tokens', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('.dark {')
    expect(css).toContain('--color-primary: #f59e42')
    expect(css).toContain('--color-background: #0c0a09')
  })

  it('generates .light block with light color tokens', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('.light {')
    expect(css).toContain('--color-primary: #e67e22')
    expect(css).toContain('--color-background: #fafaf9')
  })

  it('generates @theme block with shared tokens', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('@theme {')
    expect(css).toContain('--color-provider-onvif: #3b82f6')
    expect(css).toContain('--radius-sm: 4px')
  })

  it('includes spacing tokens in @theme block', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('--spacing-xs: 2px')
    expect(css).toContain('--spacing-md: 8px')
  })

  it('includes all radius tokens in @theme block', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('--radius-md: 6px')
    expect(css).toContain('--radius-lg: 8px')
    expect(css).toContain('--radius-xl: 12px')
  })

  it('generates @media prefers-color-scheme fallback blocks', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('@media (prefers-color-scheme: light)')
  })

  it('converts camelCase color keys to kebab-case CSS vars', () => {
    const css = themeToCss(defaultTheme)
    expect(css).toContain('--color-primary-foreground:')
    expect(css).toContain('--color-background-elevated:')
    expect(css).toContain('--color-surface-hover:')
    expect(css).toContain('--color-foreground-muted:')
  })
})
