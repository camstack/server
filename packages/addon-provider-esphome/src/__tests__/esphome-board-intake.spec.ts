import { describe, expect, it } from 'vitest'
import {
  buildBoardCreationSchema,
  buildIntegrationFormSchema,
  ESPHOME_KEY_HINT,
} from '../config.js'
import {
  ESPHOME_KEY_REQUIRED_MESSAGE,
  intakeBoard,
  type BoardIntakeDeps,
} from '../esphome-board-intake.js'
import type { BoardKeyLookup } from '../esphome-key-import.js'

const BOARD = { host: 'attic.local', port: 6053, name: 'attic', encryptionKey: '', password: '' }

function deps(lookup: BoardKeyLookup) {
  const saved: { integrationId: string; encryptionKey: string }[] = []
  const lookups: string[] = []
  const built: BoardIntakeDeps = {
    resolveIntegration: async (named) => (typeof named === 'string' ? named : 'int_only'),
    lookupKey: async (b) => {
      lookups.push(b.host)
      return lookup
    },
    addBoard: async (integrationId, input) => {
      saved.push({ integrationId, encryptionKey: input.encryptionKey })
      return { id: 'esp_1', name: input.name }
    },
  }
  return { built, saved, lookups }
}

describe('ESPHome integration form', () => {
  it('carries no board and no import action: devices are never added through the form', () => {
    expect(buildIntegrationFormSchema().sections.flatMap((s) => s.fields)).toEqual([])
  })
})

describe('ESPHome board creation form', () => {
  const fields = buildBoardCreationSchema().sections.flatMap((s) => s.fields)

  it('asks for the host, and the key only as an optional secret that says where to find it', () => {
    const key = fields.find((f) => 'key' in f && f.key === 'encryptionKey')
    expect(key).toMatchObject({ type: 'password' })
    expect(key).not.toMatchObject({ required: true })
    expect(key).toMatchObject({ description: ESPHOME_KEY_HINT })
    expect(ESPHOME_KEY_HINT).toContain('api: encryption: key:')
    expect(fields.find((f) => 'key' in f && f.key === 'host')).toMatchObject({ required: true })
  })
})

describe('board intake', () => {
  it('goes to the integration the operator named', async () => {
    const d = deps({ outcome: 'not-found', reason: 'no-source' })
    const done = await intakeBoard(d.built, {
      integrationId: 'int_a',
      board: BOARD,
      keyRequired: false,
    })
    expect(done.integrationId).toBe('int_a')
    expect(d.saved).toEqual([{ integrationId: 'int_a', encryptionKey: '' }])
  })

  it('keeps the key the operator typed and does not look any other up', async () => {
    const d = deps({ outcome: 'found', key: 'FROM-BUILDER' })
    await intakeBoard(d.built, {
      integrationId: 'int_a',
      board: { ...BOARD, encryptionKey: ' TYPED ' },
      keyRequired: true,
    })
    expect(d.saved[0]?.encryptionKey).toBe('TYPED')
    expect(d.lookups).toEqual([])
  })

  it('reads an empty key from the key sources', async () => {
    const d = deps({ outcome: 'found', key: 'FROM-BUILDER' })
    await intakeBoard(d.built, { integrationId: 'int_a', board: BOARD, keyRequired: true })
    expect(d.saved[0]?.encryptionKey).toBe('FROM-BUILDER')
  })

  it('refuses an encrypted board with no key anywhere, and saves nothing', async () => {
    const d = deps({ outcome: 'not-found', reason: 'no-match' })
    await expect(
      intakeBoard(d.built, { integrationId: 'int_a', board: BOARD, keyRequired: true }),
    ).rejects.toThrow(ESPHOME_KEY_REQUIRED_MESSAGE)
    expect(d.saved).toEqual([])
  })

  it('adds an unencrypted board with no key and no refusal', async () => {
    const d = deps({ outcome: 'not-found', reason: 'no-match' })
    await intakeBoard(d.built, { integrationId: 'int_a', board: BOARD, keyRequired: false })
    expect(d.saved).toHaveLength(1)
  })

  it('does not look a key up for a board that uses the legacy password', async () => {
    const d = deps({ outcome: 'found', key: 'X' })
    await intakeBoard(d.built, {
      integrationId: 'int_a',
      board: { ...BOARD, password: 'legacy' },
      keyRequired: false,
    })
    expect(d.lookups).toEqual([])
  })
})
