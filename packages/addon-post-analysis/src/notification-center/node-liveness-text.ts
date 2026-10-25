/**
 * The facts a node online/offline notification can only know AFTER its
 * hold-off: the node's display name (the directory read is async, the intake is
 * not) and, on a recovery, how long the outage lasted.
 *
 * Pure: it returns a NEW incoming event, the intake's object is never touched.
 */
import type { NcIncomingEvent } from './event-intake.js'
import type { LivenessTiming } from './liveness-holdoff.js'

/** "45 s", "12 min", "2 h 5 min", "3 d 4 h" — unit symbols read the same in en and it. */
export function formatOutageDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec} s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin} min`
  const totalHours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  if (totalHours < 24) return minutes > 0 ? `${totalHours} h ${minutes} min` : `${totalHours} h`
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours > 0 ? `${days} d ${hours} h` : `${days} d`
}

export interface NodeLivenessFacts {
  readonly timing: LivenessTiming
  /** The directory's display name; absent = keep the id the intake froze. */
  readonly nodeName?: string
}

/**
 * Freeze the post-hold-off facts onto a node liveness event.
 *
 * - `nodeName`: the display name, when the directory knew one.
 * - `offlineFor` (recovery only, and only when the outage START is known — a
 *   state that was merely seeded after a restart has none): the outage length,
 *   with the `.after` body variant that says it.
 */
export function withNodeLivenessFacts(
  incoming: NcIncomingEvent,
  facts: NodeLivenessFacts,
): NcIncomingEvent {
  const system = incoming.subject.systemEvent
  if (system === undefined) return incoming
  const { since, previousSince } = facts.timing
  const recovered = system.kind === 'node-online' && previousSince !== undefined
  const name =
    facts.nodeName !== undefined && facts.nodeName.length > 0 ? facts.nodeName : undefined
  if (!recovered && name === undefined) return incoming
  const textParams: Readonly<Record<string, string>> = {
    ...system.textParams,
    ...(name !== undefined ? { nodeName: name } : {}),
    ...(recovered ? { offlineFor: formatOutageDuration(since - previousSince) } : {}),
  }
  return {
    ...incoming,
    subject: {
      ...incoming.subject,
      systemEvent: {
        ...system,
        ...(recovered ? { bodyKey: 'system.node-online.body.agent.after' } : {}),
        textParams,
      },
    },
  }
}
