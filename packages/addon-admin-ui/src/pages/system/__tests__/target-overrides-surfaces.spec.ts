/**
 * #487 / D1032 — the per-target panel is ONE component for the rule, summary,
 * timelapse and calendar-events editors. What each kind offers is an explicit
 * list, decided from what the server honours for that kind:
 *  - an event rule produces pictures and buttons: every field;
 *  - a summary produces one mosaic image and no buttons;
 *  - a timelapse produces a still/GIF preview and a clip, no buttons;
 *  - a calendar digest produces text only.
 */
import type { NcTargetAttachment } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  surfaceAttachmentKinds,
  surfaceShows,
  TARGET_SETTINGS_SURFACES,
  targetsFromOptions,
} from '../rule-form-target-settings'

describe('field lists per kind', () => {
  it('an event rule offers every field', () => {
    for (const field of ['title', 'body', 'priority', 'attachments', 'actions'] as const) {
      expect(surfaceShows('rule', field)).toBe(true)
    }
  })

  it('a summary has a mosaic but no buttons', () => {
    expect(surfaceShows('summary', 'attachments')).toBe(true)
    expect(surfaceShows('summary', 'actions')).toBe(false)
    expect(surfaceShows('summary', 'title')).toBe(true)
    expect(surfaceShows('summary', 'priority')).toBe(true)
  })

  it('a timelapse has pictures but no buttons', () => {
    expect(surfaceShows('timelapse', 'attachments')).toBe(true)
    expect(surfaceShows('timelapse', 'actions')).toBe(false)
  })

  it('a calendar digest is text only: no picture, no buttons', () => {
    expect(surfaceShows('calendar-events', 'attachments')).toBe(false)
    expect(surfaceShows('calendar-events', 'actions')).toBe(false)
    expect(surfaceShows('calendar-events', 'title')).toBe(true)
    expect(surfaceShows('calendar-events', 'body')).toBe(true)
    expect(surfaceShows('calendar-events', 'priority')).toBe(true)
  })

  it('names every kind explicitly', () => {
    expect(Object.keys(TARGET_SETTINGS_SURFACES).toSorted()).toEqual([
      'calendar-events',
      'rule',
      'summary',
      'timelapse',
    ])
  })
})

describe('picture kinds per kind: only what the rule actually produces', () => {
  const declared: readonly NcTargetAttachment[] = ['none', 'image', 'clip', 'gif']

  it('a summary can be told none or the image; a clip or GIF would only drop the mosaic', () => {
    expect(surfaceAttachmentKinds('summary', declared)).toEqual(['none', 'image'])
  })

  it('a timelapse can be told none, the image or the clip', () => {
    expect(surfaceAttachmentKinds('timelapse', declared)).toEqual(['none', 'image', 'clip'])
  })

  it('an event rule keeps what the notifier declares', () => {
    expect(surfaceAttachmentKinds('rule', declared)).toEqual(declared)
  })

  it('never offers what the notifier cannot send', () => {
    expect(surfaceAttachmentKinds('timelapse', ['none', 'image'])).toEqual(['none', 'image'])
  })

  it('a calendar digest has none', () => {
    expect(surfaceAttachmentKinds('calendar-events', declared)).toEqual([])
  })
})

describe('targetsFromOptions', () => {
  it('keeps the kind of a described target and leaves an undescribed one unknown', () => {
    const targets = targetsFromOptions([
      { id: 'a', name: 'A', enabled: true, kind: 'push', addonId: 'notifiers' },
      { id: 'b', name: 'B', enabled: true },
    ])
    expect(targets).toEqual([
      { id: 'a', name: 'A', enabled: true, kind: 'push', addonId: 'notifiers', config: {} },
      { id: 'b', name: 'B', enabled: true, kind: '', addonId: '', config: {} },
    ])
  })
})
