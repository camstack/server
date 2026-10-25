/**
 * `collectProviderInfos` — the pure mapping behind the orchestrator's
 * `storage.listProviders` handler. Proves the disk-space policy fields
 * (`shouldSaveDiskSpace` + `minFreePercent`) survive from each provider's
 * `getProviderInfo()` into the cap's `listProviders` output, and that a
 * single misbehaving provider is isolated (logged, skipped) without
 * denying the whole list.
 */

import type { IStorageProviderImpl, StorageProviderInfoSchema } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { collectProviderInfos } from '../provider-discovery.js'

type ProviderInfo = z.infer<typeof StorageProviderInfoSchema>

function makeProvider(info: ProviderInfo): IStorageProviderImpl {
  const provider: IStorageProviderImpl = {
    getProviderInfo: vi.fn(async () => info),
    testLocation: vi.fn(async () => ({ ok: true })),
    resolve: vi.fn(async () => '/tmp/fake'),
    write: vi.fn(async () => undefined),
    read: vi.fn(async () => new Uint8Array()),
    exists: vi.fn(async () => false),
    list: vi.fn(async () => [] as readonly string[]),
    delete: vi.fn(async () => undefined),
    getAvailableSpace: vi.fn(async () => null),
    beginUpload: vi.fn(async () => ({ uploadId: 'u-1' })),
    writeChunk: vi.fn(async () => undefined),
    finalizeUpload: vi.fn(async () => undefined),
    abortUpload: vi.fn(async () => undefined),
    beginDownload: vi.fn(async () => ({ downloadId: 'd-1', sizeBytes: 0 })),
    readChunk: vi.fn(async () => new Uint8Array()),
    endDownload: vi.fn(async () => undefined),
  }
  return provider
}

describe('collectProviderInfos', () => {
  it('surfaces shouldSaveDiskSpace + minFreePercent for every provider', async () => {
    const fs = makeProvider({
      providerId: 'filesystem-storage',
      displayName: 'Filesystem',
      configSchema: {},
      nodeLocal: true,
      shouldSaveDiskSpace: true,
      minFreePercent: 10,
    })
    const s3 = makeProvider({
      providerId: 's3-storage',
      displayName: 'S3',
      configSchema: {},
      nodeLocal: false,
      shouldSaveDiskSpace: false,
      minFreePercent: null,
    })

    const out = await collectProviderInfos([fs, s3], () => undefined)

    expect(out).toEqual([
      {
        providerId: 'filesystem-storage',
        displayName: 'Filesystem',
        configSchema: {},
        nodeLocal: true,
        shouldSaveDiskSpace: true,
        minFreePercent: 10,
      },
      {
        providerId: 's3-storage',
        displayName: 'S3',
        configSchema: {},
        nodeLocal: false,
        shouldSaveDiskSpace: false,
        minFreePercent: null,
      },
    ])
  })

  it('isolates a misbehaving provider and keeps the rest', async () => {
    const ok = makeProvider({
      providerId: 'filesystem-storage',
      displayName: 'Filesystem',
      configSchema: {},
      nodeLocal: true,
      shouldSaveDiskSpace: true,
      minFreePercent: 10,
    })
    const broken: IStorageProviderImpl = {
      ...makeProvider({
        providerId: 'x',
        displayName: 'X',
        configSchema: {},
        nodeLocal: false,
        shouldSaveDiskSpace: false,
        minFreePercent: null,
      }),
      getProviderInfo: vi.fn(async () => {
        throw new Error('boom')
      }),
    }
    const onError = vi.fn()

    const out = await collectProviderInfos([broken, ok], onError)

    expect(out.map((o) => o.providerId)).toEqual(['filesystem-storage'])
    expect(onError).toHaveBeenCalledTimes(1)
    // `broken` is at index 0 in the input array; the 3-arg handler reports it.
    expect(onError).toHaveBeenCalledWith(broken, expect.any(Error), 0)
  })
})
