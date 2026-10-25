import { describe, expect, it } from 'vitest'
import { llmCapability } from '../llm.cap.js'
import { llmRuntimeCapability } from '../llm-runtime.cap.js'

/**
 * The TRANSPORT must never be the layer that gives up on an AI call first.
 *
 * A cap method that declares no `timeoutMs` inherits the kernel's 60 s UDS
 * default. The AI layer above it is deliberately far more patient — a summary
 * asks for 180 s by default and a rule may ask for 600 s — so an undeclared
 * method silently caps every one of those at 60 s and reports the failure as a
 * TRANSPORT error, which names the wrong layer and hides the real one.
 *
 * Measured 2026-09-03: a 6-image vision request took 44.8 s warm and ~20 s more
 * on a cold model load. The AI layer would have waited; the transport did not,
 * and every digest for days shipped without its text.
 *
 * These methods run inference or move model bytes. They are slow BY NATURE, not
 * by accident, and each must declare a bound at least as generous as the
 * longest the AI layer is allowed to ask for.
 */
const AI_LAYER_MAX_TIMEOUT_MS = 600_000

interface MethodLike {
  readonly timeoutMs?: number
}

function timeoutOf(cap: { readonly methods: Record<string, unknown> }, name: string): number {
  const method = cap.methods[name] as MethodLike | undefined
  expect(method, `${name} is not a method of this capability`).toBeDefined()
  return method?.timeoutMs ?? 0
}

describe('AI capabilities declare a transport timeout the AI layer cannot outlive', () => {
  it.each([
    'generate',
    'generateVision',
    'testProfile',
  ])('llm.%s outlives the AI layer’s own maximum', (name) => {
    expect(timeoutOf(llmCapability, name)).toBeGreaterThanOrEqual(AI_LAYER_MAX_TIMEOUT_MS)
  })

  it.each([
    'complete',
    'completeApple',
    'ensureStarted',
    'installModel',
  ])('llmRuntime.%s outlives the AI layer’s own maximum', (name) => {
    expect(timeoutOf(llmRuntimeCapability, name)).toBeGreaterThanOrEqual(AI_LAYER_MAX_TIMEOUT_MS)
  })

  it('leaves the CHEAP methods on the default — patience is for work, not for lookups', () => {
    expect(timeoutOf(llmCapability, 'listProfiles')).toBe(0)
    expect(timeoutOf(llmRuntimeCapability, 'status')).toBe(0)
    expect(timeoutOf(llmRuntimeCapability, 'appleAvailability')).toBe(0)
    expect(timeoutOf(llmRuntimeCapability, 'cancel')).toBe(0)
  })
})
