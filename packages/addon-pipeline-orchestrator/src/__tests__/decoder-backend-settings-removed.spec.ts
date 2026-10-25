/**
 * Task 4 — the operator Decoder Backend selector is gone.
 *
 * The orchestrator schema used to expose a per-node `decoder` section with a
 * `backend` select (nodeav | ffmpeg). That setting is no longer operator-
 * writable: persisted `backend@<nodeId>` rows stay in the store but are not
 * read. These tests pin the schema hole. Runtime shm metrics stay elsewhere
 * and must not be confused with a `frameSink` / `shm` operator selector.
 */
import type { ConfigField, ConfigSection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildGlobalSettingsSections } from '../settings-ui-schemas.js'

function sections(): ConfigSection[] {
  return buildGlobalSettingsSections({ fpsMinThresholdDefault: 0 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function collectFieldKeys(fields: readonly ConfigField[]): string[] {
  const keys: string[] = []
  for (const field of fields) {
    if ('key' in field && typeof field.key === 'string') keys.push(field.key)
  }
  return keys
}

function collectOptionValues(fields: readonly ConfigField[]): string[] {
  const values: string[] = []
  for (const field of fields) {
    if (!('options' in field) || !Array.isArray(field.options)) continue
    for (const option of field.options) {
      if (isRecord(option) && typeof option.value === 'string') values.push(option.value)
    }
  }
  return values
}

describe('orchestrator global schema — decoder backend selector removed', () => {
  it('does not expose a decoder section or a backend field', () => {
    const built = sections()
    expect(built.map((section) => section.id)).not.toContain('decoder')
    expect(built.some((section) => section.title === 'Decoder Backend')).toBe(false)
    expect(collectFieldKeys(built.flatMap((section) => [...section.fields]))).not.toContain(
      'backend',
    )
  })

  it('does not expose an operator frameSink field or shm selector option', () => {
    const fields = sections().flatMap((section) => [...section.fields])
    expect(collectFieldKeys(fields)).not.toContain('frameSink')
    expect(collectOptionValues(fields)).not.toContain('shm')
  })
})
