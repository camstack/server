import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { DeviceConfig } from '../device-config.js'

const testSchema = z.object({
  channel: z.number().default(1).describe('Channel number'),
  subStream: z.boolean().default(false).describe('Use sub-stream'),
  resolution: z.enum(['4k', '1080p', '720p']).default('1080p').describe('Resolution'),
})

function createConfig(persist = vi.fn(), initial: Record<string, unknown> = {}) {
  return DeviceConfig.fromSchema(testSchema, persist, initial)
}

describe('DeviceConfig', () => {
  describe('fromSchema', () => {
    it('parses initial data with schema defaults', () => {
      const config = createConfig()
      expect(config.values).toEqual({ channel: 1, subStream: false, resolution: '1080p' })
    })

    it('overrides defaults with initial data', () => {
      const config = createConfig(vi.fn(), { channel: 3, subStream: true })
      expect(config.values.channel).toBe(3)
      expect(config.values.subStream).toBe(true)
      expect(config.values.resolution).toBe('1080p')
    })

    it('throws on invalid initial data', () => {
      expect(() => createConfig(vi.fn(), { channel: 'not-a-number' })).toThrow()
    })
  })

  describe('get', () => {
    it('returns value by key', () => {
      const config = createConfig(vi.fn(), { channel: 5 })
      expect(config.get('channel')).toBe(5)
    })
  })

  describe('set', () => {
    it('updates value and persists', async () => {
      const persist = vi.fn()
      const config = createConfig(persist)
      await config.set('channel', 3)
      expect(config.values.channel).toBe(3)
      expect(persist).toHaveBeenCalledWith({ channel: 3, subStream: false, resolution: '1080p' })
    })

    it('rejects invalid value', async () => {
      const config = createConfig()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      await expect(config.set('channel', 'bad' as unknown as any)).rejects.toThrow()
    })
  })

  describe('setAll', () => {
    it('merges partial update and persists', async () => {
      const persist = vi.fn()
      const config = createConfig(persist)
      await config.setAll({ channel: 2, resolution: '4k' })
      expect(config.values).toEqual({ channel: 2, subStream: false, resolution: '4k' })
      expect(persist).toHaveBeenCalledOnce()
    })
  })

  describe('deleteKey', () => {
    it('resets key to schema default and persists', async () => {
      const persist = vi.fn()
      const config = createConfig(persist, { channel: 5 })
      expect(config.get('channel')).toBe(5)
      await config.deleteKey('channel')
      expect(config.get('channel')).toBe(1)
      expect(persist).toHaveBeenCalled()
    })
  })

  describe('entries', () => {
    it('returns all fields with schema, value, and description', () => {
      const config = createConfig(vi.fn(), { channel: 3 })
      const entries = config.entries()
      expect(entries).toHaveLength(3)

      const channelEntry = entries.find((e) => e.key === 'channel')!
      expect(channelEntry.value).toBe(3)
      expect(channelEntry.description).toBe('Channel number')

      const resEntry = entries.find((e) => e.key === 'resolution')!
      expect(resEntry.value).toBe('1080p')
      expect(resEntry.description).toBe('Resolution')
    })
  })
})
