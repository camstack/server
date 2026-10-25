/**
 * ONE permissive JSON reader for model replies.
 *
 * There were three byte-identical copies of the extraction below — in
 * `NcConfirmGate`, `SceneConfirmGate` and `scene-llm-adapter` — each followed by
 * its own hand-written field checks. Three copies of a parser is three chances
 * to fix a bug in one place and not the others.
 *
 * The leniency is NOT vestigial now that the schema reaches the provider. A
 * `json_schema` constrains a hosted model well and a local one loosely: llama.cpp
 * still fences its answer, prefixes it with "Sure!", or emits a trailing
 * sentence. The schema makes the reply usually-clean; this makes usually into
 * always-or-null.
 *
 * Validation is Zod, not `typeof` chains, so the SHAPE lives with the caller's
 * schema and a missing field is a null rather than a silently-defaulted verdict.
 */
import type { z } from 'zod'

/**
 * Slice the outermost `{…}` out of a reply.
 *
 * Outermost, not first-balanced: a model that emits prose containing a brace
 * before the real answer is rarer than one that wraps the answer in fences, and
 * the widest slice survives both.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return text.slice(start, end + 1)
}

/**
 * Reply text → a validated answer, or `null`.
 *
 * `null` means "the model did not answer the question asked". Every caller
 * treats that as its own kind of no-answer — fail-open for a notification,
 * fail-closed for a scene latch — which is exactly why this returns null
 * instead of throwing or guessing.
 */
export function parseModelJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const slice = extractJsonObject(text)
  if (slice === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }
  const result = schema.safeParse(parsed)
  return result.success ? result.data : null
}
