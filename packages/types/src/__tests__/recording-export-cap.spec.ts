import { describe, expect, it } from 'vitest'
import {
  CreateExportInputSchema,
  ExportOptionsSchema,
  recordingExportCapability,
} from '../capabilities/recording-export.cap.js'

const OPTIONS = {
  speed: 1,
  includeAudio: true,
  maxLifeMs: 604_800_000,
  deleteAfterDownload: false,
} as const

function baseInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { deviceId: 101, fromMs: 1_000, toMs: 6_000, options: OPTIONS, ...over }
}

describe('recording-export cap', () => {
  it('is named in kebab-case, like every cap the transport has to recover', () => {
    // `ctx.api.recordingExport` derives its property from `kebabToCamel(name)`;
    // the transport recovers the name with `toKebab`. A camel name (this cap
    // shipped as `recordingExport`) makes those two disagree and every
    // forked-addon call fails. Guard: `scripts/check-cap-name-kebab.ts`.
    expect(recordingExportCapability.name).toBe('recording-export')
  })

  it('is a system singleton with the seven methods', () => {
    expect(recordingExportCapability.scope).toBe('system')
    expect(recordingExportCapability.mode).toBe('singleton')
    expect(Object.keys(recordingExportCapability.methods).sort()).toEqual([
      'cancelExport',
      'createExport',
      'deleteExport',
      'getDownloadUrl',
      'getExport',
      'listExports',
      'readExportBytes',
    ])
  })

  it('createExport is a protected mutation', () => {
    expect(recordingExportCapability.methods.createExport.kind).toBe('mutation')
    expect(recordingExportCapability.methods.createExport.auth).toBe('protected')
  })

  it('rejects speed and timelapse together', () => {
    const r = ExportOptionsSchema.safeParse({
      speed: 2,
      timelapse: { everyMs: 1000 },
      includeAudio: false,
      maxLifeMs: 1000,
      deleteAfterDownload: false,
    })
    expect(r.success).toBe(false)
  })

  it('accepts a plain 1x export with audio', () => {
    const r = ExportOptionsSchema.safeParse({
      speed: 1,
      includeAudio: true,
      maxLifeMs: 604_800_000,
      deleteAfterDownload: true,
    })
    expect(r.success).toBe(true)
  })
})

describe('createExport input — profiles[] + legacy profile', () => {
  const schema = recordingExportCapability.methods.createExport.input

  it('stays a ZodObject so generated routers can call .loose() for nodeId', () => {
    expect(typeof schema.loose).toBe('function')
    const r = schema.loose().safeParse(baseInput({ profile: 'main', nodeId: 'hub' }))
    expect(r.success).toBe(true)
  })

  // The legacy rewrite itself is pinned by `export-subject.spec.ts` through
  // `resolveCreateExportSubject`, which is the function the PROVIDER actually
  // calls. `preprocessCreateExportInput` used to live here with tests and no
  // caller at all — a leftover that described the right design and ran none of
  // it — and was deleted on 2026-09-21.

  it('accepts the legacy singular profile (timelapse scheduler / notifiers)', () => {
    const r = schema.safeParse(baseInput({ profile: 'main' }))
    expect(r.success).toBe(true)
  })

  it('accepts profiles[] of one or more streams', () => {
    expect(schema.safeParse(baseInput({ profiles: ['main'] })).success).toBe(true)
    expect(schema.safeParse(baseInput({ profiles: ['main', 'low', 'mid'] })).success).toBe(true)
  })

  it('rejects an empty profiles[] and a request with neither field', () => {
    expect(schema.safeParse(baseInput({ profiles: [] })).success).toBe(false)
    expect(schema.safeParse(baseInput({})).success).toBe(false)
  })

  it('CreateExportInputSchema matches the cap method input', () => {
    expect(CreateExportInputSchema).toBe(schema)
  })
})
