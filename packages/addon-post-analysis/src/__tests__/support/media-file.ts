import type { MediaFile, MediaFileBytes, MediaFileInfo } from '@camstack/types'

let nextMediaId = 10_000

export function nextTestMediaId(): number {
  nextMediaId += 1
  return nextMediaId
}

export function testMediaUrl(mediaId: number): string {
  return `/addon/test/event-media/m/${mediaId}`
}

/** Wire-shaped {@link MediaFile} for notification / dispatcher specs. */
export function makeTestMediaFile(patch: Partial<MediaFile> & Pick<MediaFile, 'kind'>): MediaFile {
  const mediaId = patch.mediaId ?? nextTestMediaId()
  const base64 = patch.base64 ?? Buffer.from('jpeg').toString('base64')
  const { kind, mediaId: patchMediaId, base64: patchBase64, ...rest } = patch
  return {
    ...rest,
    mediaId,
    kind,
    url: patch.url ?? testMediaUrl(mediaId),
    base64,
    sizeBytes: patch.sizeBytes ?? Buffer.from(base64, 'base64').length,
    timestamp: patch.timestamp ?? 1_000,
  }
}

/** Stored {@link MediaFileBytes} for track-close / media-store specs. */
/** Index row ({@link MediaFileInfo}) without base64 — thumbnail ladders, debug lists. */
export function makeTestMediaFileInfo(
  patch: Partial<MediaFileInfo> & Pick<MediaFileInfo, 'kind'>,
): MediaFileInfo {
  const mediaId = patch.mediaId ?? nextTestMediaId()
  const { kind, mediaId: patchMediaId, ...rest } = patch
  return {
    sizeBytes: 1_000,
    timestamp: 1_000,
    ...rest,
    mediaId,
    kind,
    url: patch.url ?? testMediaUrl(mediaId),
  }
}

export function makeTestMediaFileBytes(
  patch: Partial<MediaFileBytes> & Pick<MediaFileBytes, 'mediaId' | 'kind'>,
): MediaFileBytes {
  const base64 = patch.base64 ?? Buffer.from('img').toString('base64')
  return {
    sizeBytes: patch.sizeBytes ?? Buffer.from(base64, 'base64').length,
    timestamp: patch.timestamp ?? 15_000,
    base64,
    ...patch,
  }
}
