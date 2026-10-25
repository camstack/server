import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NODE_UPDATE_CHANNEL,
  VIEWER_UPDATE_CHANNEL,
  UPDATE_FEED_PLATFORMS,
  updateChannelForProduct,
  updateFeedFileName,
} from '../product/update-channel'

const DESKTOP = path.resolve(__dirname, '../..')

function publishChannel(config: unknown): unknown {
  const publish = (config as { publish?: unknown }).publish
  if (!Array.isArray(publish) || publish.length !== 1) return undefined
  return (publish[0] as { channel?: unknown }).channel
}

describe('updateChannelForProduct', () => {
  it('keeps the node product on the default channel', () => {
    expect(updateChannelForProduct('node')).toBe(NODE_UPDATE_CHANNEL)
    expect(NODE_UPDATE_CHANNEL).toBe('latest')
  })

  it('gives the reduced product a channel of its own', () => {
    expect(updateChannelForProduct('viewer')).toBe(VIEWER_UPDATE_CHANNEL)
    expect(VIEWER_UPDATE_CHANNEL).not.toBe(NODE_UPDATE_CHANNEL)
  })
})

describe('updateFeedFileName', () => {
  it('names the mac feed after the channel', () => {
    expect(updateFeedFileName('latest', 'darwin', 'x64')).toBe('latest-mac.yml')
    expect(updateFeedFileName('viewer', 'darwin', 'arm64')).toBe('viewer-mac.yml')
  })

  it('leaves x64 unsuffixed on linux and suffixes every other arch', () => {
    expect(updateFeedFileName('latest', 'linux', 'x64')).toBe('latest-linux.yml')
    expect(updateFeedFileName('viewer', 'linux', 'arm64')).toBe('viewer-linux-arm64.yml')
  })

  it('carries no platform suffix on windows', () => {
    expect(updateFeedFileName('latest', 'win32', 'x64')).toBe('latest.yml')
    expect(updateFeedFileName('viewer', 'win32', 'x64')).toBe('viewer.yml')
  })
})

describe('the two products never ask one file two questions', () => {
  it('produces a distinct feed file per product on every platform and arch', () => {
    for (const platform of UPDATE_FEED_PLATFORMS) {
      for (const arch of ['x64', 'arm64'] as const) {
        const node = updateFeedFileName(updateChannelForProduct('node'), platform, arch)
        const viewer = updateFeedFileName(updateChannelForProduct('viewer'), platform, arch)
        expect(node).not.toBe(viewer)
      }
    }
  })
})

describe('the runtime channel is the one electron-builder publishes', () => {
  it('matches packages/desktop/package.json build.publish', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')) as {
      build?: unknown
    }
    expect(publishChannel(pkg.build)).toBe(NODE_UPDATE_CHANNEL)
  })

  it('matches electron-builder.viewer.json publish', () => {
    const viewer = JSON.parse(
      fs.readFileSync(path.join(DESKTOP, 'electron-builder.viewer.json'), 'utf8'),
    )
    expect(publishChannel(viewer)).toBe(VIEWER_UPDATE_CHANNEL)
  })
})
