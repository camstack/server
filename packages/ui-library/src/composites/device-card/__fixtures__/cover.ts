/** The cover page of the approved mockup: one card per role, the mockup's data. */
import { DeviceRole } from '@camstack/types'
import { coverRoleSpec, type CoverCardModel, positionOf } from '../scenes/cover/model'
import type { CardCommon, CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface CoverFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: CoverCardModel
}

interface CoverRow {
  readonly role: DeviceRole
  readonly label: string
  readonly name: string
  readonly integration: string
  /** The mockup's value, in the role's own sense (closed / extended / open by N%). */
  readonly drawn: number
  readonly positionable: boolean
  readonly battery?: number
  readonly supply?: boolean
}

const ROWS: readonly CoverRow[] = [
  {
    role: DeviceRole.CoverShutter,
    label: 'Tapparella esterna',
    name: 'Tapparella salone',
    integration: 'Homematic',
    drawn: 40,
    positionable: true,
  },
  {
    role: DeviceRole.CoverBlind,
    label: 'Tenda a rullo',
    name: 'Tenda bagno camera',
    integration: 'Velux',
    drawn: 70,
    positionable: true,
    battery: 82,
  },
  {
    role: DeviceRole.CoverCurtain,
    label: 'Tenda',
    name: 'Tenda soggiorno',
    integration: 'Home Assistant',
    drawn: 50,
    positionable: true,
  },
  {
    role: DeviceRole.CoverAwning,
    label: 'Tenda da sole',
    name: 'Tenda terrazzo',
    integration: 'Home Assistant',
    drawn: 60,
    positionable: true,
  },
  {
    role: DeviceRole.CoverWindow,
    label: 'Finestra',
    name: 'Lucernario bagno',
    integration: 'Velux',
    drawn: 30,
    positionable: true,
  },
  {
    role: DeviceRole.CoverGarage,
    label: 'Porta garage',
    name: 'Garage',
    integration: 'Shelly',
    drawn: 100,
    positionable: false,
    supply: true,
  },
  {
    role: DeviceRole.CoverGate,
    label: 'Cancello',
    name: 'Cancello',
    integration: 'Home Assistant',
    drawn: 100,
    positionable: false,
  },
  {
    role: DeviceRole.CoverDoor,
    label: 'Porta',
    name: 'Porta box',
    integration: 'Home Assistant',
    drawn: 100,
    positionable: false,
  },
]

function commonOf(row: CoverRow): CardCommon {
  const base = mockupCommon({
    name: row.name,
    integration: row.integration,
    watts: 0,
    supplyName: 'Presa Velux',
    consumables: [
      { key: 'remote', label: 'Pile telecomando', percent: 40, resetLabel: 'Sostituite' },
    ],
    remote: [
      { id: 'up', label: 'Su', glyph: 'up' },
      { id: 'stop', label: 'Stop', glyph: 'stop' },
      { id: 'down', label: 'Giù', glyph: 'down' },
      { id: 'fav', label: 'Preferita' },
    ],
  })
  return {
    ...base,
    battery: row.battery === undefined ? null : { level: row.battery },
    supply: row.supply === true || row.role === DeviceRole.CoverBlind ? base.supply : null,
  }
}

export function coverFixtures(): readonly CoverFixture[] {
  return ROWS.map((row) => {
    const spec = coverRoleSpec(row.role)
    const position = positionOf(spec.kind, row.drawn)
    return {
      id: `cover-${spec.drawing}`,
      caption: `${row.label} · ${row.role}`,
      orientation: 'vertical',
      model: {
        common: commonOf(row),
        spec,
        position: row.positionable ? position : null,
        state: position >= 100 ? 'open' : position <= 0 ? 'closed' : 'stopped',
        positionable: row.positionable,
        stoppable: true,
        tilt:
          row.role === DeviceRole.CoverBlind || row.role === DeviceRole.CoverShutter ? 30 : null,
        since: '2 h',
      },
    }
  })
}
