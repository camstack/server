import type { CamStackColorTokens, CamStackTheme } from './types'

export function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

function colorTokenToCssVar(key: string): string {
  return `--color-${camelToKebab(key)}`
}

function generateColorBlock(colors: CamStackColorTokens): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(colors)) {
    if (key === 'provider') continue
    lines.push(`  ${colorTokenToCssVar(key)}: ${value};`)
  }
  return lines.join('\n')
}

function generateProviderColors(provider: CamStackColorTokens['provider']): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(provider)) {
    lines.push(`  --color-provider-${camelToKebab(key)}: ${value};`)
  }
  return lines.join('\n')
}

function generateSpacingTokens(spacing: CamStackTheme['spacing']): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(spacing)) {
    lines.push(`  --spacing-${key}: ${value}px;`)
  }
  return lines.join('\n')
}

function generateRadiusTokens(radius: CamStackTheme['radius']): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(radius)) {
    lines.push(`  --radius-${key}: ${value}px;`)
  }
  return lines.join('\n')
}

export function themeToCss(theme: CamStackTheme): string {
  const darkColorBlock = generateColorBlock(theme.colors.dark)
  const lightColorBlock = generateColorBlock(theme.colors.light)
  const providerBlock = generateProviderColors(theme.colors.dark.provider)
  const spacingBlock = generateSpacingTokens(theme.spacing)
  const radiusBlock = generateRadiusTokens(theme.radius)

  return `@theme {
${providerBlock}
${spacingBlock}
${radiusBlock}
}

.dark {
${darkColorBlock}
}

.light {
${lightColorBlock}
}

@media (prefers-color-scheme: dark) {
  :root {
${darkColorBlock.replace(/^ {2}/gm, '    ')}
  }
}

@media (prefers-color-scheme: light) {
  :root {
${lightColorBlock.replace(/^ {2}/gm, '    ')}
  }
}
`
}
