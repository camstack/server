/**
 * The core-blocks migration that moves stored generated automations to the
 * confirmed view (D1061), run through the REAL records engine with the
 * migration driver the addon uses.
 *
 * The seed is an automation saved before D1061 (the generator's output with
 * the D1061 edits taken back out), one already current, one generated and
 * then edited by hand, and a hand-written script.
 */
import {
  type AutomationRecipe,
  type CoreBlock,
  CoreBlockSchema,
  createRecordsAccess,
  defineAddonMigrations,
  generateAutomationBlock,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { recordingLogger } from '../../__tests__/fixtures.js'
import { type CoreBlockRowBody, coreBlocksRecordKinds } from '../../record-kinds.js'
import { beforeConfirmedView } from '../automation-confirmed-view.js'
import {
  ADDON_MIGRATIONS,
  AUTOMATION_CONFIRMED_VIEW_ID,
  coreBlocksMigrationPorts,
} from '../index.js'
import { NO_REMOTE_PORTS } from './no-remote-ports.js'

const RECIPE: AutomationRecipe = {
  when: {
    kind: 'device-becomes',
    deviceId: 1023,
    cap: 'alarm-panel',
    fieldPath: 'state',
    becomes: 'armed_away',
    edge: true,
  },
  actions: [{ kind: 'command', target: { kind: 'devices', ids: [616] }, actionId: 'button.press' }],
}

const CURRENT = generateAutomationBlock({ name: 'Armed', recipe: RECIPE })
const BEFORE = beforeConfirmedView(CURRENT)
const EDITED = `${BEFORE}\n// the operator's own line\n`

function blockOf(id: string, name: string, code: string): CoreBlock {
  return CoreBlockSchema.parse({
    id,
    name,
    code,
    enabled: true,
    createdBy: `marker-${id}`,
    createdAt: 1,
    updatedAt: 2,
    status: 'stopped',
    lastChangedAt: 2,
  })
}

function rowBody(block: CoreBlock): CoreBlockRowBody {
  return {
    name: block.name,
    enabled: block.enabled,
    updatedAt: block.updatedAt,
    block,
  }
}

let records: ReturnType<typeof createRecordsAccess>
const NOW = 5_000

beforeEach(async () => {
  const world = makeRecordsWorld()
  await world.provider.init()
  records = createRecordsAccess({
    owner: 'core-blocks',
    transport: world.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  for (const block of [
    blockOf('old', 'Armed', BEFORE),
    blockOf('current', 'Armed', CURRENT),
    blockOf('edited', 'Armed', EDITED),
    blockOf('script', 'Plain code', 'export default () => {}'),
  ]) {
    await handle.put({ id: block.id, data: rowBody(block) })
  }
})

async function runMigration() {
  const handle = records.kind(coreBlocksRecordKinds.blocks)
  const { logger, lines } = recordingLogger()
  const ports = { ...coreBlocksMigrationPorts(handle, logger, () => NOW), ...NO_REMOTE_PORTS }
  const migration = defineAddonMigrations(ADDON_MIGRATIONS, ports).find(
    (m) => m.meta.id === AUTOMATION_CONFIRMED_VIEW_ID,
  )
  if (migration === undefined) throw new Error('migration is not in the catalogue')
  const out = await migration.execute()
  if (out.kind !== 'procedure') throw new Error(`expected a procedure result, got ${out.kind}`)
  return { outcome: out.result.outcome, lines }
}

async function code(id: string): Promise<string> {
  const row = await records.kind(coreBlocksRecordKinds.blocks).get(id)
  if (row === null) throw new Error(`no row ${id}`)
  return CoreBlockSchema.parse(row.data.block).code
}

describe('core-blocks migration: generated automations read the confirmed view (D1061)', () => {
  it('the seed really reads the effective view (the spec would otherwise prove nothing)', () => {
    expect(BEFORE).not.toContain('confirmed')
    expect(BEFORE).toContain('getCapSlice.query({ deviceId, capName: cap })')
    expect(CURRENT).toContain('confirmed: true')
  })

  it('regenerates the pre-D1061 automation from its recipe, logged per automation', async () => {
    const { outcome, lines } = await runMigration()
    expect(outcome).toBe('done')
    expect(await code('old')).toBe(CURRENT)
    const row = await records.kind(coreBlocksRecordKinds.blocks).get('old')
    expect(row?.data.updatedAt).toBe(NOW)
    expect(lines.filter((l) => l.level === 'info').map((l) => l.extras)).toEqual([
      { meta: { blockId: 'old', name: 'Armed' } },
    ])
  })

  it('leaves code edited by hand exactly as it is, and says so', async () => {
    const { lines } = await runMigration()
    expect(await code('edited')).toBe(EDITED)
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.extras)).toEqual([
      { meta: expect.objectContaining({ blockId: 'edited', name: 'Armed' }) },
    ])
  })

  it('leaves a current automation and a hand-written script byte-identical', async () => {
    await runMigration()
    expect(await code('current')).toBe(CURRENT)
    expect(await code('script')).toBe('export default () => {}')
  })

  it('a second run edits nothing and says so', async () => {
    await runMigration()
    const first = await code('old')
    const { outcome } = await runMigration()
    expect(outcome).toBe('already-done')
    expect(await code('old')).toBe(first)
  })
})
