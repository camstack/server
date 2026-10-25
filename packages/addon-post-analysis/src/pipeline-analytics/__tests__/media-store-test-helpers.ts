/**
 * Shared `MediaStore` construction for the fusion specs — the same
 * fakes/wiring `media-store.spec.ts` uses, factored out so a fusion spec does
 * not hand-roll its own settings-store + storage-provider pair.
 */
import { makeFakeSettingsStore, makeFakeStorageProvider, makeSilentLogger } from './test-helpers.js'
import { MediaStore, type MediaKind, type OwnerKind } from '../store/media-store.js'

/** Review L4: named types only — no inline types on signatures. */
export interface BuiltMediaStoreForTest {
  readonly store: MediaStore
  readonly fake: ReturnType<typeof makeFakeSettingsStore>
  readonly storage: ReturnType<typeof makeFakeStorageProvider>
}

export async function buildMediaStoreForTest(): Promise<BuiltMediaStoreForTest> {
  const fake = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
  await MediaStore.declare(fake.client)
  return { store, fake, storage }
}

export interface PutOwnedMediaInput {
  readonly ownerKind: OwnerKind
  readonly ownerId: string
  readonly kind: MediaKind
  readonly timestamp: number
  /** Blob content. Defaults to a fixed 1-byte buffer — pass a distinct value
   *  when a spec must tell two rows' bytes apart (review H1). */
  readonly data?: Buffer
}

/** Write one owned media row and return its id. */
export async function putOwnedMedia(store: MediaStore, input: PutOwnedMediaInput): Promise<number> {
  return store.put({
    deviceId: 1,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    kind: input.kind,
    timestamp: input.timestamp,
    data: input.data ?? Buffer.from('x'),
  })
}
