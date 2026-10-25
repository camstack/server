/**
 * Shared fixtures for the retrain specs: a minimal JPEG and an in-memory
 * blob store with the `MediaBlobStorage` shape the frame store writes through.
 */
import type { MediaBlobStorage } from '../../location-aware-media-storage.js'

/** A baseline JPEG header — enough for `readJpegSize`, no encoder needed. */
export function jpegOf(width: number, height: number): Buffer {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

/** An in-memory blob store, keyed `location:relativePath`. */
export interface MemoryBlobs extends MediaBlobStorage {
  readonly files: Map<string, Buffer>
}

export function memoryBlobs(): MemoryBlobs {
  const files = new Map<string, Buffer>()
  return {
    files,
    write: async ({ location, relativePath, data }) => {
      files.set(`${location}:${relativePath}`, data)
    },
    read: async ({ location, relativePath }) => {
      const bytes = files.get(`${location}:${relativePath}`)
      if (bytes === undefined) throw new Error(`no blob at ${location}:${relativePath}`)
      return bytes
    },
    delete: async ({ location, relativePath }) => {
      files.delete(`${location}:${relativePath}`)
    },
  }
}
