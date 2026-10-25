/**
 * The React-free slice of the theme: the token values and their plain-CSS
 * form. A separate entry (`@camstack/ui-library/theme/tokens`) so a Node
 * process can read the tokens without loading React.
 */
export type { CamStackColorTokens, CamStackTheme } from './types'
export { darkColors, lightColors, defaultTheme } from './defaults'
export { themeToCss } from './theme-to-css'
export { themeToRootCss } from './theme-to-root-css'
