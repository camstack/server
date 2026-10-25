/**
 * D692 Task 15 — the grouped rule's live card: "1 open window · 1 waiting", in both
 * languages, and the parser that refuses an answer it cannot read (D315: an unreadable list
 * is never "no window open").
 */
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/en.json'
import itJson from '../../../i18n/it.json'
import { GroupedStatusLines } from '../NotificationRuleStatus'
import {
  groupedStatusCounts,
  type NcGroupedStatus,
  parseRuleStatus,
} from '../notification-rule-status'

const WINDOW = {
  deviceId: 104,
  windowKey: 'w1',
  openedAt: 100_000,
  closesAt: 120_000,
  members: 2,
  pending: 1,
}

const RAW = { kind: 'grouped', groupingSec: 20, openWindows: [WINDOW] }

async function renderIn(language: 'en' | 'it', status: NcGroupedStatus): Promise<void> {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, it: { translation: itJson } },
    lng: language,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  render(
    <I18nextProvider i18n={i18n}>
      <GroupedStatusLines status={status} now={110_000} name={(id) => `cam ${String(id)}`} />
    </I18nextProvider>,
  )
}

describe('parseRuleStatus — grouped', () => {
  it('reads the open windows', () => {
    expect(parseRuleStatus(RAW)).toEqual(RAW)
  })

  it('an unreadable window list is NOT "no window open": the whole answer is null', () => {
    expect(parseRuleStatus({ kind: 'grouped', groupingSec: 20 })).toBeNull()
    expect(
      parseRuleStatus({ kind: 'grouped', groupingSec: 20, openWindows: [{ deviceId: 1 }] }),
    ).toBeNull()
  })

  it('an explicit null list is UNKNOWN, kept with its reason, never an empty list', () => {
    const raw = {
      kind: 'grouped',
      groupingSec: 20,
      openWindows: null,
      reason: 'this node does not run rule evaluation',
    }
    expect(parseRuleStatus(raw)).toEqual(raw)
  })

  it('counts windows and the members still waiting', () => {
    expect(groupedStatusCounts([WINDOW, { ...WINDOW, windowKey: 'w2', pending: 2 }])).toEqual({
      windows: 2,
      waiting: 3,
    })
  })
})

describe('GroupedStatusLines', () => {
  it('renders "1 open window · 1 waiting" and the window line', async () => {
    await renderIn('en', { kind: 'grouped', groupingSec: 20, openWindows: [WINDOW] })
    expect(screen.getByTestId('nc-grouped-status-headline').textContent).toBe(
      '1 open window · 1 waiting',
    )
    expect(
      screen.getByText('cam 104 · 2 in the window · 1 waiting · closes within 10 s'),
    ).toBeTruthy()
  })

  it('speaks Italian under it', async () => {
    await renderIn('it', { kind: 'grouped', groupingSec: 20, openWindows: [WINDOW] })
    expect(screen.getByTestId('nc-grouped-status-headline').textContent).toBe(
      '1 finestra aperta · 1 in attesa',
    )
  })

  it('unknown windows render as unknown with the reason, never "No window open"', async () => {
    await renderIn('en', {
      kind: 'grouped',
      groupingSec: 20,
      openWindows: null,
      reason: 'this node does not run rule evaluation',
    })
    const text = screen.getByTestId('nc-grouped-status-headline').textContent
    expect(text).toBe('Open windows unknown — this node does not run rule evaluation')
    expect(text).not.toMatch(/No window open/)
  })

  it('no window open is stated, not left blank', async () => {
    await renderIn('en', { kind: 'grouped', groupingSec: 20, openWindows: [] })
    expect(screen.getByTestId('nc-grouped-status-headline').textContent).toBe('No window open')
  })
})
