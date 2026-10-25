import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Email Push device-settings section — must behave like the other sections
 * (Sessions / Audio / "Camera data"), NOT as a bespoke widget.
 *
 * Requirements (operator):
 *  1. NO "Read from camera" / "ready" button. The current on-device email
 *     config is shown like every other setting: populated by the standard
 *     "Refresh from camera" (`refreshParentSettingsSnapshot`) + wake refresh.
 *  2. TWO action buttons — HaCfg webhook + Email/SMTP Auto-configure — that
 *     point the camera at the matching local intake.
 *  3. Each button MUST be a `device-action-button` field that dispatches via
 *     `deviceManager.runDeviceAction` (typed device custom-actions registered
 *     in `registerNativeCapabilities`). This replaces the old
 *     `refresh-driver-data` sentinel pattern.
 *
 * Structural assertions (codebase convention — full ReolinkCamera needs the
 * whole DeviceContext mocked).
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let i = source.indexOf('{', start)
  if (i === -1) throw new Error(`opening brace not found for ${methodSignature}`)
  const bodyStart = i
  let depth = 0
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`closing brace not found for ${methodSignature}`)
}

describe('Email Push section — consistent with the other device settings', () => {
  const section = sliceMethodBody(cameraSource, 'private buildEmailPushSection(')

  it('has NO "read from camera" / "refresh email config" button', () => {
    expect(section).not.toMatch(/_refreshEmailConfig/)
    expect(section).not.toMatch(/refresh-email-config/)
    expect(section).not.toMatch(/Read from camera/i)
  })

  it('has TWO auto-configure buttons (HaCfg webhook + email) as device-action-button', () => {
    const deviceActionButtonCount = (section.match(/type:\s*'device-action-button'/g) ?? []).length
    expect(deviceActionButtonCount).toBe(2)
    expect(section).toMatch(/_autoConfigureEmailPush/)
    expect(section).toMatch(/_autoConfigureBaichuanWebhook/)
    expect(section).toMatch(/action:\s*'auto-configure-email-push'/)
    expect(section).toMatch(/action:\s*'auto-configure-baichuan-webhook'/)
    expect(section).not.toMatch(/action:\s*'refresh-driver-data'/)
  })

  it('exposes a sleep-push preference select', () => {
    expect(section).toMatch(/key:\s*'batterySleepPushMethod'/)
  })
})

describe('Email Push — value source + dispatch wiring', () => {
  it('the standard refresh (refreshParentSettingsSnapshot) reads the email config like other settings', () => {
    const body = sliceMethodBody(cameraSource, 'private async refreshParentSettingsSnapshot(')
    expect(body).toMatch(/refreshCameraEmailConfig\(/)
  })

  it('applySettingsPatch no longer has the auto-configure sentinel (now dispatched via runDeviceAction) and still lacks the read-from-camera one', () => {
    const body = sliceMethodBody(cameraSource, 'override async applySettingsPatch(')
    expect(body).not.toMatch(/_autoConfigureEmailPush/)
    expect(body).not.toMatch(/_refreshEmailConfig/)
  })

  it('registerNativeCapabilities registers the auto-configure-email-push device custom action', () => {
    expect(cameraSource).toMatch(/registerDeviceAction\(\s*\n?\s*'auto-configure-email-push'/)
    expect(cameraSource).toMatch(/deviceCustomAction\(/)
  })

  it('the reference _refreshSettings button is also a device-action-button (single convention, no legacy sentinel)', () => {
    // Guards against the convention silently changing out from under the email button.
    // The whole "click button → side-effect" surface is now the device custom-action
    // hook — the legacy refresh-driver-data sentinel was removed everywhere.
    expect(cameraSource).toMatch(
      /type:\s*'device-action-button'[\s\S]{0,160}key:\s*'_refreshSettings'/,
    )
    expect(cameraSource).toMatch(
      /key:\s*'_refreshSettings'[\s\S]{0,320}action:\s*'refresh-settings'/,
    )
    expect(cameraSource).not.toMatch(/action:\s*'refresh-driver-data'/)
  })

  it('registers the refresh-settings and refresh-sessions device custom actions', () => {
    expect(cameraSource).toMatch(/registerDeviceAction\(\s*\n?\s*'refresh-settings'/)
    expect(cameraSource).toMatch(/registerDeviceAction\(\s*\n?\s*'refresh-sessions'/)
  })

  it('applySettingsPatch no longer recognises the _refreshSettings / _refreshSessions sentinels', () => {
    const body = sliceMethodBody(cameraSource, 'override async applySettingsPatch(')
    expect(body).not.toMatch(/_refreshSettings/)
    expect(body).not.toMatch(/_refreshSessions/)
  })
})
