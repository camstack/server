/** The alarm page of the approved mockup. */
import type { AlarmCardModel } from '../scenes/alarm/model'
import type { CardOrientation } from '../shell/model'
import { offline } from './common'
import { deviceCommon } from './wave-d-common'

export interface AlarmFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: AlarmCardModel
}

const panel = () => deviceCommon({ name: 'Allarme casa', integration: 'Ajax', battery: 92 })

const base: Omit<AlarmCardModel, 'activity' | 'mode'> = {
  common: panel(),
  since: '1 h',
  modes: ['home', 'night', 'away'],
  requiresCode: false,
  canArm: true,
  canDisarm: true,
}

export function alarmFixtures(): readonly AlarmFixture[] {
  return [
    {
      id: 'alarm-disarmed',
      caption: 'Disinserito',
      orientation: 'vertical',
      model: { ...base, activity: 'disarmed', mode: null },
    },
    {
      id: 'alarm-away',
      caption: 'Inserito · fuori',
      orientation: 'vertical',
      model: { ...base, activity: 'armed', mode: 'away' },
    },
    {
      id: 'alarm-arming',
      caption: 'In inserimento · notte',
      orientation: 'vertical',
      model: { ...base, since: null, activity: 'arming', mode: 'night' },
    },
    {
      id: 'alarm-triggered',
      caption: 'Allarme scattato · con codice',
      orientation: 'vertical',
      model: {
        ...base,
        requiresCode: true,
        since: '2 min',
        activity: 'triggered',
        mode: 'away',
      },
    },
    {
      id: 'alarm-offline',
      caption: 'Offline',
      orientation: 'vertical',
      model: {
        ...base,
        common: offline(panel()),
        activity: 'armed',
        mode: 'home',
      },
    },
    {
      id: 'alarm-horizontal',
      caption: 'Orizzontale',
      orientation: 'horizontal',
      model: { ...base, activity: 'armed', mode: 'home' },
    },
  ]
}
