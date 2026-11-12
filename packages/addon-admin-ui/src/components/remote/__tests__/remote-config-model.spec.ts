import {
  EMPTY_REMOTE_CONFIG,
  type RemoteBindingAction,
  type RemoteConfig,
  type RemoteLayoutPayload,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyDraft,
  BLANK_ACTION,
  BLANK_SOURCE_DRAFT,
  bindableRoles,
  boundStepRoles,
  checkForSave,
  clearBinding,
  deleteSource,
  draftIssues,
  draftOfSource,
  importFlipperIr,
  importSmartIr,
  irSourceSummary,
  moveSource,
  newSourceId,
  type SourceDraft,
  setBinding,
  setStepDelay,
  sourceIssues,
  transmitterOf,
  upsertSource,
  withTransmitter,
} from '../remote-config-model'

const TRAIN_A = '[9000,-4500,560,-560,560,-1690]'
const TRAIN_B = '[9000,-4500,560,-1690,560,-560]'

const smartIrFile = (commands: Record<string, unknown>): string =>
  JSON.stringify({
    manufacturer: 'Acme',
    supportedModels: ['TV-1'],
    supportedController: 'Broadlink',
    commandsEncoding: 'Raw',
    delay: 0.4,
    commands,
  })

const SWITCH_ACTION: RemoteBindingAction = {
  kind: 'cap',
  deviceId: 12,
  cap: 'switch',
  method: 'turnOn',
}

describe('remote-config-model: binding', () => {
  it('binds a known role and drops it again', () => {
    const bound = setBinding(EMPTY_REMOTE_CONFIG, 'power', SWITCH_ACTION)
    expect(bound.bindings['power']?.action).toEqual(SWITCH_ACTION)
    expect(checkForSave(bound).config).not.toBeNull()
    expect(clearBinding(bound, 'power').bindings).toEqual({})
  })

  it('a bound custom role gets its entry in customButtons, and loses it when cleared', () => {
    const bound = setBinding(EMPTY_REMOTE_CONFIG, 'custom:hdmi_1', SWITCH_ACTION, 'HDMI 1')
    expect(bound.customButtons).toEqual([{ key: 'hdmi_1', name: 'HDMI 1' }])
    // The server schema refuses a bound custom role with no entry; this config passes it.
    expect(checkForSave(bound).config).not.toBeNull()
    expect(clearBinding(bound, 'custom:hdmi_1').customButtons).toEqual([])
  })

  it('refuses to save while a binding is unfinished, and names the role', () => {
    const draft = setBinding(EMPTY_REMOTE_CONFIG, 'mute', BLANK_ACTION)
    const check = checkForSave(draft)
    expect(check.incomplete).toEqual(['mute'])
    expect(check.config).toBeNull()
  })

  it('reads and overrides the transmitter of an infrared binding only', () => {
    const ir = {
      action: { kind: 'cap' as const, deviceId: 5, cap: 'ir-transmitter', method: 'send' },
    }
    expect(transmitterOf(ir)).toBe(5)
    expect(withTransmitter(ir, 9).action.deviceId).toBe(9)
    expect(transmitterOf({ action: SWITCH_ACTION })).toBeNull()
  })
})

describe('remote-config-model: roles', () => {
  const layout: RemoteLayoutPayload = {
    columns: 2,
    rows: 2,
    buttons: [
      { id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' },
      { id: 'b', row: 0, col: 1, rowSpan: 1, colSpan: 1, role: 'custom:hdmi_1', label: 'HDMI 1' },
    ],
  }

  it('lists the layout roles first, then custom and other bound roles', () => {
    const config: RemoteConfig = setBinding(
      setBinding(EMPTY_REMOTE_CONFIG, 'volume_up', SWITCH_ACTION),
      'custom:game',
      SWITCH_ACTION,
      'Game',
    )
    const roles = bindableRoles(layout, config)
    expect(roles.map((r) => r.role)).toEqual(['power', 'custom:hdmi_1', 'custom:game', 'volume_up'])
    expect(roles[1]).toMatchObject({ custom: true, inLayout: true, name: 'HDMI 1' })
    expect(roles[2]).toMatchObject({ custom: true, inLayout: false, name: 'Game' })
    expect(roles[3]).toMatchObject({ custom: false, inLayout: false, name: null })
  })

  it('lists nothing but the bound roles when no template is chosen', () => {
    expect(bindableRoles(null, EMPTY_REMOTE_CONFIG)).toEqual([])
  })
})

describe('remote-config-model: SmartIR import', () => {
  it('turns a file into bindings through the chosen transmitter and keeps nothing of the file', () => {
    const result = importSmartIr(
      smartIrFile({
        on: TRAIN_A,
        off: TRAIN_A,
        volumeUp: TRAIN_B,
        sources: { 'HDMI 1': TRAIN_B },
      }),
      7,
    )
    if (result.status !== 'ok') throw new Error(result.reason)
    expect(Object.keys(result.draft.bindings).sort()).toEqual([
      'custom:source_hdmi_1',
      'power',
      'volume_up',
    ])
    expect(result.draft.bindings['power']?.action).toMatchObject({
      deviceId: 7,
      cap: 'ir-transmitter',
      method: 'send',
    })
    expect(result.bound).toBe(3)

    const applied = applyDraft(EMPTY_REMOTE_CONFIG, result.draft)
    expect(applied.customButtons).toEqual([{ key: 'source_hdmi_1', name: 'HDMI 1' }])
    expect(checkForSave(applied).config).not.toBeNull()
  })

  it('a re-import replaces the roles the file fills and keeps the others', () => {
    const first = importSmartIr(smartIrFile({ on: TRAIN_A, off: TRAIN_B, mute: TRAIN_A }), 7)
    if (first.status !== 'ok') throw new Error(first.reason)
    const withMute = applyDraft(EMPTY_REMOTE_CONFIG, first.draft)
    const manual = setBinding(withMute, 'ok', SWITCH_ACTION)
    const second = importSmartIr(smartIrFile({ mute: TRAIN_B }), 8)
    if (second.status !== 'ok') throw new Error(second.reason)
    const merged = applyDraft(manual, second.draft)
    expect(merged.bindings['mute']?.action.deviceId).toBe(8)
    expect(merged.bindings['ok']?.action).toEqual(SWITCH_ACTION)
    expect(merged.bindings['power_on']?.action.deviceId).toBe(7)
  })

  it('reports commands it cannot import instead of dropping them silently', () => {
    const result = importSmartIr(smartIrFile({ mute: 'not a train', volumeUp: TRAIN_A }), 7)
    if (result.status !== 'ok') throw new Error(result.reason)
    expect(result.skipped.map((s) => s.name)).toEqual(['mute'])
    expect(Object.keys(result.draft.bindings)).toEqual(['volume_up'])
  })

  it('refuses without a transmitter, with text that is not JSON, and with JSON that is not SmartIR', () => {
    expect(importSmartIr(smartIrFile({}), null)).toEqual({
      status: 'refused',
      reason: 'no-transmitter',
    })
    expect(importSmartIr('{ nope', 7)).toEqual({ status: 'refused', reason: 'not-json' })
    expect(importSmartIr('{"hello":1}', 7)).toEqual({ status: 'refused', reason: 'not-smartir' })
  })
})

describe('remote-config-model: sources', () => {
  const bound = (roles: readonly string[]): RemoteConfig => ({
    ...EMPTY_REMOTE_CONFIG,
    bindings: Object.fromEntries(roles.map((r) => [r, { action: SWITCH_ACTION }])),
  })
  const WITH_KEYS = bound([
    'input',
    'down',
    'ok',
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `digit_${d}`),
  ])
  const channel = (name: string, number: string) => ({
    ...BLANK_SOURCE_DRAFT,
    kind: 'digits' as const,
    name,
    number,
  })

  it('adds a source at the end with a slug id, and the config still parses', () => {
    const one = upsertSource(WITH_KEYS, channel('Rai 1', '1'), null)
    const two = upsertSource(one, channel('Rai 2', '2'), null)
    expect(two.sources.map((s) => s.id)).toEqual(['rai-1', 'rai-2'])
    expect(checkForSave(two).config).not.toBeNull()
  })

  it('keeps an id unique when two names slug the same', () => {
    const one = upsertSource(WITH_KEYS, channel('Rai 1', '1'), null)
    expect(newSourceId(one, 'rai  1!')).toBe('rai-1-2')
    expect(newSourceId(WITH_KEYS, '***')).toBe('source')
  })

  it('edits in place and keeps the id on a rename', () => {
    const one = upsertSource(WITH_KEYS, channel('Rai 1', '1'), null)
    const renamed = upsertSource(one, { ...channel('Rai Uno', '1') }, 'rai-1')
    expect(renamed.sources).toEqual([{ id: 'rai-1', kind: 'digits', name: 'Rai Uno', number: '1' }])
    expect(draftOfSource(renamed.sources[0]!)).toMatchObject({
      kind: 'digits',
      name: 'Rai Uno',
      number: '1',
    })
  })

  it('switches an existing source to a sequence', () => {
    const one = upsertSource(WITH_KEYS, channel('HDMI', '1'), null)
    const seq = upsertSource(
      one,
      { ...BLANK_SOURCE_DRAFT, kind: 'sequence', name: 'HDMI', steps: ['input', 'down', 'ok'] },
      'hdmi',
    )
    expect(seq.sources[0]).toEqual({
      id: 'hdmi',
      kind: 'sequence',
      name: 'HDMI',
      steps: ['input', 'down', 'ok'],
    })
  })

  it('deletes by id and leaves the rest', () => {
    const two = upsertSource(
      upsertSource(WITH_KEYS, channel('A', '1'), null),
      channel('B', '2'),
      null,
    )
    expect(deleteSource(two, 'a').sources.map((s) => s.id)).toEqual(['b'])
  })

  it('reorders one place and stops at the ends', () => {
    let c = WITH_KEYS
    for (const [n, d] of [
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ] as const) {
      c = upsertSource(c, channel(n, d), null)
    }
    expect(moveSource(c, 'c', -1).sources.map((s) => s.id)).toEqual(['a', 'c', 'b'])
    expect(moveSource(c, 'a', 1).sources.map((s) => s.id)).toEqual(['b', 'a', 'c'])
    expect(moveSource(c, 'a', -1)).toBe(c)
    expect(moveSource(c, 'c', 1)).toBe(c)
    expect(moveSource(c, 'zzz', 1)).toBe(c)
  })

  it('offers only bound roles as steps', () => {
    expect(boundStepRoles(WITH_KEYS)).toEqual([
      'input',
      'down',
      'ok',
      'digit_0',
      'digit_1',
      'digit_2',
      'digit_3',
      'digit_4',
      'digit_5',
      'digit_6',
      'digit_7',
      'digit_8',
      'digit_9',
    ])
    expect(boundStepRoles(EMPTY_REMOTE_CONFIG)).toEqual([])
  })

  it('maps the schema issues to the field they name', () => {
    expect(draftIssues(WITH_KEYS, channel('Rai 1', '1'), null)).toEqual([])
    expect(draftIssues(WITH_KEYS, channel('', '1'), null).map((i) => i.field)).toEqual(['name'])
    expect(draftIssues(WITH_KEYS, channel('Rai', '1234567'), null).map((i) => i.field)).toEqual([
      'number',
    ])
    const seq = { ...BLANK_SOURCE_DRAFT, kind: 'sequence' as const, name: 'Menu' }
    expect(draftIssues(WITH_KEYS, seq, null).map((i) => i.field)).toEqual(['steps'])
  })

  it('reports an unbound step, a duplicate name and a duplicate number from the schema', () => {
    const seq = {
      ...BLANK_SOURCE_DRAFT,
      kind: 'sequence' as const,
      name: 'Menu',
      steps: ['menu'],
    }
    const issue = draftIssues(WITH_KEYS, seq, null)[0]
    expect(issue).toMatchObject({ field: 'steps', code: 'custom' })
    expect(issue?.message).toContain('not bound')

    const one = upsertSource(WITH_KEYS, channel('Rai 1', '1'), null)
    expect(draftIssues(one, channel('RAI 1', '2'), null).map((i) => i.field)).toEqual(['name'])
    expect(draftIssues(one, channel('Other', '1'), null).map((i) => i.field)).toEqual(['number'])
    // a name that is another source's channel number reaches two sources
    expect(
      draftIssues(
        one,
        { ...BLANK_SOURCE_DRAFT, kind: 'sequence', name: '1', steps: ['ok'] },
        null,
      ).map((i) => i.field),
    ).toContain('name')
  })

  it("does not blame a source for another source's problem, and finds a source broken by clearBinding", () => {
    const one = upsertSource(
      WITH_KEYS,
      { ...BLANK_SOURCE_DRAFT, kind: 'sequence', name: 'Menu', steps: ['ok'] },
      null,
    )
    expect(sourceIssues(one).bySource.size).toBe(0)
    const broken = clearBinding(one, 'ok')
    expect(sourceIssues(broken).bySource.get(0)?.[0]).toMatchObject({ field: 'steps' })
    expect(checkForSave(broken).config).toBeNull()
    expect(draftIssues(broken, channel('X', '9'), null)).toEqual([])
  })

  it('refuses a channel whose digit buttons are not bound, on the steps field', () => {
    const noDigits = bound(['ok'])
    expect(
      draftIssues(noDigits, channel('Rai 1', '12'), null).map((i) => [i.field, i.code]),
    ).toEqual([
      ['steps', 'custom'],
      ['steps', 'custom'],
    ])
  })

  it('validates the step delay against the schema bounds', () => {
    expect(sourceIssues(setStepDelay(WITH_KEYS, 500)).stepDelay).toBeNull()
    expect(sourceIssues(setStepDelay(WITH_KEYS, 50)).stepDelay).not.toBeNull()
    expect(sourceIssues(setStepDelay(WITH_KEYS, 3001)).stepDelay).not.toBeNull()
    expect(sourceIssues(setStepDelay(WITH_KEYS, Number.NaN)).stepDelay).not.toBeNull()
    expect(checkForSave(setStepDelay(WITH_KEYS, 50)).config).toBeNull()
  })
})

describe('remote-config-model: infrared sources (planning#464)', () => {
  const base = { ...EMPTY_REMOTE_CONFIG, defaultTransmitterId: 7 }
  const irDraft: SourceDraft = {
    ...BLANK_SOURCE_DRAFT,
    kind: 'ir',
    name: 'HDMI 2',
    transmitterId: 7,
    encoding: 'raw',
    code: '[9000, -4500, 560,-560]',
    carrierKhz: '38',
  }

  it('reads a typed raw train, in brackets or not, into a payload with its carrier', () => {
    const next = upsertSource(base, irDraft, null)
    expect(next.sources).toEqual([
      {
        id: 'hdmi-2',
        kind: 'ir',
        name: 'HDMI 2',
        transmitterId: 7,
        payload: {
          kind: 'raw',
          timings: [9000, -4500, 560, -560],
          settings: { carrierHz: 38000 },
        },
      },
    ])
    expect(draftIssues(base, irDraft, null)).toEqual([])
    expect(checkForSave(next).config).not.toBeNull()
  })

  it('keeps a Pronto code as Pronto and round-trips a source back into its draft', () => {
    const pronto = {
      ...irDraft,
      encoding: 'pronto' as const,
      code: '0000 006D 0001 0000 00AC 00AC',
    }
    const next = upsertSource(base, pronto, null)
    const stored = next.sources[0]
    expect(stored).toMatchObject({ kind: 'ir', payload: { kind: 'pronto' } })
    expect(stored === undefined ? null : draftOfSource(stored)).toMatchObject({
      kind: 'ir',
      transmitterId: 7,
      encoding: 'pronto',
      code: '0000 006D 0001 0000 00AC 00AC',
      carrierKhz: '',
    })
    const raw = upsertSource(base, irDraft, null).sources[0]
    expect(raw === undefined ? null : draftOfSource(raw)).toMatchObject({
      encoding: 'raw',
      code: '9000, -4500, 560, -560',
      carrierKhz: '38',
    })
  })

  it('lets the schema refuse a missing transmitter, a bad code and a non-numeric carrier, on their fields', () => {
    const fields = (draft: SourceDraft) => draftIssues(base, draft, null).map((i) => i.field)
    const noDefault = { ...base, defaultTransmitterId: null }
    expect(
      draftIssues(noDefault, { ...irDraft, transmitterId: null }, null).map((i) => i.field),
    ).toEqual(['transmitterId'])
    // With a default on the remote, a source with no emitter of its own is fine.
    expect(fields({ ...irDraft, transmitterId: null })).toEqual([])
    expect(fields({ ...irDraft, code: '9000 4500' })).toEqual(['payload'])
    expect(fields({ ...irDraft, code: '9000, abc' })).toEqual(['payload'])
    expect(fields({ ...irDraft, carrierKhz: 'x' })).toEqual(['payload'])
    expect(fields({ ...irDraft, encoding: 'pronto', code: 'zz' })).toEqual(['payload'])
  })

  it('summarises a source for the list: pulses and carrier, or that the code is broken', () => {
    const ok = upsertSource(base, irDraft, null).sources[0]
    expect(ok?.kind === 'ir' ? irSourceSummary(ok) : null).toEqual({
      encoding: 'raw',
      pulses: 4,
      carrierKhz: 38,
    })
    const broken = upsertSource(base, { ...irDraft, code: '9000 4500' }, null).sources[0]
    expect(broken?.kind === 'ir' ? irSourceSummary(broken) : null).toEqual({
      encoding: 'raw',
      pulses: null,
      carrierKhz: null,
    })
  })
})

describe('remote-config-model: Flipper-IRDB import', () => {
  const FILE =
    'Filetype: IR signals file\nVersion: 1\n#\nname: Power\ntype: parsed\nprotocol: Samsung32\naddress: 07 00 00 00\ncommand: 02 00 00 00\n' +
    '#\nname: Ch_up\ntype: parsed\nprotocol: RC5\naddress: 05 00 00 00\ncommand: 20 00 00 00\n'

  it('turns a .ir file into bindings and lists the button it cannot send', () => {
    const result = importFlipperIr(FILE, 7)
    if (result.status !== 'ok') throw new Error(result.reason)
    expect(Object.keys(result.draft.bindings)).toEqual(['power'])
    expect(result.bound).toBe(1)
    expect(result.skipped).toEqual([{ name: 'Ch_up', reason: expect.stringContaining('RC5') }])
  })

  it('refuses without a transmitter and on text that is not a .ir file', () => {
    expect(importFlipperIr(FILE, null)).toEqual({ status: 'refused', reason: 'no-transmitter' })
    expect(importFlipperIr('nope', 7)).toEqual({ status: 'refused', reason: 'not-flipper' })
  })
})

describe('a native infrared code', () => {
  it('round-trips through the draft and is summarised from its decoded pulses', async () => {
    const { encodeTuya } = await import('@camstack/types')
    const code = encodeTuya([9000, -4500, 560, -560])
    const source = {
      id: 'tv',
      kind: 'ir' as const,
      name: 'TV',
      transmitterId: 5,
      payload: { kind: 'native' as const, format: 'tuya' as const, code },
    }
    const draft = draftOfSource(source)
    expect(draft).toMatchObject({ encoding: 'native', nativeFormat: 'tuya', code })
    expect(irSourceSummary(source)).toEqual({ encoding: 'native', pulses: 4, carrierKhz: null })
  })
})
