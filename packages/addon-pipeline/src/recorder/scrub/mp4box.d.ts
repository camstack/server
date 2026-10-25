/**
 * Minimal type shim for mp4box.js (the package ships no types). Declares only
 * the members the server-side scrub keyframe extractor uses — no `any`. Mirrors
 * the embed shim at `embed/src/scrub/mp4box.d.ts`; duplicated because the two
 * live in separate tsconfig projects (`src/**` vs `embed/**`) and cannot share
 * a declaration. Extend as needed.
 */
declare module 'mp4box' {
  export type MP4ArrayBuffer = ArrayBuffer & { fileStart: number }

  export interface MP4VideoTrack {
    readonly id: number
    readonly codec: string
    readonly video?: { readonly width: number; readonly height: number }
  }
  export interface MP4AudioTrack {
    readonly id: number
    readonly codec: string
    readonly audio?: { readonly sample_rate: number; readonly channel_count: number }
  }
  export interface MP4Info {
    readonly videoTracks?: readonly MP4VideoTrack[]
    readonly audioTracks?: readonly MP4AudioTrack[]
  }
  export interface MP4Sample {
    readonly is_sync: boolean
    readonly data: ArrayBuffer
    readonly cts: number
    readonly timescale: number
  }

  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    buffer: ArrayBuffer
    static readonly BIG_ENDIAN: boolean
    static readonly LITTLE_ENDIAN: boolean
  }

  /** A parsed box (e.g. hvcC/avcC) able to serialize itself into a DataStream. */
  export interface MP4ConfigBox {
    write(stream: DataStream): void
  }
  export interface SampleEntry {
    readonly hvcC?: MP4ConfigBox
    readonly avcC?: MP4ConfigBox
  }
  export interface Trak {
    readonly mdia?: {
      readonly minf?: {
        readonly stbl?: { readonly stsd?: { readonly entries?: readonly SampleEntry[] } }
      }
    }
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void
    onError: (error: string) => void
    onSamples: (id: number, user: unknown, samples: MP4Sample[]) => void
    getTrackById(id: number): Trak | undefined
    setExtractionOptions(id: number, user: unknown, options: { nbSamples?: number }): void
    start(): void
    stop(): void
    appendBuffer(data: MP4ArrayBuffer): number
    flush(): void
  }

  export function createFile(): MP4File

  const MP4Box: { createFile: typeof createFile; DataStream: typeof DataStream }
  export default MP4Box
}
