/**
 * Synthetic rotated-log rows, byte-identical in shape to what
 * `winston.format.json()` writes (keys sorted, top-level `timestamp` last).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface RowSpec {
  readonly id: string
  readonly ts: number
  readonly level?: 'debug' | 'info' | 'warn' | 'error'
  readonly message?: string
  readonly deviceId?: number
  readonly addonId?: string
  readonly agentId?: string
  readonly meta?: Record<string, unknown>
}

export function row(spec: RowSpec): string {
  const tags: Record<string, string | number> = {}
  if (spec.addonId !== undefined) tags['addonId'] = spec.addonId
  if (spec.agentId !== undefined) tags['agentId'] = spec.agentId
  if (spec.deviceId !== undefined) tags['deviceId'] = spec.deviceId
  const out: Record<string, unknown> = {
    id: spec.id,
    level: spec.level ?? 'info',
    message: spec.message ?? `line ${spec.id}`,
  }
  if (spec.meta !== undefined) out['meta'] = spec.meta
  out['scope'] = 'spec'
  out['tags'] = tags
  out['timestamp'] = new Date(spec.ts).toISOString()
  return JSON.stringify(out)
}

export function writeRows(dir: string, fileName: string, rows: readonly RowSpec[]): string {
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, rows.map((r) => `${row(r)}\n`).join(''))
  return filePath
}

export function appendRows(filePath: string, rows: readonly RowSpec[]): void {
  fs.appendFileSync(filePath, rows.map((r) => `${row(r)}\n`).join(''))
}

/** `n` rows for one busy device, padded so each is ~`bytes` long. */
export function busyRows(opts: {
  readonly n: number
  readonly startTs: number
  readonly prefix: string
  readonly deviceId: number
  readonly bytes?: number
}): RowSpec[] {
  const pad = 'x'.repeat(Math.max(0, (opts.bytes ?? 300) - 200))
  return Array.from({ length: opts.n }, (_, i) => ({
    id: `${opts.prefix}.${String(i)}`,
    ts: opts.startTs + i,
    deviceId: opts.deviceId,
    addonId: 'busy-addon@1.0.0',
    agentId: 'hub',
    message: `busy ${String(i)} ${pad}`,
  }))
}
