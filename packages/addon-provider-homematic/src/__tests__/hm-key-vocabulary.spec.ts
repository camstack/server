/**
 * The event vocabulary of a Homematic remote (D1044): one source per key
 * channel, one entry per channel and `PRESS_*` datapoint.
 */
import type { HmDevice } from 'nodehomematic'
import { describe, expect, it } from 'vitest'
import { hmKeyVocabulary } from '../devices/hm-key-vocabulary.js'

const ADDRESS = '000B1D8990A1B2'

interface ChannelSpec {
  readonly index: number
  readonly type: string
  readonly parameters: readonly string[]
}

function device(channels: readonly ChannelSpec[]): Pick<HmDevice, 'channels'> {
  return {
    channels: channels.map((channel) => ({
      address: `${ADDRESS}:${channel.index}`,
      index: channel.index,
      type: channel.type,
      dataPoints: channel.parameters.map((parameter) => ({
        id: `${ADDRESS}:${channel.index}:${parameter}`,
        parameter,
        type: 'ACTION',
        value: null,
        readable: false,
        writable: false,
        hasEvents: true,
      })),
    })),
  }
}

const key = (index: number, parameters: readonly string[] = ['PRESS_SHORT', 'PRESS_LONG']) => ({
  index,
  type: 'KEY_TRANSCEIVER',
  parameters,
})

describe('hmKeyVocabulary', () => {
  it('declares six sources for a six-button remote, each with its presses', () => {
    const vocabulary = hmKeyVocabulary(device([1, 2, 3, 4, 5, 6].map((index) => key(index))))
    const sources = [...new Set(vocabulary.map((entry) => entry.source?.id))]
    expect(sources).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(vocabulary).toHaveLength(12)
    expect(vocabulary[0]).toEqual({
      id: 'PRESS_SHORT',
      source: { id: '1', label: 'Button 1 (channel 1)' },
      label: 'Short press',
      kind: 'press',
    })
  })

  it('numbers buttons by position and keeps the channel in the label', () => {
    const wallSwitch = device([
      { index: 0, type: 'MAINTENANCE', parameters: ['LOW_BAT'] },
      key(3),
      key(4),
    ])
    const labels = [...new Set(hmKeyVocabulary(wallSwitch).map((entry) => entry.source?.label))]
    expect(labels).toEqual(['Button 1 (channel 3)', 'Button 2 (channel 4)'])
  })

  it('maps each native press to the shared kind and keeps the token verbatim', () => {
    const all = [
      'PRESS_SHORT',
      'PRESS_LONG',
      'PRESS_LONG_START',
      'PRESS_LONG_RELEASE',
      'PRESS_CONT',
    ]
    const vocabulary = hmKeyVocabulary(device([key(1, all)]))
    expect(vocabulary.map((entry) => [entry.id, entry.kind])).toEqual([
      ['PRESS_SHORT', 'press'],
      ['PRESS_LONG', 'long-press'],
      ['PRESS_LONG_START', 'long-press-start'],
      ['PRESS_LONG_RELEASE', 'release'],
      ['PRESS_CONT', 'repeat'],
    ])
  })

  it('declares only the presses a channel has, per channel', () => {
    const vocabulary = hmKeyVocabulary(device([key(1, ['PRESS_SHORT']), key(2, ['PRESS_LONG'])]))
    expect(vocabulary.map((entry) => `${entry.source?.id}:${entry.id}`)).toEqual([
      '1:PRESS_SHORT',
      '2:PRESS_LONG',
    ])
  })

  it('declares the standard presses for a key channel that lists no datapoint', () => {
    const vocabulary = hmKeyVocabulary(device([key(1, [])]))
    expect(vocabulary.map((entry) => entry.id)).toEqual([
      'PRESS_SHORT',
      'PRESS_LONG',
      'PRESS_LONG_START',
      'PRESS_LONG_RELEASE',
      'PRESS_CONT',
    ])
  })

  it('declares nothing for a device with no key channel', () => {
    const plug = device([{ index: 3, type: 'SWITCH_VIRTUAL_RECEIVER', parameters: ['STATE'] }])
    expect(hmKeyVocabulary(plug)).toEqual([])
  })
})
