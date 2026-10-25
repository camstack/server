import { clearKnownSecrets, registerKnownSecret } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { LogManager } from '../log-manager.js'
import { redactLogEntry, redactLogMeta, redactLogText } from '../log-redactor.js'

const CANARY = 'CANARY-a1b2c3d4e5f6'

describe('central log redactor — no secret in logs', () => {
  afterEach(() => clearKnownSecrets())

  it('scrubs a known value wherever it appears, naming which secret it was', () => {
    registerKnownSecret(CANARY, 'secret://cloudflare-tunnel/global/customTunnelToken')
    const line = redactLogText(`Command failed: cloudflared tunnel run --token ${CANARY}`)
    expect(line).not.toContain(CANARY)
    expect(line).toMatch(/‹secret:[0-9a-f]{8}›/)
  })

  it('masks URL credentials inside free text', () => {
    const line = redactLogText('dial rtsp://admin:hunter2@10.0.0.5/stream failed')
    expect(line).not.toContain('hunter2')
    expect(line).toContain('10.0.0.5')
  })

  it('masks an SSO bridge in a relative request path and in an absolute redirect', () => {
    expect(redactLogText('GET /api/auth/sso/finish?bridge=eyJhbGciOi.x.y&popup=1 302')).toBe(
      'GET /api/auth/sso/finish?bridge=***&popup=1 302',
    )
    const absolute = redactLogText(
      'Location: https://hub.example/api/auth/sso/finish?bridge=eyJ.a.b',
    )
    expect(absolute).not.toContain('eyJ.a.b')
  })

  it('leaves a path without credential params as it was', () => {
    expect(redactLogText('GET /api/devices?limit=5')).toBe('GET /api/devices?limit=5')
  })

  it('masks the value after a credential CLI flag', () => {
    expect(redactLogText('tailscale up --auth-key=tskey-abc123 --hostname x')).toBe(
      'tailscale up --auth-key=*** --hostname x',
    )
    expect(redactLogText('cloudflared --token eyJhIjoiYiJ9 run')).toBe(
      'cloudflared --token *** run',
    )
  })

  it('replaces credential-named meta values at any depth, leaves numbers and ids alone', () => {
    const meta = {
      deviceId: 101,
      connection: { host: 'h', password: 'p4ss', apiKey: 'k' },
      providers: [{ id: 'authentik', clientSecret: 'cs' }],
      maxTokens: 512,
    }
    expect(redactLogMeta(meta)).toEqual({
      deviceId: 101,
      connection: { host: 'h', password: '***', apiKey: '***' },
      providers: [{ id: 'authentik', clientSecret: '***' }],
      maxTokens: 512,
    })
  })

  it('a clean entry is returned as the same object — no allocation per line', () => {
    const entry = {
      timestamp: new Date(),
      level: 'info' as const,
      message: 'hello',
      meta: { a: 1 },
    }
    expect(redactLogEntry(entry)).toBe(entry)
  })

  it('no sink of the LogManager ever sees the canary — ring buffer, destinations, subscribers', () => {
    registerKnownSecret(CANARY, 'secret://export-alexa/global/ingressToken')
    const manager = new LogManager(100)
    const written: string[] = []
    manager.addDestination({
      initialize: async () => undefined,
      shutdown: async () => undefined,
      write: (e) => written.push(JSON.stringify(e)),
    })
    const seen: string[] = []
    manager.subscribe({}, (e) => seen.push(JSON.stringify(e)))
    const logger = manager.createLogger('spec')
    logger.error(`token rejected: ${CANARY}`, {
      meta: { header: `Bearer ${CANARY}`, ingressToken: CANARY },
    })
    const buffered = JSON.stringify(manager.query({}))
    for (const blob of [buffered, ...written, ...seen]) expect(blob).not.toContain(CANARY)
    expect(written).toHaveLength(1)
  })
})
