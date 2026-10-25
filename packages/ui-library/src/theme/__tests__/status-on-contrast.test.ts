import { describe, expect, it } from 'vitest'
import { darkColors, lightColors } from '../defaults'
import type { CamStackColorTokens } from '../types'

function channel(hex: string, offset: number): number {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const NAMES = ['success', 'warning', 'danger', 'info', 'primary', 'neutral'] as const

function pair(colors: CamStackColorTokens, name: (typeof NAMES)[number]): [string, string] {
  return [colors[`${name}Fill`], colors[`${name}On`]]
}

describe('status on-colours', () => {
  it.each(NAMES)('%s: the on-colour passes WCAG AA (4.5:1) on its fill, dark and light', (name) => {
    for (const colors of [darkColors, lightColors]) {
      const [fill, on] = pair(colors, name)
      expect(contrast(fill, on)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
