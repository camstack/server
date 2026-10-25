import { describe, expect, it } from 'vitest'
import type { NcIncomingEvent } from '../event-intake.js'
import { formatOutageDuration, withNodeLivenessFacts } from '../node-liveness-text.js'

function nodeEvent(online: boolean): NcIncomingEvent {
  const kind = online ? 'node-online' : 'node-offline'
  return {
    kind: 'system-event',
    origin: 'system',
    subject: {
      kind: 'system-event',
      recordId: `evt-${kind}`,
      deviceId: 0,
      timestamp: 1,
      classNames: [],
      zones: [],
      systemEvent: {
        kind,
        subject: 'node:agent-a',
        titleKey: `system.${kind}.title`,
        bodyKey: `system.${kind}.body.agent`,
        textParams: { nodeId: 'agent-a', nodeName: 'agent-a' },
        nodeId: 'agent-a',
        data: {},
      },
    },
    log: () => ({ tags: {}, meta: { kind } }),
  }
}

describe('formatOutageDuration', () => {
  it.each([
    [0, '0 s'],
    [45_000, '45 s'],
    [60_000, '1 min'],
    [44 * 60_000 + 4_000, '44 min'],
    [2 * 3_600_000, '2 h'],
    [2 * 3_600_000 + 5 * 60_000, '2 h 5 min'],
    [3 * 86_400_000 + 4 * 3_600_000, '3 d 4 h'],
    [86_400_000, '1 d'],
    [-5, '0 s'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatOutageDuration(ms)).toBe(text)
  })
})

describe('withNodeLivenessFacts', () => {
  it('names the node and leaves the offline body alone', () => {
    const event = nodeEvent(false)
    const out = withNodeLivenessFacts(event, { timing: { since: 5 }, nodeName: 'Unraid piccolo' })
    expect(out.subject.systemEvent?.textParams).toEqual({
      nodeId: 'agent-a',
      nodeName: 'Unraid piccolo',
    })
    expect(out.subject.systemEvent?.bodyKey).toBe('system.node-offline.body.agent')
    // immutable: the intake's object is untouched
    expect(event.subject.systemEvent?.textParams?.['nodeName']).toBe('agent-a')
  })

  it('a recovery with a known outage start says how long, via the .after body', () => {
    const out = withNodeLivenessFacts(nodeEvent(true), {
      timing: { since: 3_600_000 + 1_000, previousSince: 1_000 },
    })
    expect(out.subject.systemEvent?.bodyKey).toBe('system.node-online.body.agent.after')
    expect(out.subject.systemEvent?.textParams?.['offlineFor']).toBe('1 h')
  })

  it('a recovery from a merely SEEDED offline keeps the plain body', () => {
    const event = nodeEvent(true)
    const out = withNodeLivenessFacts(event, { timing: { since: 10 } })
    expect(out).toBe(event)
  })
})
