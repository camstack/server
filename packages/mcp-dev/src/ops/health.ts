/**
 * `hub_health_digest` — the pipeline orchestrator's latest health digest
 * (planning#572): findings an operator can act on, built every five minutes
 * from state the orchestrator already holds in memory. One gated query; the
 * answer is summarised by severity and carries the findings verbatim.
 * Read-only on the cluster.
 */
import { toToolOutput } from '@camstack/develop'
import { z } from 'zod'
import type { OpsHub } from './hub.js'
import { parseWire } from './wire.js'

const GET_HEALTH_DIGEST = 'pipelineOrchestrator.getHealthDigest'

const FindingSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  subject: z.looseObject({ type: z.string() }),
  what: z.string(),
  evidence: z.record(z.string(), z.number().nullable()),
  action: z.string(),
})

const DigestSchema = z.looseObject({
  generatedAt: z.number(),
  tickMs: z.number(),
  camerasSeen: z.number().nullable(),
  findings: z.array(FindingSchema),
  nodes: z.array(z.looseObject({ nodeId: z.string() })),
  sources: z.array(z.looseObject({ source: z.string(), entries: z.number().nullable() })),
  notCovered: z.array(z.string()),
})

const AnswerSchema = z.object({
  latest: DigestSchema.nullable(),
  previous: z.array(DigestSchema),
})

export interface HealthDigestArgs {
  /** Digests to return, newest first (default 1, max 24). */
  readonly history?: number
}

function bySeverity(
  findings: readonly z.infer<typeof FindingSchema>[],
): Record<'critical' | 'warning' | 'info', number> {
  const counts = { critical: 0, warning: 0, info: 0 }
  for (const f of findings) counts[f.severity] += 1
  return counts
}

export async function healthDigest(hub: OpsHub, args: HealthDigestArgs): Promise<unknown> {
  const history = args.history ?? 1
  const raw = await hub.query(GET_HEALTH_DIGEST, { history })
  const answer = parseWire(AnswerSchema, raw, GET_HEALTH_DIGEST)
  if (answer.latest === null) {
    return toToolOutput({
      note: 'No digest yet: the orchestrator has not completed its first 5-minute tick since it started.',
    })
  }
  return toToolOutput({
    generatedAt: answer.latest.generatedAt,
    tickMs: answer.latest.tickMs,
    camerasSeen: answer.latest.camerasSeen,
    severity: bySeverity(answer.latest.findings),
    findings: answer.latest.findings,
    nodes: answer.latest.nodes,
    sources: answer.latest.sources,
    notCovered: answer.latest.notCovered,
    previous: answer.previous.map((d) => ({
      generatedAt: d.generatedAt,
      severity: bySeverity(d.findings),
      findingIds: d.findings.map((f) => f.id),
    })),
  })
}
