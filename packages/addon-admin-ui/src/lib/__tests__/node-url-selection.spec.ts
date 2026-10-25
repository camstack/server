/**
 * The `?node=` contract, shared by the Cluster and Addons pages.
 *
 * Two things are pinned here, and they are different:
 *
 *  - the ORDER nodes are offered in, and which one a page opens (this moved
 *    from `components/cluster/node-order.ts` on 2026-08-30 when the Addons
 *    page started reading the same parameter);
 *  - that a link naming a node this cluster does not have is REPORTED rather
 *    than silently redirected. A system-event notification taps into these
 *    pages now, so "opened the hub instead and said nothing" is the exact
 *    failure the outcome exists to prevent.
 */
import { describe, expect, it } from 'vitest'

import type { SelectableNode } from '../node-url-selection'
import { NODE_PARAM, orderNodes, resolveNodeSelection } from '../node-url-selection'

function node(id: string, name: string, isHub: boolean, isOnline: boolean): SelectableNode {
  return { id, name, isHub, isOnline }
}

const HUB = node('hub', 'hub', true, true)
const ONLINE_B = node('b', 'b-agent', false, true)
const ONLINE_A = node('a', 'a-agent', false, true)
const OFFLINE = node('z', 'z-agent', false, false)
/** Alphabetically FIRST and offline — the only shape that can prove the
 *  online-before-offline rule, since a `z-agent` sinks on its name alone. */
const OFFLINE_FIRST_BY_NAME = node('aa', 'aa-agent', false, false)

describe('the parameter name', () => {
  it('is `node` — the same string the notification tap URL mints', () => {
    // `packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts`
    // spells it independently; `scripts/check-notification-tap-targets.ts`
    // fails the build if the two ever disagree.
    expect(NODE_PARAM).toBe('node')
  })
})

describe('orderNodes', () => {
  it('puts the hub first whatever the topology order was', () => {
    expect(orderNodes([ONLINE_B, OFFLINE, HUB]).map((n) => n.id)).toEqual(['hub', 'b', 'z'])
  })

  it('sinks offline nodes below online ones, without dropping them', () => {
    // `aa-agent` sorts first by name and last by liveness — so this fails the
    // moment the liveness term is dropped, which an all-`z` fixture would not.
    expect(orderNodes([OFFLINE_FIRST_BY_NAME, ONLINE_B, ONLINE_A]).map((n) => n.id)).toEqual([
      'a',
      'b',
      'aa',
    ])
    expect(orderNodes([OFFLINE, ONLINE_B, ONLINE_A]).map((n) => n.id)).toEqual(['a', 'b', 'z'])
  })

  it('does not mutate its input', () => {
    const input = [ONLINE_B, HUB]
    orderNodes(input)
    expect(input.map((n) => n.id)).toEqual(['b', 'hub'])
  })
})

describe('resolveNodeSelection', () => {
  it('opens the hub when the URL asks for nothing', () => {
    const selection = resolveNodeSelection([ONLINE_B, HUB], null)
    expect(selection.node?.id).toBe('hub')
    expect(selection.outcome).toBe('default')
    expect(selection.staleNodeId).toBeNull()
  })

  it('honours an explicit request — the id in the link is the node on screen', () => {
    const selection = resolveNodeSelection([HUB, ONLINE_B], 'b')
    expect(selection.node?.id).toBe('b')
    expect(selection.outcome).toBe('requested')
  })

  it('honours a request for an OFFLINE node', () => {
    // A reload while diagnosing a dead agent must not bounce back to the hub —
    // that node is the reason the page is open. A notification about an update
    // on a node that has since dropped links here too.
    const selection = resolveNodeSelection([HUB, OFFLINE], 'z')
    expect(selection.node?.id).toBe('z')
    expect(selection.outcome).toBe('requested')
  })

  it('a node that LEFT the cluster falls back AND is named', () => {
    // The stale case a week-old notification produces. Falling back is right —
    // an empty page for an id nobody can select away from is worse — but the
    // fallback has to be visible, or the operator reads the hub's addon list
    // believing it is agent-a's.
    const selection = resolveNodeSelection([HUB, ONLINE_B], 'agent-a')
    expect(selection.node?.id).toBe('hub')
    expect(selection.outcome).toBe('stale')
    expect(selection.staleNodeId).toBe('agent-a')
  })

  it('an empty ?node= is "asked for nothing", not a stale id', () => {
    const selection = resolveNodeSelection([HUB], '')
    expect(selection.outcome).toBe('default')
    expect(selection.staleNodeId).toBeNull()
  })

  it('is null only when there are no nodes at all', () => {
    expect(resolveNodeSelection([], 'hub')).toEqual({
      node: null,
      outcome: 'empty',
      staleNodeId: null,
    })
    expect(resolveNodeSelection([], null).node).toBeNull()
  })

  it('falls back to the first agent when the cluster has no hub row', () => {
    expect(resolveNodeSelection([ONLINE_B, ONLINE_A], null).node?.id).toBe('a')
  })
})
