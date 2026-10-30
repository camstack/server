import type { AuditRecord } from '../mutation-gate.js'

export function auditLog(): { records: AuditRecord[]; sink: (r: AuditRecord) => void } {
  const records: AuditRecord[] = []
  return { records, sink: (r) => records.push(r) }
}
