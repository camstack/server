/**
 * Record kinds owned by `system-config` (phase 6 / §2.8 mesh + agent HTTPS names).
 *
 * Mesh admission keeps a RAM mirror (D857); records hold the durable copy.
 * OPERATOR-ONLY legacy drop after verify.
 */
import { defineRecordKinds, type DefinedRecordKind } from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

export type MeshNodeCertificateBody = {
  readonly nodeId: string
  readonly serial: string
  readonly fingerprint: string
  readonly notBefore: number
  readonly notAfter: number
  readonly issuedAt: number
  readonly issuedVia: string
  readonly revokedAt?: number | null
  readonly revokedReason?: string | null
}
const _meshCertBody: z.ZodType<MeshNodeCertificateBody> = z.object({
  nodeId: z.string(),
  serial: z.string(),
  fingerprint: z.string(),
  notBefore: z.number(),
  notAfter: z.number(),
  issuedAt: z.number(),
  issuedVia: z.string(),
  revokedAt: z.number().nullish(),
  revokedReason: z.string().nullish(),
})
export const MeshNodeCertificateBodySchema: z.ZodType<MeshNodeCertificateBody> = _meshCertBody

export type AgentHttpsNameBody = {
  readonly names: readonly string[]
  readonly issuedAt: number
}
const _agentHttpsNameBody: z.ZodType<AgentHttpsNameBody> = z.object({
  names: z.array(z.string()).readonly(),
  issuedAt: z.number(),
})
export const AgentHttpsNameBodySchema: z.ZodType<AgentHttpsNameBody> = _agentHttpsNameBody

const _systemConfigRecordKinds = defineRecordKinds({
  'mesh-node-certificates': {
    schema: MeshNodeCertificateBodySchema,
    class: 'config',
    writeTrigger: 'mesh pairing, renewal, revocation (CRL mirror refreshed from rows)',
    device: 'none',
    at: 'none',
    indexes: [
      { name: 'node', fields: ['nodeId'] },
      { name: 'fingerprint', fields: ['fingerprint'] },
    ],
    retention: {
      owner: 'system-config',
      reason: 'daily reap removes revoked/expired rows older than 90 days',
    },
  },
  'agent-https-names': {
    schema: AgentHttpsNameBodySchema,
    class: 'config',
    writeTrigger: 'agent HTTPS certificate issuance records the CN/SAN set',
    device: 'none',
    at: 'none',
    retention: { none: 'one row per node id' },
  },
}) satisfies IsolatedRecordKinds

export type SystemConfigRecordKindsMap = {
  readonly 'mesh-node-certificates': DefinedRecordKind<z.ZodType<MeshNodeCertificateBody>>
  readonly 'agent-https-names': DefinedRecordKind<z.ZodType<AgentHttpsNameBody>>
}

export const systemConfigRecordKinds: SystemConfigRecordKindsMap = _systemConfigRecordKinds

export const meshNodeCertificatesRecordKind: DefinedRecordKind<z.ZodType<MeshNodeCertificateBody>> =
  _systemConfigRecordKinds['mesh-node-certificates']

export const agentHttpsNamesRecordKind: DefinedRecordKind<z.ZodType<AgentHttpsNameBody>> =
  _systemConfigRecordKinds['agent-https-names']
