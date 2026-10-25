/**
 * The SHAPE of every alarm sentence: a short headline, then labelled LISTS.
 *
 * The alarm used to speak in prose — "3 dispositivi attivi: Cancello, Front door,
 * Garage. Esclusi: Porta retro." — and an operator reading it on a lock screen
 * had to parse a sentence to find the one word that mattered (which window is
 * open). The advanced-notifier the operator came from says the same things as
 * `Label: a, b, c`, and that is what these tests pin: the countdown and the
 * mode live in the TITLE, and the body is one `Label: list` per device group.
 *
 * Pinned as SHAPE, not as prose: every one of these keys is overridable from
 * the Texts tab (D124), so what is defended here is that the shipped default
 * is a list line, that the list is non-empty when the builder had names, and
 * that both shipped locales say it the same way. A body key that grew a
 * paragraph again fails here rather than in somebody's pocket.
 */

import type { AlarmArmMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NC_LANGUAGES, type NcLanguage, NcTextCatalog } from '../../text-catalog.js'
import {
  buildArmAnnouncement,
  buildArmingAnnouncement,
  buildArmRefusedAnnouncement,
  type NcAlarmModeCoverage,
  type NcArmAnnouncementText,
} from '../alarm-mode-coverage.js'

const NAMES: Readonly<Record<number, string>> = {
  1: 'Finestra porch',
  2: 'Porta retro',
  3: 'Cancello',
}

const NAME = (id: number): string => NAMES[id] ?? `Device ${id}`

function coverage(patch: Partial<NcAlarmModeCoverage> = {}): NcAlarmModeCoverage {
  const mode: AlarmArmMode = 'home'
  return {
    mode,
    ruleCount: 1,
    allDevices: false,
    allDevicesExcept: [],
    deviceIds: [],
    skippedDevices: [],
    ...patch,
  }
}

function render(language: NcLanguage, text: NcArmAnnouncementText): string {
  const catalog = new NcTextCatalog({ language })
  return catalog.text({ key: text.bodyKey, count: text.textCount, vars: text.textParams })
}

/** Every line of a body is either a `Label: value` list line or a short
 *  statement — never a sentence with a list buried inside it. */
function lines(body: string): readonly string[] {
  return body.split('\n')
}

describe('the armed body', () => {
  it('lists the armed devices, one label, one list', () => {
    const text = buildArmAnnouncement(coverage({ deviceIds: [3, 1] }), NAME)
    expect(lines(render('it', text))).toEqual(['Attivi:', '• Cancello', '• Finestra porch'])
    expect(lines(render('en', text))).toEqual(['Active:', '• Cancello', '• Finestra porch'])
  })

  it('puts the exclusions on their own line', () => {
    const text = buildArmAnnouncement(
      coverage({ deviceIds: [1, 2], skippedDevices: [{ deviceId: 2, reason: 'muted' }] }),
      NAME,
    )
    expect(lines(render('it', text))).toEqual([
      'Esclusi:',
      '• Porta retro',
      'Attivi:',
      '• Finestra porch',
    ])
    expect(lines(render('en', text))).toEqual([
      'Excluded:',
      '• Porta retro',
      'Active:',
      '• Finestra porch',
    ])
  })

  it('names the bypassed sensors and what stayed armed', () => {
    const text = buildArmAnnouncement(coverage({ deviceIds: [1, 2, 3] }), NAME, [1])
    expect(lines(render('it', text))).toEqual([
      'Bypassati:',
      '• Finestra porch',
      'Attivi:',
      '• Porta retro',
      '• Cancello',
    ])
    expect(lines(render('en', text))).toEqual([
      'Bypassed:',
      '• Finestra porch',
      'Active:',
      '• Porta retro',
      '• Cancello',
    ])
  })

  it('says a covered-everything mode in one line', () => {
    const text = buildArmAnnouncement(coverage({ allDevices: true }), NAME)
    expect(render('it', text)).toBe('Attivi: tutti i dispositivi')
    expect(render('en', text)).toBe('Active: all devices')
  })

  it('says a mode that arms nothing without a paragraph about why', () => {
    const text = buildArmAnnouncement(coverage({ ruleCount: 0 }), NAME)
    for (const language of NC_LANGUAGES) {
      expect(render(language, text).length).toBeLessThanOrEqual(60)
    }
  })
})

describe('the arming body', () => {
  it('lists Active devices while the countdown is still in the title', () => {
    const text = buildArmingAnnouncement(coverage({ deviceIds: [3, 1] }), 30, NAME)
    expect(lines(render('it', text))).toEqual(['Attivi:', '• Cancello', '• Finestra porch'])
    expect(lines(render('en', text))).toEqual(['Active:', '• Cancello', '• Finestra porch'])
    expect(text.textParams['seconds']).toBe('30')
  })

  it('puts Active and Skipped on their own lines', () => {
    const text = buildArmingAnnouncement(
      coverage({ deviceIds: [1, 2], skippedDevices: [{ deviceId: 2, reason: 'offline' }] }),
      30,
      NAME,
    )
    expect(lines(render('it', text))).toEqual([
      'Esclusi:',
      '• Porta retro',
      'Attivi:',
      '• Finestra porch',
    ])
    expect(lines(render('en', text))).toEqual([
      'Excluded:',
      '• Porta retro',
      'Active:',
      '• Finestra porch',
    ])
  })

  it('names the bypassed sensors and what stayed armed', () => {
    const text = buildArmingAnnouncement(coverage({ deviceIds: [1, 2, 3] }), 30, NAME, [1])
    expect(lines(render('it', text))).toEqual([
      'Bypassati:',
      '• Finestra porch',
      'Attivi:',
      '• Porta retro',
      '• Cancello',
    ])
    expect(lines(render('en', text))).toEqual([
      'Bypassed:',
      '• Finestra porch',
      'Active:',
      '• Porta retro',
      '• Cancello',
    ])
    expect(text.textParams['seconds']).toBe('30')
  })

  it('says a covered-everything mode in one line', () => {
    const text = buildArmingAnnouncement(coverage({ allDevices: true }), 30, NAME)
    expect(render('it', text)).toBe('Attivi: tutti i dispositivi')
    expect(render('en', text)).toBe('Active: all devices')
  })
})

describe('the refusal body', () => {
  it('leads with the open sensors as a list', () => {
    const text = buildArmRefusedAnnouncement('home', ['Finestra porch', 'Porta retro'], false)
    expect(lines(render('it', text))).toEqual(['Aperti:', '• Finestra porch', '• Porta retro'])
    expect(lines(render('en', text))).toEqual(['Open:', '• Finestra porch', '• Porta retro'])
  })

  it('names the Arm anyway button on a second line when the row carries one', () => {
    const text = buildArmRefusedAnnouncement('away', ['Finestra porch'], true)
    expect(lines(render('en', text))).toEqual([
      'Open:',
      '• Finestra porch',
      'Tap “Arm anyway” to arm with them excluded.',
    ])
    expect(lines(render('it', text))).toEqual([
      'Aperti:',
      '• Finestra porch',
      'Tocca “Arma comunque” per armare escludendoli.',
    ])
  })
})

describe('every shipped alarm body', () => {
  it('is a list block, never a paragraph', () => {
    const shapes: readonly NcArmAnnouncementText[] = [
      buildArmAnnouncement(coverage({ deviceIds: [1, 2] }), NAME),
      buildArmAnnouncement(
        coverage({ deviceIds: [1, 2], skippedDevices: [{ deviceId: 2, reason: 'muted' }] }),
        NAME,
      ),
      buildArmAnnouncement(coverage({ deviceIds: [1, 2] }), NAME, [1]),
      buildArmAnnouncement(coverage({ allDevices: true }), NAME),
      buildArmAnnouncement(coverage({ ruleCount: 0 }), NAME),
      buildArmingAnnouncement(coverage({ deviceIds: [1, 2] }), 30, NAME),
      buildArmingAnnouncement(
        coverage({ deviceIds: [1, 2], skippedDevices: [{ deviceId: 2, reason: 'muted' }] }),
        30,
        NAME,
      ),
      buildArmingAnnouncement(coverage({ deviceIds: [1] }), 30, NAME, [1]),
      buildArmingAnnouncement(coverage({ deviceIds: [1, 2] }), 30, NAME, [1]),
      buildArmingAnnouncement(coverage({ allDevices: true }), 30, NAME),
      buildArmRefusedAnnouncement('home', ['Finestra porch'], true),
    ]
    for (const language of NC_LANGUAGES) {
      for (const text of shapes) {
        for (const line of lines(render(language, text))) {
          expect(line.length, `${language}:${text.bodyKey}`).toBeGreaterThan(0)
          // The verbosity bound. Anything longer is prose again.
          expect(line.length, `${language}:${text.bodyKey}:${line}`).toBeLessThanOrEqual(64)
        }
      }
    }
  })
})
