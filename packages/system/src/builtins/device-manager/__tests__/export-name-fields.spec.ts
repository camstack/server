/**
 * Where the derived "Name on <instance>" field lands, per exporter shape (D1049), and the
 * all-or-none write of several names.
 *
 *  - Google / Alexa: one section per instance (`export-google:<id>`, `export-alexa:<id>`); the
 *    field goes into its own instance's section, never the first.
 *  - HomeKit / Home Assistant: one section for every instance (`export-hap`, `ha-export`); every
 *    instance's field goes there.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ContributionShape } from '../device-meta-types.js'
import {
  applyExportNames,
  type ExportNameProvider,
  splitExportNamePatch,
  withExportNameFields,
} from '../export-name-fields.js'

function isFieldRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const section = (id: string): ContributionShape['sections'][number] => ({
  id,
  title: id,
  tab: 'export',
  fields: [{ type: 'boolean', key: `${id}:enabled`, value: true }],
})

function exporter(instanceIds: readonly string[]): ExportNameProvider {
  return {
    listInstances: async () =>
      instanceIds.map((instanceId) => ({ instanceId, name: instanceId, enabled: true })),
    listExposedDevices: async () => [],
    setExposedName: async () => undefined,
  }
}

/** The name-field keys of each section, by section id. */
async function placement(
  sectionIds: readonly string[],
  instanceIds: readonly string[],
  addonId: string,
): Promise<Record<string, string[]>> {
  const out = await withExportNameFields(
    { sections: sectionIds.map(section) },
    exporter(instanceIds),
    addonId,
    7,
  )
  return Object.fromEntries(
    (out?.sections ?? []).map((s) => [
      s.id,
      s.fields
        .filter(isFieldRecord)
        .map((f) => String(f['key']))
        .filter((k) => k.startsWith('export-name:')),
    ]),
  )
}

describe('the derived name field lands in its own instance section', () => {
  it('Google: one section per instance — the second instance is not put in the first', async () => {
    expect(
      await placement(['export-google:g1', 'export-google:g2'], ['g1', 'g2'], 'export-google'),
    ).toEqual({
      'export-google:g1': ['export-name:export-google:g1'],
      'export-google:g2': ['export-name:export-google:g2'],
    })
  })

  it('Alexa: the default skill section is the bare addon id', async () => {
    expect(
      await placement(
        ['export-alexa', 'export-alexa:alexa-skill-2'],
        ['export-alexa', 'alexa-skill-2'],
        'export-alexa',
      ),
    ).toEqual({
      'export-alexa': ['export-name:export-alexa:export-alexa'],
      'export-alexa:alexa-skill-2': ['export-name:export-alexa:alexa-skill-2'],
    })
  })

  it('HomeKit and Home Assistant: the one section holds every instance field', async () => {
    expect(await placement(['export-hap'], ['export-hap', 'hap-b2'], 'export-hap')).toEqual({
      'export-hap': ['export-name:export-hap:hap-b2', 'export-name:export-hap:export-hap'],
    })
    expect(await placement(['ha-export'], ['ha-t1', 'ha-t2'], 'homeassistant-export')).toEqual({
      'ha-export': [
        'export-name:homeassistant-export:ha-t2',
        'export-name:homeassistant-export:ha-t1',
      ],
    })
  })
})

describe('several names in one save', () => {
  it('a refused second name writes none (two HomeKit bridges)', async () => {
    const written: string[] = []
    const setExposedName = vi.fn(
      async (input: { instanceId: string; name: string | null; dryRun?: boolean }) => {
        if (input.instanceId === 'hap-b2') throw new Error('export-name-refused: no punctuation')
        if (input.dryRun !== true) written.push(input.instanceId)
      },
    )
    await expect(
      applyExportNames({ setExposedName }, 7, [
        { instanceId: 'export-hap', name: 'Porta' },
        { instanceId: 'hap-b2', name: 'Bad!' },
      ]),
    ).rejects.toThrow(/^export-name-refused: /)
    expect(written).toEqual([])
  })

  it('a non-string name is refused by name, never read as a clear', () => {
    expect(() =>
      splitExportNamePatch('export-hap', { 'export-name:export-hap:hap-b2': 42 }),
    ).toThrow(/^export-name-refused: /)
    expect(
      splitExportNamePatch('export-hap', {
        'export-name:export-hap:hap-b2': null,
        'export:hap': true,
      }),
    ).toEqual({ names: [{ instanceId: 'hap-b2', name: null }], rest: { 'export:hap': true } })
  })
})
