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
  bindableRoles,
  checkForSave,
  clearBinding,
  importSmartIr,
  setBinding,
  transmitterOf,
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
    expect(result.draft.power.mode).toBe('toggle')
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
    expect(applied.power.mode).toBe('toggle')
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
