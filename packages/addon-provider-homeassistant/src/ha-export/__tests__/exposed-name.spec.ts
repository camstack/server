/**
 * The Home Assistant name (D1049): per connection, applied to `dev.name` only, never to the
 * device key — so a rename updates the same Home Assistant device. The reconcile skip must see
 * a rename, or an event-debounced pass would never announce it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXPOSED_NAMES_STORE_KEY, type ExposedNameStore } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { devBlockFor, haNameValidator, namesByBroker } from '../exposed-name.js'
import { structureFingerprint } from '../reconcile-fingerprint.js'
import type { HaDeviceBlock } from '../types.js'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../ha-export.addon.ts'),
  'utf8',
)

const store = (names: Record<string, string>): ExposedNameStore => ({
  read: async () => ({ [EXPOSED_NAMES_STORE_KEY]: names }),
  write: async () => undefined,
})

describe('Home Assistant exposed name', () => {
  it('names the device per connection and keeps its key', async () => {
    const names = await namesByBroker(store({ 'ha-a': 'Cancello' }), 7, ['ha-a', 'ha-b'])
    const dev: HaDeviceBlock = {
      ids: ['camstack_7'],
      name: 'Gate cam',
      mf: 'CamStack',
      mdl: 'camera',
    }
    expect(devBlockFor(dev, names, 'ha-a')).toEqual({
      ...dev,
      name: 'Cancello',
    })
    expect(devBlockFor(dev, names, 'ha-b')).toBe(dev)
  })

  it('refuses control characters and over-long names', () => {
    expect(haNameValidator('Gate\u0007').ok).toBe(false)
    expect(haNameValidator('x'.repeat(101)).ok).toBe(false)
  })

  it('a rename changes the reconcile fingerprint', () => {
    const plan = { deviceKey: 'k' }
    const before = structureFingerprint(new Map([['k', { brokerIds: ['ha-a'], plan }]]))
    const after = structureFingerprint(
      new Map([
        [
          'k',
          {
            brokerIds: ['ha-a'],
            plan,
            exposedNames: new Map([['ha-a', 'Cancello']]),
          },
        ],
      ]),
    )
    expect(after).not.toBe(before)
  })

  it('the announce sends each broker its own dev block', () => {
    const announce = SOURCE.slice(SOURCE.indexOf('private async announce('))
    expect(announce.slice(0, 1500)).toContain(
      'devBlockFor(entry.plan.dev, entry.exposedNames, brokerId)',
    )
  })
})
