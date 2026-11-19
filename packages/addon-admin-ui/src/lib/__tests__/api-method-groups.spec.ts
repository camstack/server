/**
 * The API explorer's macro groups (planning#595): a router lands in one group,
 * an unlisted router in `other`, and no method is ever dropped by the split.
 */
import { describe, expect, it } from 'vitest'
import { API_GROUP_IDS, groupMethods, groupOfRouter, unmappedRouters } from '../api-method-groups'

const m = (router: string, method = 'x') => ({ router, path: `${router}.${method}` })

describe('groupOfRouter', () => {
  it('maps routers of each area to its group', () => {
    expect(groupOfRouter('deviceManager')).toBe('devices')
    expect(groupOfRouter('ptz')).toBe('camerasMedia')
    expect(groupOfRouter('pipelineOrchestrator')).toBe('pipeline')
    expect(groupOfRouter('recordingArchive')).toBe('recordings')
    expect(groupOfRouter('notificationRules')).toBe('notifications')
    expect(groupOfRouter('addons')).toBe('integrations')
    expect(groupOfRouter('auth')).toBe('system')
  })

  it('sends an unlisted router to other', () => {
    expect(groupOfRouter('brandNewRouter')).toBe('other')
    expect(groupOfRouter('')).toBe('other')
  })
})

describe('groupMethods', () => {
  const methods = [
    m('auth'),
    m('deviceManager', 'a'),
    m('deviceManager', 'b'),
    m('mystery'),
    m('ptz'),
  ]

  it('keeps every method, in exactly one group', () => {
    expect(groupMethods(methods).flatMap((g) => g.methods)).toHaveLength(methods.length)
  })

  it('orders groups by the fixed order and keeps unmapped routers visible under other', () => {
    const groups = groupMethods(methods)
    expect(groups.map((g) => g.id)).toEqual(['devices', 'camerasMedia', 'system', 'other'])
    expect(groups.find((g) => g.id === 'other')?.methods.map((x) => x.router)).toEqual(['mystery'])
  })

  it('returns nothing for no methods; other is the last group', () => {
    expect(groupMethods([])).toEqual([])
    expect(API_GROUP_IDS.at(-1)).toBe('other')
  })
})

describe('unmappedRouters', () => {
  it('lists the distinct routers that fell through, sorted', () => {
    expect(unmappedRouters(['zeta', 'auth', 'alpha', 'zeta'])).toEqual(['alpha', 'zeta'])
  })
})
