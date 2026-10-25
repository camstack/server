import type { CamStackTheme, DeepPartial } from './types'
import { defaultTheme } from './defaults'

function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target }
  for (const key in source) {
    const sourceVal = source[key]
    const targetVal = target[key]
    if (
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      ) as T[typeof key]
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[typeof key]
    }
  }
  return result
}

export function createTheme(overrides?: DeepPartial<CamStackTheme>): CamStackTheme {
  if (!overrides) return structuredClone(defaultTheme)
  return deepMerge(structuredClone(defaultTheme), overrides)
}
