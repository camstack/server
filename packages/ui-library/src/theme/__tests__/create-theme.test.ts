import { createTheme } from '../create-theme'
import { defaultTheme } from '../defaults'

describe('createTheme', () => {
  it('returns default theme when called with no args', () => {
    const theme = createTheme()
    expect(theme).toEqual(defaultTheme)
  })

  it('deep merges color overrides', () => {
    const theme = createTheme({
      colors: { dark: { primary: '#ff0000' } },
    })
    expect(theme.colors.dark.primary).toBe('#ff0000')
    expect(theme.colors.dark.background).toBe(defaultTheme.colors.dark.background)
    expect(theme.colors.light.primary).toBe(defaultTheme.colors.light.primary)
  })

  it('deep merges spacing overrides', () => {
    const theme = createTheme({ spacing: { xs: 4 } })
    expect(theme.spacing.xs).toBe(4)
    expect(theme.spacing.sm).toBe(defaultTheme.spacing.sm)
  })

  it('does not mutate the default theme', () => {
    const originalPrimary = defaultTheme.colors.dark.primary
    createTheme({ colors: { dark: { primary: '#ff0000' } } })
    expect(defaultTheme.colors.dark.primary).toBe(originalPrimary)
  })

  it('returns a new object reference', () => {
    const theme = createTheme()
    expect(theme).not.toBe(defaultTheme)
  })
})
