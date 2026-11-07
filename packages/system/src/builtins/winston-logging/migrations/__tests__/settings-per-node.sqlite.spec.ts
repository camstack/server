/**
 * The log level and the retention become node settings, on real SQLite in the canonical
 * `addon-settings` layout: each bare row is copied to a node row of EVERY node carrying `nodeId`,
 * the bare rows and a field the migration does not know survive, a node row is never overwritten,
 * a second run changes nothing and a failed read writes nothing.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../sqlite-storage/__tests__/support/addon-settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  SETTINGS_PER_NODE_ID,
  WINSTON_LOGGING_ID,
  WINSTON_NODE_KEYS,
} from '../index.js'
import type { NodeFieldsPorts } from '../node-fields.js'

const NODES = ['hub', 'agent-1']

const winston = (
  seed: Record<string, unknown>,
  nodeIds: NodeFieldsPorts['nodeIds'] = async () => NODES,
) =>
  settingsFixture<NodeFieldsPorts>({
    addonId: WINSTON_LOGGING_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: 'keep-me',
    ports: (rows) => ({ readStored: rows.readStored, nodeIds }),
  })

describe('winston-logging settings-per-node', () => {
  it('copies the stored level and retention to every node row and keeps the rest', async () => {
    const f = winston({ level: 'debug', retentionDays: 7, markedUnknown: { mark: 'survive' } })
    expect(await f.boot()).toEqual({ failed: [], applied: [SETTINGS_PER_NODE_ID] })
    const rows = f.rows()
    for (const node of NODES) {
      expect(rows[`winston-logging.level@${node}`]).toEqual({
        addonId: 'winston-logging',
        key: `level@${node}`,
        value: 'debug',
        nodeId: node,
      })
      expect(rows[`winston-logging.retentionDays@${node}`]?.['value']).toBe(7)
    }
    expect(rows['winston-logging.level']?.['value']).toBe('debug')
    expect(rows['winston-logging.markedUnknown']?.['value']).toEqual({ mark: 'survive' })
    expect(rows['winston-logging.markedUnknown@hub']).toBeUndefined()
    expect(rows['other-addon.level']?.['value']).toBe('keep-me')
    expect([...WINSTON_NODE_KEYS].sort()).toEqual(['level', 'retentionDays'])
  })

  it('never overwrites a node row and a second run is a no-op', async () => {
    const f = winston({ level: 'debug', 'level@hub': 'error', retentionDays: 7 })
    expect((await f.boot()).failed).toEqual([])
    expect(f.rows()['winston-logging.level@hub']?.['value']).toBe('error')
    expect(f.rows()['winston-logging.level@agent-1']?.['value']).toBe('debug')
    const once = JSON.stringify(f.rows())
    await f.boot()
    expect(JSON.stringify(f.rows())).toBe(once)
  })

  it('writes nothing and reports the id as failed when the nodes cannot be listed', async () => {
    const f = winston({ level: 'debug' }, async () => {
      throw new Error('directory unreachable')
    })
    const before = JSON.stringify(f.rows())
    expect((await f.boot()).failed).toEqual([SETTINGS_PER_NODE_ID])
    expect(JSON.stringify(f.rows())).toBe(before)
  })

  it('writes nothing when there is no stored value to copy', async () => {
    const f = winston({ markedUnknown: 1 })
    expect(await f.boot()).toEqual({ failed: [], applied: [SETTINGS_PER_NODE_ID] })
    expect(Object.keys(f.rows()).filter((id) => id.includes('@'))).toEqual([])
  })
})
