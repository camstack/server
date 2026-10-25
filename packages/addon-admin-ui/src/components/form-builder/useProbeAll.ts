import { useState, useCallback, useMemo } from 'react'
import type { ConfigUISchema, ConfigField, FieldProbeResult } from '../../types/config-ui'

/** Probe state for a single field */
export interface ProbeState {
  status: 'probing' | 'ok' | 'error'
  result?: FieldProbeResult
}

/** Collect all probe field keys from a schema (including nested groups) */
function collectProbeKeys(fields: readonly ConfigField[]): string[] {
  const keys: string[] = []
  for (const field of fields) {
    if (field.type === 'probe') keys.push(field.key)
    if (field.type === 'group' && 'fields' in field) {
      keys.push(...collectProbeKeys(field.fields))
    }
  }
  return keys
}

export function useProbeAll(
  schema: ConfigUISchema,
  values: Record<string, unknown>,
  onTestField?: (key: string, value: unknown) => Promise<FieldProbeResult>,
) {
  const [testAllStatus, setTestAllStatus] = useState<'idle' | 'testing'>('idle')
  const [probeResults, setProbeResults] = useState<Record<string, ProbeState>>({})

  const probeKeys = useMemo(() => {
    const keys: string[] = []
    for (const section of schema.sections) {
      keys.push(...collectProbeKeys(section.fields))
    }
    return keys
  }, [schema])

  const hasProbeFields = probeKeys.length > 0 && onTestField !== undefined

  const clearProbeResult = useCallback((key: string) => {
    setProbeResults((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const handleTestAll = useCallback(async () => {
    if (!onTestField) return

    const fieldsToTest = probeKeys.filter((key) => {
      const val = values[key]
      return val !== undefined && val !== null && String(val).trim() !== ''
    })

    if (fieldsToTest.length === 0) return

    setTestAllStatus('testing')

    // Set all to probing
    const initial: Record<string, ProbeState> = {}
    for (const key of fieldsToTest) {
      initial[key] = { status: 'probing' }
    }
    setProbeResults(initial)

    // Run all probes in parallel. Each entry is paired with its key
    // so a thrown probe (e.g. tRPC validation errors like "Password is
    // required") becomes a visible `error` state on the field rather
    // than an unhandled promise rejection in the console.
    const results = await Promise.allSettled(
      fieldsToTest.map(async (key) => {
        try {
          const result = await onTestField(key, values[key])
          return { key, result }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const result: FieldProbeResult = { status: 'error', error: message }
          return { key, result }
        }
      }),
    )

    const updated: Record<string, ProbeState> = {}
    for (const entry of results) {
      // Promise.allSettled never rejects on the inner level above
      // (the inner try/catch synthesizes an error result), but defend
      // anyway in case the wrapping promise itself fails.
      if (entry.status === 'fulfilled') {
        const { key, result } = entry.value
        updated[key] = { status: result.status === 'ok' ? 'ok' : 'error', result }
      }
    }
    setProbeResults(updated)
    setTestAllStatus('idle')
  }, [onTestField, probeKeys, values])

  return {
    testAllStatus,
    hasProbeFields,
    probeResults,
    handleTestAll,
    clearProbeResult,
  }
}
