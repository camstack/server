/**
 * Process slot: when the mesh CA becomes ready, the hub enables its TLS
 * listener (issues a CN=hub leaf and calls TlsTcpTransporter.enableMeshTls).
 */
import type { MeshTlsMaterial } from './tls-tcp-transporter.js'

export type MeshTlsEnabler = (material: MeshTlsMaterial) => void | Promise<void>

const SLOT = Symbol.for('camstack.mesh.tls-enabler')

export function setProcessMeshTlsEnabler(enabler: MeshTlsEnabler | null): void {
  if (enabler === null) Reflect.deleteProperty(globalThis, SLOT)
  else Reflect.set(globalThis, SLOT, enabler)
}

export function getProcessMeshTlsEnabler(): MeshTlsEnabler | null {
  const value: unknown = Reflect.get(globalThis, SLOT)
  return typeof value === 'function' ? (value as MeshTlsEnabler) : null
}

export async function requestProcessMeshTlsEnable(material: MeshTlsMaterial): Promise<void> {
  const enabler = getProcessMeshTlsEnabler()
  if (enabler === null) return
  await enabler(material)
}
