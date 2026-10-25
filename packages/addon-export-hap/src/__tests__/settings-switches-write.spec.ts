/**
 * Every switch this addon DRAWS must also be WRITTEN.
 *
 * `multiTierService` shipped with a field in `cameraFields` and no branch in
 * `applyDeviceSettingsPatch`. The switch rendered, an operator could flip it,
 * `applyDeviceSettingsPatch` answered `{ success: true }`, and the value was
 * discarded — the read-back still said `false`. Nothing anywhere said so.
 *
 * `CLAUDE.md` names the inverse of this defect ("two knobs that wrote a store
 * nobody read"); this is a knob nobody writes, and it is just as silent.
 *
 * The check is structural because the defect is structural: the two lists are
 * written in two places two hundred lines apart, and a per-key unit test would
 * only ever cover the keys somebody remembered to think about. This one fails
 * for a key nobody thought about, which is the whole point.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../hap-export.addon.ts'),
  'utf8',
)

/** `const <name>Key = \`hap:${deviceId}:<setting>\`` — the declaration form. */
function keyDeclarations(source: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(/const (\w+Key) = `hap:\$\{deviceId\}:(\w+)`/g)) {
    const variable = match[1]
    const setting = match[2]
    if (variable !== undefined && setting !== undefined) {
      found.set(variable, setting)
    }
  }
  return found
}

describe('a per-camera switch is drawn AND written', () => {
  it('declares the same keys in the contribution and in the patch handler', () => {
    const contribution = SOURCE.slice(
      SOURCE.indexOf('const enabledKey'),
      SOURCE.indexOf('const enabledKey', SOURCE.indexOf('const enabledKey') + 1),
    )
    const handler = SOURCE.slice(
      SOURCE.indexOf('const enabledKey', SOURCE.indexOf('const enabledKey') + 1),
    )

    const drawn = new Set(keyDeclarations(contribution).values())
    const written = new Set(keyDeclarations(handler).values())
    expect(drawn.size).toBeGreaterThan(3)

    const undrawn = [...written].filter((k) => !drawn.has(k))
    const unwritten = [...drawn].filter((k) => !written.has(k))
    expect(unwritten, `drawn but never written: ${unwritten.join(', ')}`).toEqual([])
    expect(undrawn, `written but never drawn: ${undrawn.join(', ')}`).toEqual([])
  })

  it('reads every declared key out of the patch', () => {
    const handler = SOURCE.slice(
      SOURCE.indexOf('const enabledKey', SOURCE.indexOf('const enabledKey') + 1),
    )
    for (const variable of keyDeclarations(handler).keys()) {
      expect(handler, `${variable} is declared but never read from the patch`).toContain(
        `${variable} in patch`,
      )
    }
  })
})
