/**
 * The seam that turns a rendered export into a PUBLIC attachment.
 *
 * Everything about this module is best-effort by design: the caller (the
 * renderer) treats `null` as "deliver text-only", so a wrong answer here is a
 * silently degraded notification. That is exactly why every branch below is
 * pinned — including which ones must never reach the artifact plane at all.
 */
import type { IScopedLogger } from '@camstack/types'
import { RECORDING_EXPORT_MAX_READ_BYTES } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { NcArtifactPublication } from '../../artifact-plane.js'
import {
  buildTimelapseArtifactPublisher,
  type TimelapseArtifactPublishPorts,
} from '../artifact-publish.js'

const BYTES = Buffer.from('an mp4, honestly')
const PUBLISHED: NcArtifactPublication = {
  url: 'https://hub.example/nc-artifact/a1?sig=x',
  artifactId: 'a1',
}

/** A logger whose levels are spies — the refusal LOG is part of the contract
 *  here (a dropped attachment that says nothing reads as "never happened"). */
function makeSpyLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makePorts(
  over: Partial<TimelapseArtifactPublishPorts> = {},
): TimelapseArtifactPublishPorts {
  return {
    logger: makeSpyLogger(),
    readExportBytes: async () => ({
      base64: BYTES.toString('base64'),
      contentType: 'video/mp4',
      name: 'Vialetto-notte.mp4',
      bytes: BYTES.byteLength,
    }),
    publish: async () => ({
      url: 'https://hub.example/addon/pipeline-analytics/nc-artifact/a1?sig=x',
      artifactId: 'a1',
    }),
    ...over,
  }
}

describe('timelapse artifact publisher', () => {
  it('reads the export ONCE and republishes the bytes on the artifact plane', async () => {
    const readExportBytes = vi.fn(makePorts().readExportBytes)
    const published: Array<{ bytes: Uint8Array; mime: string }> = []
    const publish = async (bytes: Uint8Array, mime: string): Promise<NcArtifactPublication> => {
      published.push({ bytes, mime })
      return { url: 'https://hub.example/nc-artifact/a1?sig=x', artifactId: 'a1' }
    }
    const publisher = buildTimelapseArtifactPublisher(makePorts({ readExportBytes, publish }))

    const set = await publisher({ exportId: 'exp-1', deviceId: 1441 })

    expect(readExportBytes).toHaveBeenCalledTimes(1)
    expect(readExportBytes).toHaveBeenCalledWith({ exportId: 'exp-1' })
    // The plane gets the DECODED bytes and the provider's own content type —
    // an mp4 published as `application/octet-stream` is a link a phone refuses
    // to play inline.
    expect(published).toHaveLength(1)
    expect(Buffer.from(published[0]?.bytes ?? new Uint8Array()).toString()).toBe(BYTES.toString())
    expect(published[0]?.mime).toBe('video/mp4')
    expect(set.video).toEqual({
      url: 'https://hub.example/nc-artifact/a1?sig=x',
      mime: 'video/mp4',
      name: 'Vialetto-notte.mp4',
    })
    expect(set.preview).toBeNull()
  })

  it('returns null and logs per-camera when the byte read is refused', async () => {
    const logger = makeSpyLogger()
    const publish = vi.fn(async () => PUBLISHED)
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        logger,
        publish,
        readExportBytes: async () => {
          throw new Error('recordingExport: export "exp-1" is too large to read inline')
        },
      }),
    )

    expect(await publisher({ exportId: 'exp-1', deviceId: 1441 })).toEqual({
      video: null,
      preview: null,
    })
    // Nothing reached the plane — a refused read must not publish a truncated
    // or empty artifact.
    expect(publish).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/artifact/i),
      expect.objectContaining({ tags: { deviceId: 1441 } }),
    )
  })

  it('returns null when the plane has no externally reachable base URL', async () => {
    const logger = makeSpyLogger()
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({ logger, publish: async () => ({ url: null, artifactId: null }) }),
    )
    expect((await publisher({ exportId: 'exp-1', deviceId: 1441 })).video).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 1441 } }),
    )
  })

  it('never throws — a publish failure costs the attachment, never the window', async () => {
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        publish: async () => {
          throw new Error('artifact store is full')
        },
      }),
    )
    await expect(publisher({ exportId: 'exp-1', deviceId: 1441 })).resolves.toEqual({
      video: null,
      preview: null,
    })
  })

  it('refuses a payload over the read ceiling without handing it to the plane', async () => {
    // Belt to the provider's braces, and the SAME constant — not a second
    // policy. A provider that ever forgot the bound would otherwise turn a
    // 400 MB read into a 400 MB artifact-store write.
    const logger = makeSpyLogger()
    const publish = vi.fn(async () => PUBLISHED)
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        logger,
        publish,
        readExportBytes: async () => ({
          base64: BYTES.toString('base64'),
          contentType: 'video/mp4',
          name: 'huge.mp4',
          bytes: RECORDING_EXPORT_MAX_READ_BYTES + 1,
        }),
      }),
    )

    expect(await publisher({ exportId: 'exp-1', deviceId: 1441 })).toEqual({
      video: null,
      preview: null,
    })
    expect(publish).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/too large/i),
      expect.objectContaining({ tags: { deviceId: 1441 } }),
    )
  })

  it('accepts a payload exactly ON the ceiling', async () => {
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        readExportBytes: async () => ({
          base64: BYTES.toString('base64'),
          contentType: 'video/mp4',
          name: 'exact.mp4',
          bytes: RECORDING_EXPORT_MAX_READ_BYTES,
        }),
      }),
    )
    expect((await publisher({ exportId: 'exp-1', deviceId: 1441 })).video).not.toBeNull()
  })

  // ── the PREVIEW half ──────────────────────────────────────────────

  it('publishes the preview from the SAME read, as image/jpeg, image and video both', async () => {
    const readExportBytes = vi.fn(makePorts().readExportBytes)
    const published: Array<{ mime: string }> = []
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        readExportBytes,
        publish: async (_bytes, mime) => {
          published.push({ mime })
          return {
            url: `https://hub.example/nc-artifact/${published.length}?sig=x`,
            artifactId: `a${published.length}`,
          }
        },
        renderPreview: async ({ mp4, text, mode }) => {
          // The preview is cut from the bytes already in hand — never a second
          // multi-megabyte read across the process boundary.
          expect(Buffer.from(mp4).toString()).toBe(BYTES.toString())
          expect(text).toBe('Timelapse Vialetto')
          expect(mode).toBe('image')
          return { bytes: Buffer.from('a jpeg'), mime: 'image/jpeg' }
        },
      }),
    )

    const set = await publisher({
      exportId: 'exp-1',
      deviceId: 1441,
      previewText: 'Timelapse Vialetto',
    })

    expect(readExportBytes).toHaveBeenCalledTimes(1)
    expect(published.map((p) => p.mime)).toEqual(['image/jpeg', 'video/mp4'])
    expect(set.preview?.mime).toBe('image/jpeg')
    expect(set.video?.mime).toBe('video/mp4')
  })

  it('publishes an ANIMATED preview with its own mime and name, still image-first', async () => {
    const published: Array<{ mime: string }> = []
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        publish: async (_bytes, mime) => {
          published.push({ mime })
          return {
            url: `https://hub.example/nc-artifact/${published.length}?sig=x`,
            artifactId: `a${published.length}`,
          }
        },
        renderPreview: async ({ mode }) => {
          expect(mode).toBe('gif')
          return { bytes: Buffer.from('GIF89a'), mime: 'image/gif' }
        },
      }),
    )

    const set = await publisher({
      exportId: 'exp-1',
      deviceId: 1441,
      previewText: 'Timelapse Vialetto',
      previewMode: 'gif',
    })

    // The mime is the RENDERER's answer, not the rule's ask: a GIF that
    // degraded to a still must be published as the still it actually is.
    expect(published.map((p) => p.mime)).toEqual(['image/gif', 'video/mp4'])
    expect(set.preview?.mime).toBe('image/gif')
    expect(set.preview?.name).toMatch(/\.gif$/)
  })

  it('publishes a DEGRADED still as a still, even though the rule asked for a gif', async () => {
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        renderPreview: async () => ({ bytes: Buffer.from('a jpeg'), mime: 'image/jpeg' }),
      }),
    )
    const set = await publisher({
      exportId: 'exp-1',
      deviceId: 1441,
      previewText: 'x',
      previewMode: 'gif',
    })
    expect(set.preview?.mime).toBe('image/jpeg')
    expect(set.preview?.name).toMatch(/\.jpg$/)
  })

  it('asks for the STILL when the rule names no mode — an old rule is not a gif', async () => {
    const renderPreview = vi.fn(async () => ({
      bytes: Buffer.from('a jpeg'),
      mime: 'image/jpeg',
    }))
    const publisher = buildTimelapseArtifactPublisher(makePorts({ renderPreview }))
    await publisher({ exportId: 'exp-1', deviceId: 1441, previewText: 'x' })
    expect(renderPreview).toHaveBeenCalledWith(expect.objectContaining({ mode: 'image' }))
  })

  // ── the artefact INDEX metadata (task #36) ────────────────────────

  it('files the video under its rule and window, and names the preview as its poster', async () => {
    const metas: Array<Record<string, unknown>> = []
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        publish: async (_bytes, mime, meta) => {
          metas.push({ ...meta, mime })
          return { url: 'https://hub.example/x', artifactId: `art-${metas.length}` }
        },
        renderPreview: async () => ({ bytes: Buffer.from('a jpeg'), mime: 'image/jpeg' }),
      }),
    )
    await publisher({
      exportId: 'exp-1',
      deviceId: 1441,
      previewText: 'x',
      capturedAt: 1_700_000_000_000,
      ruleId: 'rule-9',
      ruleName: 'Vialetto notte',
      ownerUserId: 'alice',
    })
    // The preview goes FIRST — the video row cannot name a poster that does
    // not exist yet.
    expect(metas[0]).toMatchObject({
      kind: 'timelapse-preview',
      deviceId: 1441,
      deviceIds: [1441],
      capturedAt: 1_700_000_000_000,
      ruleId: 'rule-9',
      ruleName: 'Vialetto notte',
      ownerUserId: 'alice',
    })
    expect(metas[1]).toMatchObject({
      kind: 'timelapse',
      capturedAt: 1_700_000_000_000,
      // A list of timelapses is a wall of video thumbnails; the still rendered
      // from the window is the only one that will ever exist for it.
      posterArtifactId: 'art-1',
    })
  })

  // A LAN-only install has no signed link to attach — but the viewer reaches
  // the hub directly, so the library must still get its poster.
  it('keeps the poster when no public link can be minted', async () => {
    const metas: Array<Record<string, unknown>> = []
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        publish: async (_bytes, _mime, meta) => {
          metas.push({ ...meta })
          return { url: null, artifactId: `art-${metas.length}` }
        },
        renderPreview: async () => ({ bytes: Buffer.from('a jpeg'), mime: 'image/jpeg' }),
      }),
    )
    const set = await publisher({ exportId: 'exp-1', deviceId: 1441, previewText: 'x' })
    expect(set.preview).toBeNull()
    expect(set.video).toBeNull()
    expect(metas[1]).toMatchObject({ posterArtifactId: 'art-1' })
  })

  it('still delivers the VIDEO when the preview render declines', async () => {
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({ renderPreview: async () => null }),
    )
    const set = await publisher({ exportId: 'exp-1', deviceId: 1441, previewText: 'x' })
    expect(set.preview).toBeNull()
    expect(set.video).not.toBeNull()
  })

  it('still delivers the VIDEO when the preview render THROWS', async () => {
    const publisher = buildTimelapseArtifactPublisher(
      makePorts({
        renderPreview: async () => {
          throw new Error('ffmpeg is not installed')
        },
      }),
    )
    const set = await publisher({ exportId: 'exp-1', deviceId: 1441, previewText: 'x' })
    expect(set.preview).toBeNull()
    expect(set.video).not.toBeNull()
  })

  it('renders no preview at all when the rule asked for none', async () => {
    const renderPreview = vi.fn(async () => ({ bytes: Buffer.from('a jpeg'), mime: 'image/jpeg' }))
    const publisher = buildTimelapseArtifactPublisher(makePorts({ renderPreview }))
    const set = await publisher({ exportId: 'exp-1', deviceId: 1441 })
    expect(renderPreview).not.toHaveBeenCalled()
    expect(set.preview).toBeNull()
  })
})
