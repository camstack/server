/**
 * Which skill a request is for: the path, then the ingress header, then the legacy skill.
 * Legacy URLs must keep answering `export-alexa` exactly as before; a path never falls through.
 */
import { describe, expect, it } from 'vitest'
import type { AddonHttpReply, AddonHttpRequest } from '@camstack/types'
import { buildRoutes, type HttpRouteDeps } from '../http-server.js'
import { LEGACY_SKILL_ID, pickSkill, type RoutableSkill } from '../instance-routing.js'

const skill = (id: string, ingressToken: string, enabled = true): RoutableSkill => ({
  id,
  enabled,
  ingressToken,
})
const SKILLS = [skill('export-alexa', 'tok-legacy'), skill('alexa-skill-2', 'tok-two')]

describe('pickSkill', () => {
  it('the path names the skill, whatever the header says', () => {
    expect(
      pickSkill(SKILLS, {
        pathInstanceId: 'alexa-skill-2',
        ingressHeader: 'tok-legacy',
      })?.id,
    ).toBe('alexa-skill-2')
  })

  it('a path naming an unknown or disabled skill resolves to nothing, never to another skill', () => {
    expect(
      pickSkill(SKILLS, {
        pathInstanceId: 'nope',
        ingressHeader: 'tok-legacy',
      }),
    ).toBeNull()
    const off = [skill('export-alexa', 'a'), skill('alexa-skill-2', 'b', false)]
    expect(pickSkill(off, { pathInstanceId: 'alexa-skill-2', ingressHeader: 'b' })).toBeNull()
  })

  it('without a path, the ingress header finds the skill that owns the token', () => {
    expect(pickSkill(SKILLS, { pathInstanceId: undefined, ingressHeader: 'tok-two' })?.id).toBe(
      'alexa-skill-2',
    )
  })

  it('without a path or a matching header, the legacy URL answers export-alexa', () => {
    expect(pickSkill(SKILLS, { pathInstanceId: undefined, ingressHeader: undefined })?.id).toBe(
      LEGACY_SKILL_ID,
    )
    expect(pickSkill(SKILLS, { pathInstanceId: undefined, ingressHeader: 'wrong' })?.id).toBe(
      LEGACY_SKILL_ID,
    )
  })

  it('the legacy fallback never reaches a later skill, and not a disabled export-alexa', () => {
    const later = [skill('alexa-skill-2', 'tok-two')]
    expect(pickSkill(later, { pathInstanceId: undefined, ingressHeader: undefined })).toBeNull()
    const off = [skill('export-alexa', 'a', false), skill('alexa-skill-2', 'b')]
    expect(pickSkill(off, { pathInstanceId: undefined, ingressHeader: undefined })).toBeNull()
  })

  it('a skill with no token yet is never matched by an empty header', () => {
    const fresh = [skill('export-alexa', ''), skill('alexa-skill-2', '')]
    expect(pickSkill(fresh, { pathInstanceId: undefined, ingressHeader: '' })?.id).toBe(
      'export-alexa',
    )
  })
})

// ── The routes ───────────────────────────────────────────────────────

function deps(resolve: HttpRouteDeps['resolveSkill']): HttpRouteDeps {
  return {
    ctx: {} as never,
    logger: { warn() {}, info() {}, error() {}, debug() {} } as never,
    resolveSkill: resolve,
    publicEndpoint: async () => ({ ok: true, origin: 'https://hub.example' }),
    snapshotRoute: {} as never,
  }
}

async function call(
  d: HttpRouteDeps,
  path: string,
  params: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const route = buildRoutes(d).find((r) => r.path === path)
  const out = { status: 0, body: null as unknown }
  const reply = {
    code(status: number) {
      out.status = status
      return reply
    },
    send(b: unknown) {
      out.body = b
    },
  }
  await route?.handler(
    { params, query: {}, body, headers: {} } as unknown as AddonHttpRequest,
    reply as unknown as AddonHttpReply,
  )
  return out
}

describe('the routes', () => {
  it('mounts each Lambda route twice: with the skill in the path, and the legacy URL', () => {
    const paths = buildRoutes(deps(() => null)).map((r) => r.path)
    for (const base of ['/directive', '/oauth/broker-link', '/oauth/lwa-tokens']) {
      expect(paths).toContain(base)
      expect(paths).toContain(`${base}/:instanceId`)
    }
    expect(paths).toContain('/snapshot/:file')
    expect(paths).not.toContain('/snapshot/:file/:instanceId')
  })

  it('hands the path instance id to the resolver', async () => {
    const asked: Array<string | undefined> = []
    const d = deps((lookup) => {
      asked.push(lookup.pathInstanceId)
      return null
    })
    await call(d, '/directive/:instanceId', { instanceId: 'alexa-skill-2' }, {})
    await call(d, '/directive', {}, {})
    expect(asked).toEqual(['alexa-skill-2', undefined])
  })

  it('an unknown skill answers a directive with the Alexa error envelope, and a callback with 404', async () => {
    const d = deps(() => null)
    const directive = await call(
      d,
      '/directive/:instanceId',
      { instanceId: 'ghost' },
      { directive: { header: { namespace: 'Alexa.Discovery' }, payload: {} } },
    )
    expect(directive.status).toBe(200)
    expect(JSON.stringify(directive.body)).toContain('INVALID_AUTHORIZATION_CREDENTIAL')
    const callback = await call(d, '/oauth/broker-link/:instanceId', { instanceId: 'ghost' }, {})
    expect(callback.status).toBe(404)
  })
})
