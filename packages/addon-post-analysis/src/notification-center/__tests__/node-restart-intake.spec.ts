import { createEvent, type PendingRestartMarkerPayload } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { incomingFromSystemEvent } from '../event-intake.js'
import { NcTextCatalog } from '../text-catalog.js'

/**
 * D723: a node announcing its own restart is ONE bus category
 * (`system.restarting`) and TWO kinds. The split is the rule `server-updated`
 * already lives by — a `server-update:` reason is an update only with a
 * version — so the announcement and the landing of one marker never disagree.
 */
const noDevices = (): undefined => undefined

function restarting(data: PendingRestartMarkerPayload) {
  return incomingFromSystemEvent(
    createEvent('system.restarting', { type: 'core', id: 'agent-update-service' }, data),
    noDevices,
  )?.subject.systemEvent
}

describe('system.restarting → node-restarting / node-updating', () => {
  it('a plain restart is node-restarting, naming only the node', () => {
    const system = restarting({
      kind: 'manual',
      requestedAt: 1_000,
      requestedBy: 'server-update: manual restart',
      nodeId: 'agent-a',
    })
    expect(system).toMatchObject({
      kind: 'node-restarting',
      subject: 'node-restart:agent-a:1000',
      titleKey: 'system.node-restarting.title',
      bodyKey: 'system.node-restarting.body',
      textParams: { nodeId: 'agent-a' },
      nodeId: 'agent-a',
    })
    expect(system?.packageName).toBeUndefined()
  })

  it('an update-driven restart is node-updating, with node and both versions', () => {
    const system = restarting({
      kind: 'framework-update',
      requestedAt: 1_000,
      requestedBy: 'server-update: @camstack/server@1.2.500',
      packageName: '@camstack/server',
      fromVersion: '1.2.499',
      toVersion: '1.2.500',
      nodeId: 'agent-a',
    })
    expect(system).toMatchObject({
      kind: 'node-updating',
      subject: 'node-updating:agent-a:1.2.500',
      bodyKey: 'system.node-updating.body',
      textParams: {
        nodeId: 'agent-a',
        packageName: '@camstack/server',
        fromVersion: '1.2.499',
        toVersion: '1.2.500',
      },
      nodeId: 'agent-a',
      packageName: '@camstack/server',
    })
  })

  it('a server-update reason WITHOUT a version is a restart, not an update', () => {
    expect(
      restarting({ kind: 'system', requestedAt: 1, requestedBy: 'server-update: manual restart' })
        ?.kind,
    ).toBe('node-restarting')
  })

  it('reads the version off the reason when the payload has none', () => {
    const system = restarting({
      kind: 'system',
      requestedAt: 1,
      requestedBy: 'server-update: @camstack/server@1.2.501',
    })
    expect(system).toMatchObject({
      kind: 'node-updating',
      bodyKey: 'system.node-updating.body.toOnly',
      textParams: { toVersion: '1.2.501' },
    })
  })

  it("a payload with no nodeId is the hub's own", () => {
    expect(restarting({ kind: 'manual', requestedAt: 1 })?.nodeId).toBe('hub')
  })

  it('renders the sentences the operator reads, in both languages', () => {
    const system = restarting({
      kind: 'framework-update',
      requestedAt: 1,
      packageName: '@camstack/server',
      fromVersion: '1.2.499',
      toVersion: '1.2.500',
      nodeId: 'hub',
    })
    const italian = new NcTextCatalog({ language: 'it' })
    const en = new NcTextCatalog({ language: 'en' })
    const vars = system?.textParams ?? {}
    expect(en.text({ key: system?.bodyKey ?? '', vars })).toBe(
      '@camstack/server on hub is updating 1.2.499 → 1.2.500 and restarts now',
    )
    expect(italian.text({ key: system?.titleKey ?? '', vars })).toBe('Nodo in aggiornamento — hub')
    const plain = restarting({ kind: 'manual', requestedAt: 1, nodeId: 'mac-mini' })
    expect(en.text({ key: plain?.titleKey ?? '', vars: plain?.textParams ?? {} })).toBe(
      'Node restarting — mac-mini',
    )
  })
})
