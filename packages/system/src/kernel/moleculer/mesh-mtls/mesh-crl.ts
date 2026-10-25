/**
 * Mesh certificate revocation list — in-memory + optional persist hook.
 *
 * Release A can stub persistence; the reader checks serials at handshake and
 * a later "Forget node" closes open sockets (Release A+).
 */
export class MeshCrl {
  private readonly serials = new Set<string>()

  revoke(serialNumber: string): void {
    this.serials.add(normalizeSerial(serialNumber))
  }

  isRevoked(serialNumber: string): boolean {
    return this.serials.has(normalizeSerial(serialNumber))
  }

  list(): readonly string[] {
    return [...this.serials]
  }

  /** Restore from persisted serials (system-settings). */
  replaceAll(serials: readonly string[]): void {
    this.serials.clear()
    for (const s of serials) this.serials.add(normalizeSerial(s))
  }
}

function normalizeSerial(serial: string): string {
  return serial.replace(/^0x/i, '').replace(/:/g, '').toLowerCase()
}

const SLOT = Symbol.for('camstack.mesh.crl')

export function processMeshCrl(): MeshCrl {
  const existing: unknown = Reflect.get(globalThis, SLOT)
  if (existing instanceof MeshCrl) return existing
  const crl = new MeshCrl()
  Reflect.set(globalThis, SLOT, crl)
  return crl
}

export function clearProcessMeshCrl(): void {
  Reflect.deleteProperty(globalThis, SLOT)
}
