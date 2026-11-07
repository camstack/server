/**
 * The retired `enabled` flag, on real SQLite in the canonical `addon-settings` layout: a stored
 * `enabled` (either value) and the old carry-over marker are deleted, nothing else is touched,
 * the operator is told once, and a second run writes nothing (D777, D987).
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../sqlite-storage/__tests__/support/addon-settings-fixture.js'
import { ADDON_MIGRATIONS, DROP_RETIRED_ENABLED_ID, type LokiCataloguePorts } from '../index.js'

const OWNER = 'loki-logging'

const unreached = async (): Promise<never> => {
  throw new Error('a port of another migration was reached')
}

function lokiSettings(seed: Record<string, unknown>) {
  const told: string[] = []
  const fixture = settingsFixture<LokiCataloguePorts>({
    addonId: OWNER,
    catalogue: ADDON_MIGRATIONS.filter((m) => m.meta.id === DROP_RETIRED_ENABLED_ID),
    seed,
    neighbour: 'keep-me',
    // Only the retirement migration is offered: the others' ports are never reached.
    ports: (rows) => ({
      readRawStored: () =>
        rows.readStored(['enabled', 'migratedEnabled', 'level', 'unknownMarked']),
      info: (message) => {
        told.push(message)
      },
      readStored: unreached,
      warn: unreached,
      ensureIntegration: unreached,
      findIntegration: unreached,
      putRecord: unreached,
      readRecord: unreached,
    }),
  })
  return { fixture, told }
}

describe('loki-logging retired enabled flag', () => {
  it.each([
    false,
    true,
  ])('drops a stored enabled:%s and the marker, keeps every other row, says so once', async (flag) => {
    const { fixture, told } = lokiSettings({
      enabled: flag,
      migratedEnabled: true,
      level: 'warn',
      unknownMarked: { mark: 'survive' },
    })
    const first = await fixture.boot()
    expect(first.failed).toEqual([])
    expect(first.applied).toContain(DROP_RETIRED_ENABLED_ID)
    const rows = fixture.rows()
    expect(rows['loki-logging.enabled']).toBeUndefined()
    expect(rows['loki-logging.migratedEnabled']).toBeUndefined()
    expect(rows['loki-logging.level']?.['value']).toBe('warn')
    expect(rows['loki-logging.unknownMarked']?.['value']).toEqual({ mark: 'survive' })
    expect(rows['other-addon.enabled']?.['value']).toBe('keep-me')
    expect(told).toHaveLength(1)
    expect(told[0]).toContain(`enabled: ${String(flag)}`)

    const again = await fixture.boot()
    expect(again.failed).toEqual([])
    expect(told).toHaveLength(1)
  })

  it('has nothing to delete when neither key was ever stored', async () => {
    const { fixture, told } = lokiSettings({ level: 'warn' })
    const report = await fixture.boot()
    expect(report.failed).toEqual([])
    expect(fixture.rows()['loki-logging.level']?.['value']).toBe('warn')
    expect(told).toEqual([])
  })
})
