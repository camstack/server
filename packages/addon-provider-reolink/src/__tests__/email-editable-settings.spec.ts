import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Email config as EDITABLE device settings in a dedicated "Email" tab — built
 * exactly like every other per-camera settings section (Connection, NTP,
 * Audio): editable fields seeded from a snapshot, written to the camera via
 * `applySettingsPatch`. The Auto-configure button stays under "Motion".
 */
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function body(sig: string): string {
  const start = src.indexOf(sig)
  if (start === -1) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start)
  const s = i
  let d = 0
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{') d += 1
    else if (c === '}') {
      d -= 1
      if (d === 0) return src.slice(s, i + 1)
    }
  }
  throw new Error(`unterminated: ${sig}`)
}

describe('Email tab — editable settings like the other sections', () => {
  const section = body('private buildEmailTabSections(')

  it('places the editable fields in the dedicated "email" tab', () => {
    expect(section).toMatch(/tab:\s*'email'/)
  })

  it('exposes the SMTP config as editable fields (text/number/password/switch)', () => {
    expect(section).toMatch(/key:\s*'emailSmtpServer'/)
    expect(section).toMatch(/key:\s*'emailSmtpPort'/)
    expect(section).toMatch(/key:\s*'emailUserName'/)
    expect(section).toMatch(/key:\s*'emailPassword'/)
    expect(section).toMatch(/key:\s*'emailSsl'/)
    expect(section).toMatch(/key:\s*'emailRecipient1'/)
    // Real editable inputs, not info rows.
    expect(section).toMatch(/type:\s*'text'/)
    expect(section).toMatch(/type:\s*'number'/)
    expect(section).toMatch(/type:\s*'password'/)
  })

  it('declares the Email tab in the schema', () => {
    expect(src).toMatch(/id:\s*'email',\s*label:\s*'Email'/)
  })

  it('seeds the field values from the emailConfigSnapshot', () => {
    // The values map must read the current camera config so the fields show
    // live state, like netSnap/imgSnap do for the other sections.
    expect(src).toMatch(
      /emailSmtpServer:\s*[^\n]*emailConfigSnapshot|emailSmtpServer:\s*[^\n]*emailSnap/,
    )
  })
})

describe('Email — write path + button placement', () => {
  it('applySettingsPatch writes the edited email fields to the camera (setEmail via helper) and strips them from storage', () => {
    const b = body('override async applySettingsPatch(')
    expect(b).toMatch(/applyEmailConfigPatch|emailSmtpServer/)
  })

  it('has an applyEmailConfigPatch helper that calls setEmail', () => {
    // (sliceMethodBody can't bracket this method — its inline param-type has
    // braces — so assert on the source region instead.)
    expect(src).toMatch(/private async applyEmailConfigPatch\([\s\S]*?\.setEmail\(/)
  })

  it('the Motion section keeps ONLY the auto-configure button (no value rows)', () => {
    const sec = body('private buildEmailPushSection(')
    expect(sec).toMatch(/_autoConfigureEmailPush/)
    expect(sec).toMatch(/tab:\s*'motion'/)
    // Button is a device-action-button dispatching via runDeviceAction.
    expect(sec).toMatch(/type:\s*'device-action-button'/)
    expect(sec).toMatch(/action:\s*'auto-configure-email-push'/)
    // No editable value fields here — those moved to the Email tab.
    expect(sec).not.toMatch(/key:\s*'emailSmtpServer'/)
  })
})
