import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOtaPayload, readOtaNotifyUrl, whatsNewNotes } from '../lib/ota-notify.mjs'

const SOURCE = `export const WHATS_NEW = [
  {
    version: '1.0.692',
    date: '2026-11-08',
    notes: {
      en: ['The stove shows its switch.', "The remote's Sources key."],
      it: ['La stufa mostra l\\'interruttore.', 'Il tasto Sorgenti.'],
    },
  },
  {
    version: '1.0.691',
    date: '2026-11-07',
    notes: { en: ['Older.'], it: ['Vecchia.'] },
  },
]`

describe('whatsNewNotes', () => {
  it('reads one version, one language, both quote styles and escapes', () => {
    expect(whatsNewNotes(SOURCE, '1.0.692', 'en')).toEqual([
      'The stove shows its switch.',
      "The remote's Sources key.",
    ])
    expect(whatsNewNotes(SOURCE, '1.0.692', 'it')).toEqual([
      "La stufa mostra l'interruttore.",
      'Il tasto Sorgenti.',
    ])
  })

  it('never borrows the next entry', () => {
    expect(whatsNewNotes(SOURCE, '1.0.691', 'it')).toEqual(['Vecchia.'])
  })

  it('is empty for a version with no entry', () => {
    expect(whatsNewNotes(SOURCE, '9.9.9', 'en')).toEqual([])
  })
})

describe('buildOtaPayload', () => {
  const payload = buildOtaPayload({
    version: '1.0.692',
    runtimeVersion: '1.0.600',
    commit: 'd5b5cf38',
    notes: ['A.', 'B.'],
    channel: 'production',
    projectName: 'camstack',
    accountName: 'zentik-notifier',
    at: Date.UTC(2026, 10, 8, 14, 0),
  })

  // The receiver's ZENTIK_EXPO validate(): required fields, ios|android,
  // finished|errored|canceled, and a build field so it reads as a build.
  it('passes the receiver validation', () => {
    for (const k of ['id', 'accountName', 'projectName', 'platform', 'status'] as const) {
      expect(payload[k]).toBeTruthy()
    }
    expect(['ios', 'android']).toContain(payload.platform)
    expect(payload.status).toBe('finished')
    expect(payload.buildDetailsPageUrl).toContain('/projects/camstack/updates')
  })

  it('carries version, channel and notes where the receiver prints them', () => {
    expect(payload.metadata.appVersion).toBe('1.0.692')
    expect(payload.metadata.buildProfile).toContain('production')
    expect(payload.metadata.gitCommitMessage).toBe('A. · B.')
  })
})

describe('readOtaNotifyUrl', () => {
  it('is null when the file is missing or empty, so the ship skips the notification', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-notify-'))
    expect(readOtaNotifyUrl(path.join(dir, 'missing'))).toBeNull()
    const empty = path.join(dir, 'empty')
    fs.writeFileSync(empty, '  \n')
    expect(readOtaNotifyUrl(empty)).toBeNull()
    const set = path.join(dir, 'set')
    fs.writeFileSync(set, 'https://receiver.test/hook\n')
    expect(readOtaNotifyUrl(set)).toBe('https://receiver.test/hook')
  })
})
