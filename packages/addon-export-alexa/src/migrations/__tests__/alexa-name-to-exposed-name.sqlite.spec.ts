/**
 * `alexaName` -> the generic exposed name of EVERY Alexa skill (D1049), on real SQLite in the
 * canonical `addon-device-settings` layout. One `alexaName` served every skill (planning#422), so
 * a marked name must arrive unchanged under each skill id, and under no id that has no skill. The
 * legacy key must go, a name already saved for a skill is not overwritten (the other skills still
 * get the old name), another addon's rows and a neighbour field stay, and a second run is a no-op.
 *
 * Disarm: writing the name under the default instance id only fails the two-skill case.
 */
import type { AddonMigration } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import { ALEXA_INSTANCE_ID } from '../../skill-records.js'
import {
  type AlexaNameMovePorts,
  planAlexaNameToExposedName,
} from '../alexa-name-to-exposed-name.js'
import { ADDON_MIGRATIONS, ALEXA_NAME_TO_EXPOSED_NAME_ID } from '../index.js'

const OWNER = 'export-alexa'
const MARKED = 'Lampada di mamma 2'
const SECOND_SKILL = 'alexa-skill-2b'
const BOTH_SKILLS = [ALEXA_INSTANCE_ID, SECOND_SKILL] as const

const registered = ADDON_MIGRATIONS.find((m) => m.meta.id === ALEXA_NAME_TO_EXPOSED_NAME_ID)
/** The catalogue entry as shipped, over only the ports it reads (the others need records). */
const CATALOGUE: readonly AddonMigration<AlexaNameMovePorts>[] =
  registered === undefined ? [] : [{ meta: registered.meta, plan: planAlexaNameToExposedName }]

function world(
  deviceSeed: Record<string, Record<string, unknown>>,
  skills: readonly string[] = [ALEXA_INSTANCE_ID],
) {
  const warnings: string[] = []
  const deviceIds = (): number[] =>
    Object.keys(fixture.deviceRows()).flatMap((id) => {
      const match = /^export-alexa:(\d+)\./.exec(id)
      return match?.[1] === undefined ? [] : [Number(match[1])]
    })
  const fixture = settingsFixture<AlexaNameMovePorts>({
    addonId: OWNER,
    catalogue: CATALOGUE,
    seed: {},
    neighbour: 'keep-me',
    deviceSeed,
    ports: (rows) => ({
      warn: (message) => void warnings.push(message),
      listSkillIds: async () => skills,
      listDeviceIds: async () => [...new Set(deviceIds())],
      readDeviceField: rows.readDeviceField,
    }),
  })
  return { fixture, warnings }
}

const value = (row: Record<string, unknown> | undefined): unknown => row?.['value']

describe('export-alexa alexa-name-to-exposed-name', () => {
  it('is in the catalogue as a plan with this body', () => {
    expect(registered).toBeDefined()
    expect(registered !== undefined && 'plan' in registered ? registered.plan : null).toBe(
      planAlexaNameToExposedName,
    )
  })

  it('copies a marked Alexa name, unchanged, to EVERY skill and drops the old key', async () => {
    const { fixture } = world(
      {
        '7': { alexaName: MARKED, sensorSelection: ['person'] },
        '9': { sensorSelection: ['car'] },
      },
      BOTH_SKILLS,
    )
    const report = await fixture.boot()
    expect(report.failed).toEqual([])
    expect(report.applied).toContain(ALEXA_NAME_TO_EXPOSED_NAME_ID)
    const rows = fixture.deviceRows()
    expect(value(rows['export-alexa:7.exposedNames'])).toEqual({
      [ALEXA_INSTANCE_ID]: MARKED,
      [SECOND_SKILL]: MARKED,
    })
    expect(rows['export-alexa:7.alexaName']).toBeUndefined()
    expect(value(rows['export-alexa:7.sensorSelection'])).toEqual(['person'])
    expect(rows['export-alexa:9.exposedNames']).toBeUndefined()
    expect(value(rows['other-addon:7.alexaName'])).toBe('keep-me')
  })

  it('writes nothing under a skill id that has no skill (no default skill record)', async () => {
    const { fixture } = world({ '7': { alexaName: MARKED } }, [SECOND_SKILL])
    await fixture.boot()
    const rows = fixture.deviceRows()
    expect(value(rows['export-alexa:7.exposedNames'])).toEqual({ [SECOND_SKILL]: MARKED })
    expect(rows['export-alexa:7.alexaName']).toBeUndefined()
  })

  it('never overwrites a skill name saved through the new field; the other skill still gets it', async () => {
    const { fixture, warnings } = world(
      {
        '7': {
          alexaName: MARKED,
          exposedNames: { [ALEXA_INSTANCE_ID]: 'Chosen later' },
        },
      },
      BOTH_SKILLS,
    )
    await fixture.boot()
    const rows = fixture.deviceRows()
    expect(value(rows['export-alexa:7.exposedNames'])).toEqual({
      [ALEXA_INSTANCE_ID]: 'Chosen later',
      [SECOND_SKILL]: MARKED,
    })
    expect(rows['export-alexa:7.alexaName']).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('a stored name Alexa refused is not copied, but its key goes', async () => {
    const { fixture } = world({ '7': { alexaName: 'Alexa!' } })
    await fixture.boot()
    const rows = fixture.deviceRows()
    expect(rows['export-alexa:7.exposedNames']).toBeUndefined()
    expect(rows['export-alexa:7.alexaName']).toBeUndefined()
  })

  it('is a no-op without an Alexa name, and on a second run', async () => {
    const empty = world({ '9': { sensorSelection: ['car'] } }).fixture
    const before = JSON.stringify(empty.deviceRows())
    await empty.boot()
    expect(JSON.stringify(empty.deviceRows())).toBe(before)

    const { fixture } = world({ '7': { alexaName: MARKED } })
    await fixture.boot()
    const once = JSON.stringify(fixture.deviceRows())
    await fixture.boot()
    expect(JSON.stringify(fixture.deviceRows())).toBe(once)
  })
})
