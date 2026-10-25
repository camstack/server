import type { CamStackColorTokens, CamStackTheme } from './types'
import { camelToKebab } from './theme-to-css'

function colorDeclarations(colors: CamStackColorTokens): string {
  return Object.entries(colors)
    .filter(([key]) => key !== 'provider')
    .map(([key, value]) => `--color-${camelToKebab(key)}:${String(value)}`)
    .join(';')
}

function scaleDeclarations(prefix: string, scale: Readonly<Record<string, number>>): string {
  return Object.entries(scale)
    .map(([key, value]) => `--${prefix}-${key}:${value}px`)
    .join(';')
}

/**
 * The theme as plain CSS custom properties on `:root`, with no Tailwind
 * directive: light colours by default, dark inside `prefers-color-scheme`.
 * Variable names are the ones {@link themeToCss} emits (`--color-primary`,
 * `--spacing-lg`, `--radius-xl`), so a stylesheet written against the admin
 * UI's tokens reads the same names. For pages with no CSS toolchain, such as
 * the hub's standalone server-rendered pages.
 */
export function themeToRootCss(theme: CamStackTheme): string {
  const shared = [
    scaleDeclarations('spacing', theme.spacing),
    scaleDeclarations('radius', theme.radius),
    `--font-family:${theme.typography.fontFamily}`,
  ].join(';')
  return [
    `:root{color-scheme:light dark;${shared};${colorDeclarations(theme.colors.light)}}`,
    `@media (prefers-color-scheme:dark){:root{${colorDeclarations(theme.colors.dark)}}}`,
  ].join('')
}
