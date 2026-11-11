import type { EventVocabularyEntry, EventVocabularyKind } from '@camstack/types'
import type { HmChannel, HmDevice } from 'nodehomematic'
import { mapHmDeviceChannels } from '../homematic-mapping.js'
import {
  HM_KEY_PRESS_DATAPOINTS,
  HM_KEY_PRESS_SET,
  channelIndexFromAddress,
} from './hm-cold-start.js'

/**
 * The event vocabulary of a Homematic remote or wall switch (D1044).
 *
 * Each key channel is one button: a source. Its entries are the `PRESS_*`
 * datapoints that channel has, token verbatim, each with the kind every
 * integration shares. The source id is the channel index, which is what a
 * press carries (`channelIndexFromAddress`).
 *
 * The library does not expose the name a CCU gives a channel, so a button
 * is labelled by its position among the key channels, with the channel
 * index beside it.
 */

interface PressMeaning {
  readonly label: string
  readonly kind: EventVocabularyKind
}

const PRESS_MEANING: Readonly<Record<string, PressMeaning>> = {
  PRESS_SHORT: { label: 'Short press', kind: 'press' },
  PRESS_LONG: { label: 'Long press', kind: 'long-press' },
  PRESS_LONG_START: { label: 'Long press started', kind: 'long-press-start' },
  PRESS_LONG_RELEASE: { label: 'Long press released', kind: 'release' },
  PRESS_CONT: { label: 'Long press held', kind: 'repeat' },
}

/** The channels of a device that are buttons, in channel order. */
export function hmKeyChannels(device: Pick<HmDevice, 'channels'>): readonly HmChannel[] {
  return mapHmDeviceChannels(device)
    .filter(({ mapping }) => mapping.capabilities.includes('event-emitter'))
    .map(({ channel }) => channel)
}

/** The presses one key channel has; the standard set when it lists none. */
function pressesOf(channel: HmChannel): readonly string[] {
  const listed = new Set(
    (channel.dataPoints ?? [])
      .map((dataPoint) => dataPoint.parameter)
      .filter((parameter) => HM_KEY_PRESS_SET.has(parameter)),
  )
  if (listed.size === 0) return HM_KEY_PRESS_DATAPOINTS
  return HM_KEY_PRESS_DATAPOINTS.filter((parameter) => listed.has(parameter))
}

function entryOf(
  parameter: string,
  source: NonNullable<EventVocabularyEntry['source']>,
): EventVocabularyEntry {
  const meaning = PRESS_MEANING[parameter]
  if (meaning === undefined) return { id: parameter, source, label: parameter }
  return { id: parameter, source, label: meaning.label, kind: meaning.kind }
}

export function hmKeyVocabulary(device: Pick<HmDevice, 'channels'>): EventVocabularyEntry[] {
  return hmKeyChannels(device).flatMap((channel, position) => {
    const index = channelIndexFromAddress(channel.address) ?? String(channel.index)
    const source = { id: index, label: `Button ${position + 1} (channel ${index})` }
    return pressesOf(channel).map((parameter) => entryOf(parameter, source))
  })
}
