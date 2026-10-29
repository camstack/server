/**
 * What pairing writes to, and removes from, `agent.json` (D857). The file is
 * 0600 on every OS; this module only ever touches the keys named below. An older
 * `secret` field is neither read nor removed here — the operator deletes it.
 */
import { X509Certificate } from 'node:crypto'
import * as fs from 'node:fs'
import { agentHttpsPaths, type InstalledPairing } from '@camstack/system'
import { readJsonFile, writeJsonFile0600 } from './agent-json-file.js'

/** Keys that exist only while this agent is paired. */
const PAIRED_KEYS: readonly string[] = [
  'meshTls',
  'meshTlsPrevious',
  'meshSwap',
  'hubAddress',
  'hubUrl',
]

/** `agent.json` holds mesh material: the agent is paired. */
export function isAgentPaired(configPath: string): boolean {
  const meshTls: unknown = readJsonFile(configPath)['meshTls']
  return (
    meshTls !== null &&
    typeof meshTls === 'object' &&
    typeof Reflect.get(meshTls, 'certPem') === 'string' &&
    typeof Reflect.get(meshTls, 'keyPem') === 'string' &&
    typeof Reflect.get(meshTls, 'caCertPem') === 'string'
  )
}

/** The CA certificate this agent pinned at pairing, or `null` while unpaired. */
export function pinnedMeshCaCert(configPath: string): string | null {
  const meshTls: unknown = readJsonFile(configPath)['meshTls']
  if (meshTls === null || typeof meshTls !== 'object') return null
  const ca: unknown = Reflect.get(meshTls, 'caCertPem')
  return typeof ca === 'string' && ca.length > 0 ? ca : null
}

/** Persist a completed pairing: the leaf, its key, the pinned CA and the hub's host. */
export function persistPairing(configPath: string, pairing: InstalledPairing): void {
  const { meshTlsPrevious: _previous, meshSwap: _swap, ...existing } = readJsonFile(configPath)
  writeJsonFile0600(configPath, {
    ...existing,
    hubAddress: pairing.hubAddress,
    // The hub's API address the hub itself gave: where a refused agent asks "am I still a member?".
    hubUrl: pairing.hubUrl,
    meshTls: pairing.meshTls,
  })
}

/** What a refused agent needs to ask its hub whether it is still a member (D857), or `null`. */
export interface PairedHubIdentity {
  readonly hubUrl: string | null
  readonly hubAddress: string | null
  readonly certPem: string
  readonly keyPem: string
  readonly caCertPem: string
}

export function readPairedHubIdentity(configPath: string): PairedHubIdentity | null {
  const config = readJsonFile(configPath)
  const meshTls: unknown = config['meshTls']
  if (meshTls === null || typeof meshTls !== 'object') return null
  const certPem: unknown = Reflect.get(meshTls, 'certPem')
  const keyPem: unknown = Reflect.get(meshTls, 'keyPem')
  const caCertPem: unknown = Reflect.get(meshTls, 'caCertPem')
  if (typeof certPem !== 'string' || typeof keyPem !== 'string' || typeof caCertPem !== 'string') {
    return null
  }
  const hubUrl: unknown = config['hubUrl']
  const hubAddress: unknown = config['hubAddress']
  return {
    hubUrl: typeof hubUrl === 'string' && hubUrl.length > 0 ? hubUrl : null,
    hubAddress: typeof hubAddress === 'string' && hubAddress.length > 0 ? hubAddress : null,
    certPem,
    keyPem,
    caCertPem,
  }
}

/**
 * Leave the hub: erase the mesh material, the hub address and the HTTPS bundle
 * the hub issued. The agent is unpaired afterwards and accepts offers again.
 */
export function forgetPairing(configPath: string, dataDir: string): void {
  const existing = readJsonFile(configPath)
  writeJsonFile0600(
    configPath,
    Object.fromEntries(Object.entries(existing).filter(([key]) => !PAIRED_KEYS.includes(key))),
  )
  const https = agentHttpsPaths(dataDir)
  for (const file of [https.bundlePath, https.certPath, https.pendingKeyPath]) {
    fs.rmSync(file, { force: true })
  }
}

/** First 16 hex chars of the SHA-256 of the agent's mesh leaf, `null` while unpaired. */
export function pairedLeafFingerprint(configPath: string): string | null {
  const meshTls: unknown = readJsonFile(configPath)['meshTls']
  const certPem: unknown =
    meshTls !== null && typeof meshTls === 'object' ? Reflect.get(meshTls, 'certPem') : null
  if (typeof certPem !== 'string') return null
  try {
    return new X509Certificate(certPem).fingerprint256
      .replaceAll(':', '')
      .toLowerCase()
      .slice(0, 16)
  } catch {
    return null
  }
}
