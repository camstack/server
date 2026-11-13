/** The transmitter card: unknown, a board that can learn, and one that just read a code. */
import type { IrTransmitterCardModel } from '../scenes/ir/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface IrFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: IrTransmitterCardModel
}

function common(name: string, integration: string): IrTransmitterCardModel['common'] {
  const base = mockupCommon({
    name,
    integration,
    watts: 0,
    supplyName: '',
    consumables: [],
    remote: [],
  })
  return {
    ...base,
    power: null,
    battery: null,
    supply: null,
    consumables: null,
    remote: null,
    history: null,
  }
}

const readings = (
  canLearn: string,
  lastSend: string,
  lastLearn: string,
): IrTransmitterCardModel['readings'] => [
  { id: 'canLearn', label: 'Può apprendere', value: canLearn },
  { id: 'lastSend', label: 'Ultimo invio', value: lastSend },
  { id: 'lastLearn', label: 'Ultimo apprendimento', value: lastLearn },
]

export function irFixtures(): readonly IrFixture[] {
  return [
    {
      id: 'ir-unknown',
      caption: 'Stato non ancora letto',
      orientation: 'vertical',
      model: {
        common: common('Blaster', 'Zigbee2MQTT'),
        headline: '—',
        since: null,
        tone: 'muted',
        readings: readings('—', '—', '—'),
        learned: null,
        learnLabel: 'Apprendi un codice',
        learnEnabled: false,
      },
    },
    {
      id: 'ir-ready',
      caption: 'Infrarossi, può apprendere',
      orientation: 'vertical',
      model: {
        common: common('Soggiorno', 'Zigbee2MQTT'),
        headline: 'IR',
        since: '12 min',
        tone: 'success',
        readings: readings('Sì', '12 min · Inviato · IR', '2 h · Niente appreso in tempo'),
        learned: null,
        learnLabel: 'Apprendi un codice',
        learnEnabled: true,
      },
    },
    {
      id: 'ir-learned',
      caption: 'Codice appena letto',
      orientation: 'horizontal',
      model: {
        common: common('RF', 'ESPHome'),
        headline: 'RF',
        since: null,
        tone: 'muted',
        readings: readings('No', 'Mai', 'Mai'),
        learned: 'tuya: AxAAIABAAw==',
        learnLabel: 'Apprendi un codice',
        learnEnabled: false,
      },
    },
  ]
}
