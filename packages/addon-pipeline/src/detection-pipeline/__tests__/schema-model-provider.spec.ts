import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('buildSchemaSlots — model provider', () => {
  it('forwards catalog provider onto each PipelineModelOption (CamStack when absent)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../provider.ts'),
      'utf8',
    )
    expect(src).toMatch(/provider:\s*m\.provider\s*\?\?\s*'camstack'/)
  })
})
