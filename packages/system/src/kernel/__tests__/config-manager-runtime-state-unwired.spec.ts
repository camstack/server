/**
 * A runtime-state read before the settings store is wired (the D294 window)
 * is a read that did not ANSWER, never an empty row (D677, D49). It used to
 * return `{}`; the mirror took that as the row it had read and its writer
 * replaced the real row with memory's partial picture.
 *
 * Neutralisation: restore `if (this.settingsStore === null) return {}` in
 * `ConfigManager.getDeviceRuntimeState` — both tests go red.
 */
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigManager } from '../config-manager.js'
import { SettingsReadUnavailableError } from '../settings-read-error.js'

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')

describe('ConfigManager runtime state before the store is wired (D677)', () => {
  it('getDeviceRuntimeState throws instead of answering {}', () => {
    const config = new ConfigManager(NO_CONFIG_FILE)
    expect(() => config.getDeviceRuntimeState('101')).toThrow(SettingsReadUnavailableError)
    expect(() => config.getDeviceRuntimeState('101')).toThrow(/\(not-wired\)/)
  })

  it('the settings view read rejects, so the mirror never seeds an unasked row', async () => {
    const config = new ConfigManager(NO_CONFIG_FILE)
    const view = config.createSettingsView('device-manager')
    await expect(view.readDeviceRuntimeState(101)).rejects.toThrow(SettingsReadUnavailableError)
    await expect(view.readDeviceRuntimeState(101)).rejects.toThrow(/\(not-wired\)/)
  })
})
