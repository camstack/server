import { describe, expect, it } from 'vitest'
import { fakeSecrets } from '../../../auth/__tests__/fake-secrets.js'
import {
  blockSettingsStoreHarness,
  coreBlockRecordsHarness,
  fakeSettingsStore,
  recordingLogger,
} from './fixtures.js'

describe('core-blocks — records path', () => {
  it('CoreBlockStore and BlockSettingsStore do not declare legacy hub-main collections', async () => {
    const declared: string[] = []
    const settings = fakeSettingsStore()
    const door = settings.client
    const tracked = {
      ...door,
      declareCollection: {
        mutate: async (input: { collection: string }) => {
          declared.push(input.collection)
        },
      },
    }
    const { logger } = recordingLogger()
    await coreBlockRecordsHarness(logger)
    const keychainFor = () => fakeSecrets()
    await blockSettingsStoreHarness(keychainFor, {
      ...settings,
      client: tracked as typeof door,
    })
    expect(declared).not.toContain('core_blocks')
    expect(declared).not.toContain('core-blocks:settings')
  })
})
