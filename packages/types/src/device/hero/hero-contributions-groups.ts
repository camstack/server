/**
 * What a group's caps and an event emitter add to a hero (D1023). A group
 * (`group-active`, `group-status`, `group-commands`) is a device whose members
 * answer for it: it contributes the facts about its members, no controls of its
 * own (the member caps carry those). An event emitter has no controls either;
 * it says what it last fired. Unknown is never off (D315/D393).
 */
import { EventEmitterStatusSchema } from '../../capabilities/event-emitter.cap.js'
import { GroupActiveSchema } from '../../capabilities/group-active.cap.js'
import { GroupCommandsSchema } from '../../capabilities/group-commands.cap.js'
import { GroupStatusSchema } from '../../capabilities/group-status.cap.js'
import {
  contribution,
  elapsedText,
  fact,
  reading,
  type HeroContribution,
} from './hero-contribution-kit.js'
import { heroText } from './hero-text.js'

const groupActiveContribution = contribution('group-active', GroupActiveSchema, (slice) => {
  if (slice === undefined) return { reading: reading('group-active', 'unknown') }
  return {
    reading: reading(
      'group-active',
      slice.active ? 'on' : 'off',
      false,
      slice.active ? heroText('Active', 'Attivo') : heroText('Inactive', 'Non attivo'),
    ),
  }
})

const groupStatusContribution = contribution('group-status', GroupStatusSchema, (slice) => {
  if (slice === undefined) return {}
  const text =
    slice.excluded === 0
      ? heroText(`${slice.total} members`, `${slice.total} membri`)
      : heroText(
          `${slice.included} of ${slice.total} reporting`,
          `${slice.included} di ${slice.total} rispondono`,
        )
  return {
    facts: [fact('members', 'users', text, slice.excluded === 0 ? 'muted' : 'warning')],
    tiles: { left: [{ label: heroText('Members', 'Membri'), value: text }] },
  }
})

const groupCommandsContribution = contribution('group-commands', GroupCommandsSchema, (slice) => {
  if (slice === undefined) return {}
  const failed = slice.results.filter((r) => !r.ok).length
  if (failed === 0) return {}
  const total = slice.results.length
  return {
    facts: [
      fact(
        'failures',
        'triangle-alert',
        heroText(`${failed} of ${total} failed`, `${failed} di ${total} falliti`),
        'danger',
      ),
    ],
  }
})

const eventEmitterContribution = contribution(
  'event-emitter',
  EventEmitterStatusSchema,
  (slice, ctx) => {
    if (slice === undefined) return { reading: reading('event-emitter', 'unknown') }
    const last = slice.lastEvent
    const ago = last === null ? null : elapsedText(last.timestamp, ctx.now)
    return {
      reading: reading('event-emitter', 'idle', false, heroText('Listening', 'In ascolto')),
      ...(last === null
        ? {}
        : {
            facts: [
              fact(
                'event',
                'radio-tower',
                ago === null
                  ? heroText(last.eventType, last.eventType)
                  : heroText(`${last.eventType} · ${ago.en}`, `${last.eventType} · ${ago.it}`),
                'primary',
              ),
            ],
          }),
      tiles: {
        right: [
          {
            label: heroText('Events', 'Eventi'),
            value: heroText(`${slice.eventCountSinceStart}`, `${slice.eventCountSinceStart}`),
          },
        ],
      },
    }
  },
)

export const GROUPS_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  'group-active': groupActiveContribution,
  'group-status': groupStatusContribution,
  'group-commands': groupCommandsContribution,
  'event-emitter': eventEmitterContribution,
}
