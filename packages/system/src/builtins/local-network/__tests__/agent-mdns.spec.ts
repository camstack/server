import { describe, expect, it } from 'vitest'
import { AgentMdnsAdvertiser, type AgentMdnsInputs } from '../agent-mdns.js'
import type { HubMdnsAnnouncement, HubMdnsPublisher } from '../hub-mdns.js'

interface RecordingPublisher extends HubMdnsPublisher {
  readonly published: HubMdnsAnnouncement[]
  readonly stopped: number[]
}

function recordingPublisher(): RecordingPublisher {
  const published: HubMdnsAnnouncement[] = []
  const stopped: number[] = []
  return {
    published,
    stopped,
    publish: async (announcement) => {
      const index = published.length
      published.push(announcement)
      return { stop: async () => void stopped.push(index) }
    },
  }
}

const silentLogger = { info: () => undefined, warn: () => undefined }

const UNPAIRED: AgentMdnsInputs = {
  nodeId: 'agent-1',
  version: '1.2.3',
  port: 4444,
  state: 'unpaired',
  leafFingerprint: null,
}

describe('AgentMdnsAdvertiser', () => {
  it('advertises on the first sync, with no separate start (the agent boot only syncs)', async () => {
    const publisher = recordingPublisher()
    const advertiser = new AgentMdnsAdvertiser({ publisher, logger: silentLogger })

    await advertiser.sync(UNPAIRED)

    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]?.txt['state']).toBe('unpaired')
  })

  it('re-announces only when the inputs change', async () => {
    const publisher = recordingPublisher()
    const advertiser = new AgentMdnsAdvertiser({ publisher, logger: silentLogger })

    await advertiser.sync(UNPAIRED)
    await advertiser.sync(UNPAIRED)
    await advertiser.sync({ ...UNPAIRED, state: 'paired', leafFingerprint: 'abcd' })

    expect(publisher.published.map((a) => a.txt['state'])).toEqual(['unpaired', 'paired'])
    expect(publisher.stopped).toEqual([0])
  })

  it('withdraws on stop and ignores every later sync', async () => {
    const publisher = recordingPublisher()
    const advertiser = new AgentMdnsAdvertiser({ publisher, logger: silentLogger })

    await advertiser.sync(UNPAIRED)
    await advertiser.stop()
    await advertiser.sync({ ...UNPAIRED, state: 'pending' })

    expect(publisher.published).toHaveLength(1)
    expect(publisher.stopped).toEqual([0])
  })
})
