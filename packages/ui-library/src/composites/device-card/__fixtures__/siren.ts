/** The siren page of the approved mockup. */
import type { SirenCardModel } from '../scenes/siren/model'
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

export function sirenFixtures(): readonly SirenFixture[] {
  return [
    {
      id: 'siren-silent',
      caption: 'Silenziosa',
      orientation: 'vertical',
      model: {
        common: outdoor(),
        activity: 'silent',
        since: '2 g',
        switchable: true,
      },
    },
    {
      id: 'siren-sounding',
      caption: 'Suona',
      orientation: 'vertical',
      model: {
        common: outdoor(),
        activity: 'sounding',
        since: '30 s',
        switchable: true,
      },
    },
    {
      id: 'siren-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: {
        common: offline(outdoor()),
        activity: 'silent',
        since: null,
        switchable: true,
      },
    },
    {
      id: 'siren-readonly',
      caption: 'Sola lettura',
      orientation: 'vertical',
      model: {
        common: readOnly(outdoor()),
        activity: 'silent',
        since: '2 g',
        switchable: true,
      },
    },
    {
      id: 'siren-horizontal',
      caption: 'Orizzontale',
      orientation: 'horizontal',
      model: {
        common: outdoor(),
        activity: 'sounding',
        since: '30 s',
        switchable: true,
      },
    },
  ]
}
