/**
 * One mechanism, no kind knowledge. The shared broker components take a kind as
 * DATA (the provider's descriptor and schema); none may carry a kind literal or
 * branch on one. This pins it: a new `if (kind === 'x')` in any of them fails here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const brokers = join(here, '..')
const integrations = join(here, '..', '..', 'integrations')

const FILES: readonly string[] = [
  join(brokers, 'BrokerEditorDialog.tsx'),
  join(brokers, 'BrokerPicker.tsx'),
  join(brokers, 'BrokerForm.tsx'),
  join(brokers, 'BrokerSignInPanel.tsx'),
  join(brokers, 'BrokerManager.tsx'),
  join(brokers, 'broker-kinds.ts'),
  join(brokers, 'broker-schema-arrange.ts'),
  join(integrations, 'BrokerStep.tsx'),
]

/** Every broker kind the product ships today; extend it when a kind is added. */
const KNOWN_KINDS: readonly string[] = [
  'alexa',
  'home-assistant',
  'homematic',
  'mqtt',
  'matter',
  'google',
  'ecowitt',
  'zigbee2mqtt',
]

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('shared broker components name no broker kind', () => {
  it.each(FILES)('%s', (file) => {
    const code = codeOnly(readFileSync(file, 'utf8'))
    for (const kind of KNOWN_KINDS) {
      expect(code, `${file} mentions the kind "${kind}"`).not.toMatch(
        new RegExp(`['"\`]${kind}['"\`]`),
      )
    }
  })
})
