import { describe, expect, it } from 'vitest'
import type { Integration } from '../../components/integrations/integration-columns'
import { groupIntegrationsByAddon } from '../integration-addon-groups'

const row = (
  id: string,
  addonId: string,
  name: string,
  deviceCount: number,
  status: Integration['status'],
): Integration => ({ id, addonId, name, enabled: status !== 'disabled', status, deviceCount })

describe('groupIntegrationsByAddon', () => {
  it('makes one group per addon, so same-named instances of different addons stay apart', () => {
    const groups = groupIntegrationsByAddon(
      [
        row('a', 'provider-wyze', 'Casa', 2, 'running'),
        row('b', 'bosch-shc', 'Casa', 1, 'stopped'),
        row('c', 'provider-wyze', 'Garage', 3, 'disabled'),
      ],
      new Map([
        ['provider-wyze', 'Wyze'],
        ['bosch-shc', 'Bosch SHC'],
      ]),
    )
    expect(groups.map((g) => [g.addonId, g.name, g.instanceCount, g.deviceCount])).toEqual([
      ['provider-wyze', 'Wyze', 2, 5],
      ['bosch-shc', 'Bosch SHC', 1, 1],
    ])
  })

  it('is running if any instance runs, else stopped if any is stopped, else disabled', () => {
    const status = (...st: Integration['status'][]) =>
      groupIntegrationsByAddon(
        st.map((x, i) => row(String(i), 'x', 'n', 0, x)),
        new Map(),
      )[0]?.status
    expect(status('disabled', 'running')).toBe('running')
    expect(status('disabled', 'stopped')).toBe('stopped')
    expect(status('disabled')).toBe('disabled')
  })

  it('falls back to the first instance name while the addon name is unknown', () => {
    const [g] = groupIntegrationsByAddon([row('a', 'x', 'Casa', 0, 'running')], new Map())
    expect(g?.name).toBe('Casa')
  })
})
