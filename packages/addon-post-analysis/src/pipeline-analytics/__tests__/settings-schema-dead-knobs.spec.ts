/**
 * The analytics settings form, checked for the two failures a NAME LIST cannot
 * check.
 *
 * ## What left this file, and why
 *
 * It used to assert the absence of two strings, `trackTtlMs` and
 * `maxPositionHistory` — both already deleted when the spec was written. An
 * absence assertion over a fixed list can only ever re-prove what someone
 * already fixed: `mediaAttachPolicy` was dead in the very schema this spec
 * guarded, three sections away, and the spec had nothing to say about it. The
 * 2026-08-28 census found nine such knobs across five addons
 * (`docs/design/2026-08-28-cluster-settings-census.md` §4).
 *
 * Reachability is now a GUARD over every addon's schema —
 * `scripts/check-settings-key-has-reader.ts`, wired into CI — which fails when
 * a declared key has no non-declaration reference anywhere. Re-adding
 * `trackTtlMs` fails that guard without anyone naming it here first. So the
 * name list is gone; D272.
 *
 * ## What the guard cannot check, and this file does
 *
 * 1. **The reverse regression** — a knob that DOES reach the tracker being
 *    deleted. The guard is silent on a key that is not declared at all.
 * 2. **Two defaults over one store key.** `embeddingEnabled` is declared by
 *    this schema AND read through a `DurableState` handle in the addon. They
 *    disagreed: the field said `false`, the handle's fallback said `true`, so
 *    an operator who had never touched the toggle saw OFF while the dispatcher
 *    ran — and a Save on that form would have written the lie back as truth.
 *    Neither a type nor a reachability scan can see that; only an assertion
 *    that both sides read ONE constant can.
 */
import { describe, expect, it } from 'vitest'
import { createDurableState } from '@camstack/types'
import { z } from 'zod'
import { buildGlobalSettingsSchema, EMBEDDING_ENABLED_DEFAULT } from '../settings-schema.js'

/** Every field key the global settings form offers, flattened. */
function allFieldKeys(): readonly string[] {
  const schema = buildGlobalSettingsSchema()
  const keys: string[] = []
  for (const section of schema.sections ?? []) {
    for (const field of section.fields ?? []) {
      if ('key' in field && typeof field.key === 'string') keys.push(field.key)
    }
  }
  return keys
}

/** The declared `default` of one field, or `undefined` when it has none. */
function fieldDefault(key: string): unknown {
  const schema = buildGlobalSettingsSchema()
  for (const section of schema.sections ?? []) {
    for (const field of section.fields ?? []) {
      if ('key' in field && field.key === key && 'default' in field) return field.default
    }
  }
  return undefined
}

describe('analytics settings form — the knobs that DO reach the tracker', () => {
  it('still offers them', () => {
    const keys = allFieldKeys()
    // `occlusionMaxMissedMs` / `maxTrackLifetimeSec` were retired with the
    // rest of the old tracker's settings (D683, Task 13) — they are gone from
    // the schema AND the form on purpose, not a reverse regression.
    for (const live of ['maxMissedMs', 'dedupSpawnIou', 'byteTrackLowIouThreshold']) {
      expect(keys).toContain(live)
    }
  })
})

describe('embeddingEnabled — one default, not two', () => {
  it('the form declares the SAME constant the durable handle falls back to', () => {
    expect(fieldDefault('embeddingEnabled')).toBe(EMBEDDING_ENABLED_DEFAULT)
  })

  it('resolves ON from a store the operator has never touched', async () => {
    // The addon builds this handle with `this.state('embeddingEnabled', …,
    // EMBEDDING_ENABLED_DEFAULT)` over its addon-settings row. An untouched
    // cluster has no such key, so the fallback IS what the dispatcher reads —
    // and it must agree with what the form shows.
    const handle = createDurableState<boolean>({
      key: 'embeddingEnabled',
      schema: z.boolean(),
      fallback: EMBEDDING_ENABLED_DEFAULT,
      read: async () => ({}),
      write: async () => {},
    })
    expect(await handle.get()).toBe(true)
    expect(await handle.get()).toBe(fieldDefault('embeddingEnabled'))
  })

  it('does not tell the operator to leave it off', () => {
    const schema = buildGlobalSettingsSchema()
    for (const section of schema.sections ?? []) {
      for (const field of section.fields ?? []) {
        if (!('key' in field) || field.key !== 'embeddingEnabled') continue
        const description = 'description' in field ? String(field.description ?? '') : ''
        expect(description.toLowerCase()).not.toContain('leave off')
      }
    }
  })
})
