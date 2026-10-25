import { describe, expect, it } from 'vitest'
import {
  buildSnapshotChannelOptions,
  defaultSnapshotChannelId,
  extractElementInner,
  parseStreamingChannelSummaries,
  readDirectChildText,
  readStreamingChannelEnabled,
  resolveSnapshotChannelId,
} from '../hikvision-snapshot-channel.js'

/**
 * Two things are guarded here, in order of what would hurt most.
 *
 *  1. **The channel document has THREE `<enabled>` flags.** Channel, `<Video>`
 *     and `<Audio>` all use the tag. Reading the wrong one makes the
 *     snapshot-source select claim a live channel is switched off (or worse,
 *     the reverse). Every fixture below carries all three, and the
 *     discriminating fixtures put `<Video>` BEFORE the channel flag so a
 *     first-match implementation cannot pass by accident — which the
 *     currently-shipping firmware's ordering would otherwise let it do.
 *
 *  2. **An untouched camera must not change channel on upgrade.** The stored
 *     value starts empty and resolves to the channel the provider already
 *     used; only an explicit operator choice moves it.
 */

interface ChannelFixtureOptions {
  readonly id?: string
  readonly name?: string
  /** Channel-level `<enabled>`. */
  readonly channelEnabled?: string
  /** `<Video><enabled>` — deliberately allowed to disagree with the channel. */
  readonly videoEnabled?: string
  /** `<Audio><enabled>` — likewise. */
  readonly audioEnabled?: string
  /** Emit `<Video>` before the channel-level `<enabled>`. */
  readonly videoFirst?: boolean
  /** Omit the channel-level `<enabled>` entirely (legacy firmware). */
  readonly omitChannelEnabled?: boolean
}

function channelBlock(opts: ChannelFixtureOptions = {}): string {
  const video = `<Video><enabled>${opts.videoEnabled ?? 'true'}</enabled><videoCodecType>H.265</videoCodecType><videoResolutionWidth>2688</videoResolutionWidth><videoResolutionHeight>1520</videoResolutionHeight></Video>`
  const audio = `<Audio><enabled>${opts.audioEnabled ?? 'true'}</enabled><audioCompressionType>G.711ulaw</audioCompressionType></Audio>`
  const channelEnabled = opts.omitChannelEnabled
    ? ''
    : `<enabled>${opts.channelEnabled ?? 'true'}</enabled>`
  const head = [
    `<id>${opts.id ?? '101'}</id>`,
    `<channelName>${opts.name ?? 'Camera 01'}</channelName>`,
  ].join('')
  const body = opts.videoFirst ? `${video}${channelEnabled}` : `${channelEnabled}${video}`
  return `<StreamingChannel version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">${head}${body}${audio}</StreamingChannel>`
}

function channelDocument(opts: ChannelFixtureOptions = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${channelBlock(opts)}`
}

function channelListDocument(blocks: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<StreamingChannelList version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">',
    ...blocks,
    '</StreamingChannelList>',
  ].join('')
}

describe('readDirectChildText', () => {
  it('ignores an identically-named tag nested one level deeper', () => {
    // The whole point: `<Video><enabled>` must be invisible from the
    // StreamingChannel's own scope.
    const inner = extractElementInner(
      channelDocument({ channelEnabled: 'false', videoEnabled: 'true', videoFirst: true }),
      'StreamingChannel',
    )
    expect(inner).not.toBeNull()
    expect(readDirectChildText(inner!, 'enabled')).toBe('false')
  })

  it('is null when the element has the tag only as a grandchild', () => {
    expect(readDirectChildText('<Video><enabled>true</enabled></Video>', 'enabled')).toBeNull()
  })

  it('decodes entities in the direct child text', () => {
    expect(readDirectChildText('<channelName>Front &amp; Back</channelName>', 'channelName')).toBe(
      'Front & Back',
    )
  })

  it('returns empty string, not null, for a self-closing direct child', () => {
    // "present but empty" and "absent" are different answers to the caller.
    expect(readDirectChildText('<a>1</a><enabled/>', 'enabled')).toBe('')
  })
})

describe('readStreamingChannelEnabled', () => {
  it('reads the CHANNEL flag even when Video precedes it and disagrees', () => {
    // The discriminating case. A first-`<enabled>` read returns true here.
    expect(
      readStreamingChannelEnabled(
        channelDocument({ channelEnabled: 'false', videoEnabled: 'true', videoFirst: true }),
      ),
    ).toBe(false)
  })

  it('reads the CHANNEL flag when Audio disagrees', () => {
    expect(
      readStreamingChannelEnabled(
        channelDocument({ channelEnabled: 'true', audioEnabled: 'false' }),
      ),
    ).toBe(true)
  })

  it('is null when the firmware emits no channel-level flag at all', () => {
    // Not `false`: "this firmware has no channel switch" is not "the channel
    // is off". The two Video/Audio flags in the fixture must not fill in.
    expect(readStreamingChannelEnabled(channelDocument({ omitChannelEnabled: true }))).toBeNull()
  })

  it('accepts a bare block with no StreamingChannel wrapper', () => {
    expect(readStreamingChannelEnabled('<id>101</id><enabled>false</enabled>')).toBe(false)
  })
})

describe('parseStreamingChannelSummaries', () => {
  it('parses every channel with its own enabled flag, not the nested ones', () => {
    const xml = channelListDocument([
      channelBlock({ id: '101', name: 'Main', channelEnabled: 'true', videoEnabled: 'false' }),
      channelBlock({
        id: '102',
        name: 'Sub',
        channelEnabled: 'false',
        videoEnabled: 'true',
        videoFirst: true,
      }),
      channelBlock({ id: '103', name: 'Third', channelEnabled: 'true', audioEnabled: 'false' }),
    ])
    expect(parseStreamingChannelSummaries(xml)).toEqual([
      { channelId: '101', channelName: 'Main', enabled: true },
      { channelId: '102', channelName: 'Sub', enabled: false },
      { channelId: '103', channelName: 'Third', enabled: true },
    ])
  })

  it('treats a missing channel-level flag as enabled', () => {
    const xml = channelListDocument([
      channelBlock({ id: '101', omitChannelEnabled: true, videoEnabled: 'false' }),
    ])
    expect(parseStreamingChannelSummaries(xml)[0]?.enabled).toBe(true)
  })

  it('is empty for a firmware that 404s the enumeration (empty body)', () => {
    expect(parseStreamingChannelSummaries('')).toEqual([])
  })
})

describe('buildSnapshotChannelOptions', () => {
  it('labels each probed channel with its slot, id and probed detail', () => {
    const options = buildSnapshotChannelOptions([
      {
        channelId: '102',
        channelName: 'Camera 01',
        enabled: true,
        codec: 'H.264',
        width: 640,
        height: 480,
      },
      {
        channelId: '101',
        channelName: 'Camera 01',
        enabled: true,
        codec: 'H.265',
        width: 2688,
        height: 1520,
      },
    ])
    expect(options).toEqual([
      { value: '101', label: 'Main stream — 101 (Camera 01, 2688×1520, H.265)' },
      { value: '102', label: 'Sub stream — 102 (Camera 01, 640×480, H.264)' },
    ])
  })

  it('says so when the camera reports the channel switched off', () => {
    const [option] = buildSnapshotChannelOptions([{ channelId: '103', enabled: false }])
    expect(option?.label).toContain('disabled on camera')
  })

  it('offers nothing when nothing has been probed', () => {
    // No probe → no control. Never a hardcoded main/sub pair.
    expect(buildSnapshotChannelOptions([])).toEqual([])
  })
})

describe('resolveSnapshotChannelId', () => {
  const available = ['101', '102', '103'] as const

  it('defaults to the channel the provider already used', () => {
    // The upgrade guarantee: nothing stored → no behaviour change.
    expect(resolveSnapshotChannelId('', [...available], defaultSnapshotChannelId(1))).toEqual({
      channelId: '101',
      source: 'default',
    })
    expect(resolveSnapshotChannelId(undefined, [...available], '101').channelId).toBe('101')
  })

  it('honours an explicit operator choice', () => {
    expect(resolveSnapshotChannelId('102', [...available], '101')).toEqual({
      channelId: '102',
      source: 'operator',
    })
  })

  it('keeps the operator choice when the camera has not been probed yet', () => {
    // An empty list means "we have not looked", not "the camera refused it".
    // Discarding the setting on a fallible read would destroy operator work.
    expect(resolveSnapshotChannelId('102', [], '101')).toEqual({
      channelId: '102',
      source: 'operator',
    })
  })

  it('falls back to the default, flagged, when the camera stops offering the channel', () => {
    expect(resolveSnapshotChannelId('104', [...available], '101')).toEqual({
      channelId: '101',
      source: 'fallback-unknown',
    })
  })

  it('treats whitespace as unset', () => {
    expect(resolveSnapshotChannelId('   ', [...available], '101').source).toBe('default')
  })

  it('derives the default from the camera number', () => {
    expect(defaultSnapshotChannelId(1)).toBe('101')
    expect(defaultSnapshotChannelId(2)).toBe('201')
  })
})
