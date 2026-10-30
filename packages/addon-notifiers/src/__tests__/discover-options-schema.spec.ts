/**
 * A credential-gated kind lists its destinations inside its own form, once the
 * credentials are entered: the destination field is a select that discovers,
 * and it names the credential fields it needs.
 */
import type { ConfigField } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildNotifierAdapters } from '../adapters/registry.js'

const adapters = buildNotifierAdapters()

function fieldsOf(kind: string): readonly ConfigField[] {
  const adapter = adapters.find((candidate) => candidate.descriptor.kind === kind)
  return (adapter?.descriptor.configSchema.sections ?? []).flatMap((section) => section.fields)
}

function field(kind: string, key: string): ConfigField | undefined {
  return fieldsOf(kind).find((candidate) => 'key' in candidate && candidate.key === key)
}

describe('discovered destination selects', () => {
  const expected: readonly (readonly [string, string, readonly string[]])[] = [
    ['telegram', 'chatId', ['botToken']],
    ['whatsapp', 'chatId', ['idInstance', 'apiTokenInstance']],
    ['zentik', 'bucketId', ['accessToken']],
    ['pushover', 'device', ['appToken', 'userOrGroupKey']],
  ]
  for (const [kind, key, dependsOn] of expected) {
    it(`${kind}.${key} is a select discovered from ${dependsOn.join(' + ')}`, () => {
      expect(field(kind, key)).toMatchObject({
        type: 'select',
        discoverOptions: { kind, dependsOn },
      })
    })
  }

  it('every dependsOn names a field of the same form, and no secret field is a discovered select', () => {
    for (const adapter of adapters) {
      const fields = fieldsOf(adapter.descriptor.kind)
      for (const candidate of fields) {
        if (candidate.type !== 'select' || candidate.discoverOptions === undefined) continue
        expect(candidate.discoverOptions.kind).toBe(adapter.descriptor.kind)
        for (const needed of candidate.discoverOptions.dependsOn) {
          expect(fields.some((other) => 'key' in other && other.key === needed)).toBe(true)
        }
      }
    }
  })
})
