/**
 * The API explorer prefill audit: EVERY capability method the catalogue serves
 * gets an editor input that is not `null`, and that input is accepted by the
 * method's own Zod input parser. The schema is built exactly the way the hub's
 * `apiCatalog.inputSchema` builds it (`z.toJSONSchema`, `io: 'input'`).
 *
 * Core (non-cap) routers are not walked here: they need the hub's services.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as capsModule from '@dominevo/types'
import type { CapabilityDefinition } from '@dominevo/types'
import { formSeed } from '../api-input-fields'

function isCapabilityDefinition(value: unknown): value is CapabilityDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'methods' in value &&
    typeof value.methods === 'object' &&
    value.methods !== null &&
    'mode' in value
  )
}

/**
 * Methods whose input JSON cannot carry what the parser wants: raw bytes and
 * `Date` have no JSON form (a byte payload travels through `ctx.peerBytes`).
 * The editor still opens on the rest of the input.
 */
const NOT_JSON_REPRESENTABLE: ReadonlySet<string> = new Set([
  'audio-analyzer.analyseChunk',
  'audio-analyzer.classify',
  'audio-codec.pushEncodedFrame',
  'audio-codec.pushPcm',
  'embedding-encoder.encode',
  'llm.generateVision',
  'log-destination.write',
  'pipeline-executor.cacheFrameInPool',
  'storage.write',
  'storage.writeChunk',
  'storage-provider.write',
  'storage-provider.writeChunk',
])

/**
 * Methods whose parser has a cross-field `.refine` (or a catalogue the schema
 * cannot enumerate): the JSON Schema cannot say which value passes, so the
 * skeleton cannot be derived from it. The message names the rule.
 */
const REFINED: ReadonlySet<string> = new Set([
  'core-blocks.create',
  'core-blocks.compile',
  'recording-export.createExport',
  'remote.sendCommand',
  'storage-migration.plan',
  'storage-migration.start',
  'tags.setStyle',
  'ir-transmitter.send',
  'pipeline-orchestrator.setAgentReachableHost',
])

interface AuditResult {
  readonly methods: number
  readonly withInput: number
  readonly failing: readonly string[]
  readonly nullSkeleton: readonly string[]
}

function audit(): AuditResult {
  const failing: string[] = []
  const nullSkeleton: string[] = []
  let methods = 0
  let withInput = 0
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(capsModule)) {
    if (!key.endsWith('Capability') || !isCapabilityDefinition(value)) continue
    if (seen.has(value.name)) continue
    seen.add(value.name)
    for (const [name, def] of Object.entries(value.methods)) {
      methods += 1
      const path = `${value.name}.${name}`
      const input: z.ZodType = def.input
      const schema: Readonly<Record<string, unknown>> = z.toJSONSchema(input, {
        io: 'input',
        unrepresentable: 'any',
      })
      const seed = formSeed(schema)
      // A void input is "no input": the editor starts empty and sends nothing.
      if (seed !== undefined) withInput += 1
      if (seed === null && !input.safeParse(null).success) nullSkeleton.push(path)
      if (!input.safeParse(seed).success) failing.push(path)
    }
  }
  return { methods, withInput, failing, nullSkeleton }
}

describe('API explorer prefill audit', () => {
  const result = audit()

  it('walks every capability method', () => {
    expect(result.methods).toBeGreaterThan(1000)
    expect(result.withInput).toBeGreaterThan(500)
  })

  it('no method with an input opens on null', () => {
    expect(result.nullSkeleton).toEqual([])
  })

  it('every method opens on an input its own parser accepts, bar the named exceptions', () => {
    const exceptions = new Set([...NOT_JSON_REPRESENTABLE, ...REFINED])
    expect(result.failing.filter((p) => !exceptions.has(p))).toEqual([])
    // An exception that now passes is a stale entry: drop it.
    expect([...exceptions].filter((p) => !result.failing.includes(p))).toEqual([])
  })
})
