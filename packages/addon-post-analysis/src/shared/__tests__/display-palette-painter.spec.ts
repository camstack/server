/**
 * An unknown palette read is logged once and does not become the stored
 * default (D939). Painting continues with the bundled CamStack preset.
 */
import type { IScopedLogger } from '@camstack/types'
import { bundledCamstack } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { createDisplayPalettePainter } from '../display-palette-painter.js'

function loggerOf(warnings: string[]): IScopedLogger {
  const base = makeSilentLogger()
  return {
    ...base,
    warn: (message: string) => {
      warnings.push(message)
    },
  }
}

describe('createDisplayPalettePainter', () => {
  it('paints the bundled person colour and logs an unknown read once', async () => {
    const warnings: string[] = []
    const painter = createDisplayPalettePainter(
      async () => ({ status: 'unknown', reason: 'stored palette is unreadable' }),
      loggerOf(warnings),
    )
    await vi.waitFor(() => {
      expect(warnings).toContain('painting the bundled CamStack preset')
    })
    expect(painter.paint('person')).toBe('#11a64c')
    expect(warnings).toHaveLength(1)
  })

  it('paints a stored swatch once the read resolves', async () => {
    const bundled = bundledCamstack()
    const painter = createDisplayPalettePainter(
      async () => ({
        ...bundled,
        swatches: { ...bundled.swatches, person: { form: 'solid' as const, hex: '#1f6e6a' } },
      }),
      loggerOf([]),
    )
    await vi.waitFor(() => {
      expect(painter.paint('person')).toBe('#1f6e6a')
    })
  })
})
