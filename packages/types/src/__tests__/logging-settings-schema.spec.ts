/**
 * The boundary that makes the logging document mergeable.
 *
 * Three properties are load-bearing and none of them is visible from the
 * provider — by the time the provider runs, the schema has already decided
 * what "absent" means:
 *
 *  - **Absent ≠ null.** `level: undefined` must mean "leave it alone" and
 *    `level: null` must mean "clear this scope so it inherits again". Collapse
 *    them and either arming a diagnostic wipes a level, or a level can never
 *    be un-set at all.
 *  - **Every field is optional.** A patch naming only `diagnostics` has to
 *    parse, or an operator arming a census is forced to restate a level they
 *    did not mean to touch.
 *  - **The layer selector is not `nodeId`.** `nodeId` is reserved on every cap
 *    method input: the generated router strips it and resolves the provider on
 *    THAT node. A document about `agent-1` addressed as `nodeId` would be
 *    answered by an agent holding no cluster document at all.
 *
 * Neutralisation: change `level` to `LogLevelSchema.optional()` and the
 * "clears" case fails; make `patch` non-partial and the diagnostics-only case
 * fails. Confirmed 2026-08-27.
 */

import { describe, expect, it } from 'vitest'
import {
  GetLoggingSettingsInputSchema,
  LoggingSettingsPatchSchema,
  SetLoggingSettingsInputSchema,
  systemCapability,
} from '../capabilities/index.js'

describe('LoggingSettingsPatchSchema', () => {
  it('parses an EMPTY patch — every field is optional', () => {
    const parsed = LoggingSettingsPatchSchema.parse({})

    expect(parsed).toEqual({})
    expect('level' in parsed).toBe(false)
  })

  it('keeps `null` distinct from absent, so a scope can be CLEARED', () => {
    expect(LoggingSettingsPatchSchema.parse({ level: null })).toEqual({ level: null })
    expect(LoggingSettingsPatchSchema.parse({}).level).toBeUndefined()
  })

  it('accepts a patch that names only the diagnostics', () => {
    const parsed = LoggingSettingsPatchSchema.parse({
      diagnostics: [{ id: 'request-census', armMs: 120_000 }],
    })

    expect(parsed.diagnostics).toEqual([{ id: 'request-census', armMs: 120_000 }])
    expect(parsed.level).toBeUndefined()
  })

  it('refuses an unknown level, an unknown diagnostic and a negative window', () => {
    expect(LoggingSettingsPatchSchema.safeParse({ level: 'shout' }).success).toBe(false)
    expect(
      LoggingSettingsPatchSchema.safeParse({ diagnostics: [{ id: 'nope', armMs: 1 }] }).success,
    ).toBe(false)
    expect(
      LoggingSettingsPatchSchema.safeParse({
        diagnostics: [{ id: 'request-census', armMs: -1 }],
      }).success,
    ).toBe(false)
  })
})

describe('the layer selector avoids the reserved routing key', () => {
  it('addresses a layer with `scopeNodeId` / `scopeComponent`, never `nodeId`', () => {
    expect(Object.keys(GetLoggingSettingsInputSchema.shape).sort()).toEqual([
      'scopeComponent',
      'scopeNodeId',
    ])
    expect(Object.keys(SetLoggingSettingsInputSchema.shape)).toContain('scopeNodeId')
    expect(Object.keys(SetLoggingSettingsInputSchema.shape)).toContain('scopeComponent')
    // The one that must never appear. `nodeId` is stripped by the generated
    // router to resolve the PROVIDER, so a document about `agent-1` addressed
    // that way would be answered by an agent holding no cluster document.
    expect(Object.keys(GetLoggingSettingsInputSchema.shape)).not.toContain('nodeId')
    expect(Object.keys(SetLoggingSettingsInputSchema.shape)).not.toContain('nodeId')
  })

  it('the component selector is its OWN key, not an overload of the node one', () => {
    // Collapsing them would make "which of these two did I just set"
    // unanswerable — the exact ambiguity `explicit` exists to remove. A
    // component level is cluster-wide; a node level is not.
    const parsed = SetLoggingSettingsInputSchema.parse({
      scopeComponent: 'stream-broker.webrtc',
      patch: { level: 'error' },
    })

    expect(parsed.scopeComponent).toBe('stream-broker.webrtc')
    expect(parsed.scopeNodeId).toBeUndefined()
  })

  it('accepts a patch that names only the CHANNELS, and refuses a negative window', () => {
    const parsed = LoggingSettingsPatchSchema.parse({
      channels: [{ channel: 'stream-broker.webrtc', armMs: 120_000, deviceIds: [102] }],
    })

    expect(parsed.channels).toEqual([
      { channel: 'stream-broker.webrtc', armMs: 120_000, deviceIds: [102] },
    ])
    expect(parsed.level).toBeUndefined()
    expect(
      LoggingSettingsPatchSchema.safeParse({
        channels: [{ channel: 'a.b', armMs: -1 }],
      }).success,
    ).toBe(false)
  })
})

describe('the system cap exposes ONE pair for logging', () => {
  it('has getLoggingSettings + setLoggingSettings, and no per-knob write', () => {
    const methods = Object.keys(systemCapability.methods)

    expect(methods).toContain('getLoggingSettings')
    expect(methods).toContain('setLoggingSettings')
    // Retired 2026-08-27: a second write authority over the same window.
    expect(methods).not.toContain('setRequestCensus')
    // The census READ stays — it returns a measurement, not a setting.
    expect(methods).toContain('getRequestCensus')
  })

  it('keeps both logging methods admin-only', () => {
    expect(systemCapability.methods.getLoggingSettings.auth).toBe('admin')
    expect(systemCapability.methods.setLoggingSettings.auth).toBe('admin')
    expect(systemCapability.methods.setLoggingSettings.kind).toBe('mutation')
  })
})
