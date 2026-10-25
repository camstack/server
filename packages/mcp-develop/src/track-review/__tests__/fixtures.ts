/** Builders and a recording in-memory hub for the track-review specs. */
import { DeviceType } from '@camstack/types'
import type {
  AddToCollectionResult,
  OriginBackfill,
  MediaFile,
  MediaKind,
  RetrainAnnotation,
  RetrainAnnotationDraft,
  RetrainCollection,
  RetrainCorpusKpi,
  RetrainCorpusPage,
  RetrainFrame,
  RetrainFrameList,
  ReviewHub,
  TriageTrack,
} from '../hub-api.js'

export function track(over: Partial<TriageTrack> & { trackId: string }): TriageTrack {
  return {
    deviceId: 1,
    className: 'person',
    firstSeen: 1_000_000,
    lastSeen: 1_010_000,
    totalDistance: 1,
    state: 'moving',
    ...over,
  }
}

export interface FakeOptions {
  /** Frames the track-keyed lists start with. */
  readonly copies?: Readonly<Record<string, RetrainFrame>>
  readonly annotations?: Readonly<Record<string, readonly RetrainAnnotation[]>>
  readonly failOn?: ReadonlySet<string>
  readonly failWith?: Error
}

const KPI: RetrainCorpusKpi = { total: 0, unannotated: 0, annotated: 0, complete: 0, cameras: [] }

export function frameFor(trackId: string, over: Partial<RetrainFrame> = {}): RetrainFrame {
  return {
    frameId: `retrain:${trackId}:f`,
    deviceId: 1,
    origin: 'track',
    trackId,
    sourceKind: 'keyFrame',
    sizeBytes: 10,
    width: 100,
    height: 100,
    copiedAt: 1,
    complete: false,
    pipelineBoxes: [
      {
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        macroClass: 'animal',
        label: 'cat',
        trackId,
        basis: 'subject-box',
        deltaMs: 0,
      },
    ],
    ...over,
  }
}

export function annotation(frameId: string): RetrainAnnotation {
  return {
    id: 'a1',
    deviceId: 1,
    mediaKey: frameId,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    macroClass: 'animal',
    kind: 'subject',
    source: 'operator',
    createdAt: 1,
  }
}

/** Records every call by name; the writes mutate the in-memory state. */
export class FakeHub implements ReviewHub {
  readonly calls: string[] = []
  readonly saved: {
    frameId: string
    annotations: readonly RetrainAnnotationDraft[]
    expectedRevision?: number
  }[] = []
  readonly backfilled: {
    frameId: string
    origins: readonly OriginBackfill[]
    expectedRevision?: number
  }[] = []
  /** Frames the collection pages serve (the backfill walks them). */
  readonly pageFrames: RetrainFrame[] = []
  readonly collections: RetrainCollection[] = []
  readonly members = new Set<string>()
  private readonly copies = new Map<string, RetrainFrame>()
  private readonly notes = new Map<string, readonly RetrainAnnotation[]>()
  kpi: RetrainCorpusKpi = KPI

  constructor(private readonly options: FakeOptions = {}) {
    for (const [k, v] of Object.entries(options.copies ?? {})) this.copies.set(k, v)
    for (const [k, v] of Object.entries(options.annotations ?? {})) this.notes.set(k, v)
  }

  private hit(name: string): void {
    this.calls.push(name)
    if (this.options.failOn?.has(name)) throw this.options.failWith ?? new Error(`${name} failed`)
  }

  get writes(): readonly string[] {
    const writeNames = new Set([
      'setTrackFlags',
      'selectRetrainFrames',
      'saveRetrainAnnotations',
      'backfillRetrainOrigins',
      'setRetrainFrameComplete',
      'createCollection',
      'addFramesToCollection',
    ])
    return this.calls.filter((c) => writeNames.has(c))
  }

  async listCameras() {
    this.hit('listCameras')
    return [{ id: 1, name: 'cam', type: DeviceType.Camera, disabled: false }]
  }
  async listRecentTracks() {
    this.hit('listRecentTracks')
    return { tracks: [], nextCursor: null }
  }
  async getTrack(_d: number, _t: string): Promise<TriageTrack | null> {
    this.hit('getTrack')
    return null
  }
  async listTrackMedia(_d: number, _t: string): Promise<readonly Omit<MediaFile, 'base64'>[]> {
    this.hit('listTrackMedia')
    return []
  }
  async getTrackMedia(
    _d: number,
    _t: string,
    _kinds: readonly MediaKind[],
  ): Promise<readonly MediaFile[]> {
    this.hit('getTrackMedia')
    return []
  }
  async getCorpusKpi() {
    this.hit('getCorpusKpi')
    return this.kpi
  }
  async listCollections() {
    this.hit('listCollections')
    return this.collections
  }
  async listRetrainFrames(trackId: string): Promise<RetrainFrameList> {
    this.hit('listRetrainFrames')
    const copy = this.copies.get(trackId)
    return {
      candidates: [
        { mediaId: 7, kind: 'keyFrame', timestamp: 1, sizeBytes: 1, copied: copy !== undefined },
      ],
      copies: copy ? [copy] : [],
      autoPickMediaId: 7,
    }
  }
  async listRetrainAnnotations(frameIds: readonly string[]) {
    this.hit('listRetrainAnnotations')
    return frameIds.flatMap((f) => this.notes.get(f) ?? [])
  }
  async listRetrainCorpusPage(): Promise<RetrainCorpusPage> {
    this.hit('listRetrainCorpusPage')
    const frames = this.pageFrames.map((f) => ({ ...f, workState: 'annotated' as const }))
    return { frames, total: frames.length, page: 1, pageSize: 100 }
  }
  async backfillRetrainOrigins(
    _d: number,
    _t: string | undefined,
    frameId: string,
    origins: readonly OriginBackfill[],
    expectedRevision?: number,
  ) {
    this.hit('backfillRetrainOrigins')
    this.backfilled.push({
      frameId,
      origins,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
    return { updated: origins.length, skipped: 0, revision: (expectedRevision ?? 0) + 1 }
  }
  async setTrackFlags(_d: number, trackId: string, markForTrain: boolean) {
    this.hit('setTrackFlags')
    return {
      trackId,
      markForTrain,
      debug: false,
      debugNote: '',
      favourited: false,
      retrainStatus: 'staging' as const,
    }
  }
  async selectRetrainFrames(_d: number, trackId: string) {
    this.hit('selectRetrainFrames')
    const frame = frameFor(trackId)
    this.copies.set(trackId, frame)
    return { copied: [{ ...frame, pipelineBoxes: undefined }], refused: [] }
  }
  async saveRetrainAnnotations(
    _d: number,
    _t: string,
    frameId: string,
    annotations: readonly RetrainAnnotationDraft[],
    expectedRevision?: number,
  ) {
    this.hit('saveRetrainAnnotations')
    this.saved.push({
      frameId,
      annotations,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
    const rows = annotations.map((a, i) => ({
      ...a,
      id: `n${i}`,
      deviceId: 1,
      mediaKey: frameId,
      createdAt: 1,
    }))
    this.notes.set(frameId, rows)
    return rows
  }
  async setRetrainFrameComplete(_d: number, trackId: string, frameId: string, complete: boolean) {
    this.hit('setRetrainFrameComplete')
    const copy = this.copies.get(trackId)
    if (copy) this.copies.set(trackId, { ...copy, complete })
    return { frameId, complete }
  }
  async createCollection(name: string) {
    this.hit('createCollection')
    const collection = { id: `c-${name}`, name, createdAt: 1, frameCount: 0 }
    this.collections.push(collection)
    return { kind: 'created' as const, collection }
  }
  async addFramesToCollection(
    _c: string,
    frameIds: readonly string[],
  ): Promise<AddToCollectionResult> {
    this.hit('addFramesToCollection')
    let added = 0
    let already = 0
    for (const f of frameIds) {
      if (this.members.has(f)) already++
      else {
        this.members.add(f)
        added++
      }
    }
    return { added, alreadyMember: already, unknownFrameIds: [] }
  }
}
