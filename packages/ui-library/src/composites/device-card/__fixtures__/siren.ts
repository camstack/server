/** The siren page of the approved design (2026-11-17). */
import type { SirenAdjustable, SirenCardModel } from '../scenes/siren/model'
import type { CardOrientation } from '../shell/model'
import { offline, readOnly } from './common'
import { deviceCommon } from './wave-d-common'

export interface SirenFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: SirenCardModel
}

const outdoor = () => deviceCommon({ name: 'Sirena esterna', integration: 'Ajax', battery: 71 })

/** A camera siren that declares both a duration list and a plays range. */
const ADJUSTABLE: SirenAdjustable = {
  durations: { values: [10, 30, 60], defaultValue: 30 },
  plays: { values: [1, 2, 3, 4, 5], defaultValue: 1 },
}

const NONE: SirenAdjustable = { durations: null, plays: null }

const base = (): SirenCardModel => ({
  common: outdoor(),
  activity: 'silent',
  since: '2 g',
  canTrigger: true,
  canStop: true,
  commandPending: false,
  run: null,
  adjustable: ADJUSTABLE,
  onMotion: true,
  onMotionPending: false,
})

export function sirenFixtures(): readonly SirenFixture[] {
  const now = Date.now()
  return [
    {
      id: 'siren-silent',
      caption: 'Silenziosa',
      orientation: 'vertical',
      model: base(),
    },
    {
      id: 'siren-sounding',
      caption: 'Suona — 18 s su 30',
      orientation: 'vertical',
      model: {
        ...base(),
        activity: 'sounding',
        since: '12 s',
        run: { endsAt: now + 18_000, totalMs: 30_000, estimated: false },
      },
    },
    {
      id: 'siren-sounding-open',
      caption: 'Suona — fine ignota',
      orientation: 'vertical',
      model: {
        ...base(),
        activity: 'sounding',
        since: '30 s',
        adjustable: NONE,
        onMotion: null,
        run: { endsAt: null, totalMs: null, estimated: false },
      },
    },
    {
      id: 'siren-switch-only',
      caption: 'Solo interruttore',
      orientation: 'vertical',
      model: { ...base(), adjustable: NONE, onMotion: null },
    },
    {
      id: 'siren-unknown',
      caption: 'Stato ignoto',
      orientation: 'vertical',
      model: { ...base(), activity: 'unknown', since: null },
    },
    {
      id: 'siren-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: { ...base(), common: offline(outdoor()), since: null },
    },
    {
      id: 'siren-readonly',
      caption: 'Sola lettura',
      orientation: 'vertical',
      model: { ...base(), common: readOnly(outdoor()) },
    },
    {
      id: 'siren-horizontal',
      caption: 'Orizzontale',
      orientation: 'horizontal',
      model: {
        ...base(),
        activity: 'sounding',
        since: '12 s',
        run: { endsAt: now + 18_000, totalMs: 30_000, estimated: true },
      },
    },
  ]
}
