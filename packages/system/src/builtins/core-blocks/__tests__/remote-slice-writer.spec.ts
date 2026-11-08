import { type AddonApi, EMPTY_REMOTE_CONFIG, type MediaPlayerStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { remoteSliceWriterOver } from '../remote-wiring.js'

const TV = 12

const STATUS: MediaPlayerStatus = {
  state: 'standby',
  stateSource: 'assumed',
  assumedFields: ['state'],
  volumeLevel: null,
  isMuted: null,
  source: '',
  availableSources: [],
  currentMedia: null,
  position: null,
  duration: null,
  shuffle: null,
  repeat: null,
  positionUpdatedAt: null,
  lastChangedAt: 1,
}

function hub(slice: Record<string, unknown> | null) {
  const writes: { readonly deviceId: number; readonly capName: string }[] = []
  const api = {
    deviceState: {
      getCapSlice: { query: async () => slice },
      setCapSlice: {
        mutate: async (input: { readonly deviceId: number; readonly capName: string }) => {
          writes.push({ deviceId: input.deviceId, capName: input.capName })
        },
      },
    },
  }
  // A structural fake of the two calls the writer makes; the writer is typed against the full api.
  const asApi = (): AddonApi | undefined => Object.assign(Object.create(null), api)
  const writer = remoteSliceWriterOver(
    {
      listDeviceStoreIds: async () => [TV, 99],
      readDeviceStoreBatch: async () =>
        new Map([
          [TV, { remote: EMPTY_REMOTE_CONFIG }],
          [99, { other: 1 }],
        ]),
    },
    asApi,
  )
  return { writer, writes }
}

describe('remoteSliceWriterOver', () => {
  it('lists only the devices that carry a remote configuration', async () => {
    expect(await hub(null).writer.devices()).toEqual([TV])
  })

  it('writes the media-player slice through deviceState when none exists', async () => {
    const h = hub(null)
    await h.writer.publish(TV, STATUS)
    expect(h.writes).toEqual([{ deviceId: TV, capName: 'media-player' }])
  })

  it('writes when the state differs and skips when only the change stamp moved', async () => {
    const same = hub({ ...STATUS, lastChangedAt: 999 })
    await same.writer.publish(TV, STATUS)
    expect(same.writes).toEqual([])
    const differs = hub({ ...STATUS, state: 'off' })
    await differs.writer.publish(TV, STATUS)
    expect(differs.writes).toHaveLength(1)
  })
})
