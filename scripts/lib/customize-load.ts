/**
 * Load every cap that declares `customize` (D936). The judge stays pure;
 * this module is the only one that imports the cap files.
 */
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { CapabilityCustomizeSpec } from '../../packages/types/src/capabilities/customize-spec.ts'
import { runtimeFieldUnits } from '../../packages/types/src/capabilities/runtime-field-units.ts'
import { parseAllCaps } from './parse-cap.ts'
import {
  vocabularyHas,
  type CustomizeCapView,
  type CustomizeItemArrayView,
} from './customize-declaration.ts'

const CAPS_DIR = path.resolve(import.meta.dirname, '../../packages/types/src/capabilities')

interface FromState {
  readonly field: string
  readonly on: string
}

interface EventRecord {
  readonly fromState?: FromState
}

export async function loadCustomizeCaps(): Promise<readonly CustomizeCapView[]> {
  const out: CustomizeCapView[] = []
  for (const info of parseAllCaps(CAPS_DIR)) {
    const file = info.fileName.replace(/\.js$/, '.ts')
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(CAPS_DIR, file)).href)
    const def = mod[info.exportName]
    if (!isRecord(def)) continue
    const customize = isCustomizeSpec(def.customize) ? def.customize : undefined
    if (customize === undefined) continue
    const runtime = def.runtimeState instanceof z.ZodObject ? def.runtimeState : undefined
    out.push({
      capName: info.capName,
      runtimeState: runtime,
      deviceTypes: readStrings(def.deviceTypes),
      events: readEvents(def.events),
      itemArray: readItemArray(def.status),
      customize,
      vocabularyHas,
    })
  }
  return out.toSorted((a, b) => a.capName.localeCompare(b.capName))
}

/** Caps whose runtime state declares a unit, for composed-device convert-unit rows. */
export async function loadRuntimeFieldUnits(): Promise<
  Readonly<Record<string, Readonly<Record<string, string>>>>
> {
  const out: Record<string, Readonly<Record<string, string>>> = {}
  for (const info of parseAllCaps(CAPS_DIR)) {
    const file = info.fileName.replace(/\.js$/, '.ts')
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(CAPS_DIR, file)).href)
    const def = mod[info.exportName]
    if (!isRecord(def) || !(def.runtimeState instanceof z.ZodObject)) continue
    const units = runtimeFieldUnits(def.runtimeState)
    if (Object.keys(units).length > 0) out[info.capName] = units
  }
  return out
}

function isCustomizeSpec(value: unknown): value is CapabilityCustomizeSpec {
  if (!isRecord(value)) return false
  if (value.version !== 1) return false
  return Array.isArray(value.targets)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function readStrings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : undefined
}

function readEvents(value: unknown): CustomizeCapView['events'] {
  if (!isRecord(value)) return undefined
  const out: Record<string, EventRecord> = {}
  for (const [name, event] of Object.entries(value)) {
    out[name] = readFromState(event)
  }
  return out
}

function readFromState(event: unknown): EventRecord {
  if (!isRecord(event) || !isRecord(event.fromState)) return {}
  const field = event.fromState.field
  const on = event.fromState.on
  if (typeof field !== 'string' || typeof on !== 'string') return {}
  return { fromState: { field, on } }
}

function readItemArray(status: unknown): CustomizeItemArrayView | undefined {
  if (!isRecord(status) || !isRecord(status.itemArray)) return undefined
  const itemPath = status.itemArray.path
  const keyField = status.itemArray.keyField
  const labelField = status.itemArray.labelField
  if (
    typeof itemPath !== 'string' ||
    typeof keyField !== 'string' ||
    typeof labelField !== 'string'
  ) {
    return undefined
  }
  return { path: itemPath, keyField, labelField }
}
