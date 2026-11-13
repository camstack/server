import { Readable } from 'node:stream'
import type { PeerBytesOpenResult } from '@camstack/types'
import { EMAIL_IMAGE_SLOT } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRawMime,
  createGmailSmtpProvider,
  selectGmailAccount,
  selectGmailSender,
  type GmailAccountView,
} from '../google-gmail-smtp.js'

describe('buildRawMime', () => {
  it('builds a plain-text message with CRLF headers', () => {
    const raw = buildRawMime({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hello',
      text: 'Body line',
    })
    expect(raw).toContain('From: me@example.com')
    expect(raw).toContain('To: you@example.com')
    expect(raw).toContain('Subject: Hello')
    expect(raw).toContain('Content-Type: text/plain')
    expect(raw).toContain('\r\n\r\nBody line')
  })

  it('builds multipart/alternative when html is set', () => {
    const raw = buildRawMime({
      from: 'me@example.com',
      to: ['a@example.com', 'b@example.com'],
      subject: 'Hi',
      text: 'plain',
      html: '<p>html</p>',
    })
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('text/html')
    expect(raw).toContain('<p>html</p>')
    expect(raw).toContain('To: a@example.com, b@example.com')
  })
})

describe('selectGmailAccount', () => {
  const a: GmailAccountView = {
    brokerId: 'google_001',
    accountEmail: 'a@example.com',
    fromAddress: '',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-a',
  }
  const b: GmailAccountView = {
    brokerId: 'google_002',
    accountEmail: 'b@example.com',
    fromAddress: 'alias-b@example.com',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-b',
  }

  it('matches From to accountEmail or fromAddress', () => {
    expect(selectGmailAccount([a, b], 'b@example.com')?.brokerId).toBe('google_002')
    expect(selectGmailAccount([a, b], 'Alias-B@example.com')?.brokerId).toBe('google_002')
  })

  it('falls back to the first connected when From is absent', () => {
    expect(selectGmailAccount([a, b], undefined)?.brokerId).toBe('google_001')
  })

  it('ignores disconnected accounts', () => {
    expect(selectGmailAccount([{ ...a, connected: false }, b], undefined)?.brokerId).toBe(
      'google_002',
    )
  })
})

describe('createGmailSmtpProvider', () => {
  function make(accounts: GmailAccountView[], httpFetch?: typeof globalThis.fetch) {
    return createGmailSmtpProvider({
      accounts: () => accounts,
      fetch: httpFetch,
    })
  }

  const accountA: GmailAccountView = {
    brokerId: 'google_001',
    accountEmail: 'a@example.com',
    fromAddress: 'a@example.com',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-a',
  }
  const accountB: GmailAccountView = {
    brokerId: 'google_002',
    accountEmail: 'b@example.com',
    fromAddress: 'b@example.com',
    fromName: '',
    connected: true,
    getAccessToken: async () => 'tok-b',
  }

  it('getStatus is not ready when disconnected', async () => {
    const smtp = make([{ ...accountA, connected: false }])
    const status = await smtp.getStatus({})
    expect(status.ready).toBe(false)
    expect(status.error).toMatch(/not connected|No Google broker/i)
  })

  it('sendEmail without from uses the first connected account token', async () => {
    const tokens: string[] = []
    const fetchMock: typeof fetch = async (url, init) => {
      if (String(url).includes('/messages/send')) {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
        tokens.push(auth)
        return {
          ok: true,
          json: async () => ({ id: 'msg-1' }),
        } as Response
      }
      return { ok: true, json: async () => ({}) } as Response
    }
    const smtp = make([accountA, accountB], fetchMock)
    await smtp.sendEmail({
      to: 'you@example.com',
      subject: 'Subj',
      text: 'Hello world',
    })
    expect(tokens[0]).toContain('tok-a')
  })

  it('sendEmail with from matching B uses B token', async () => {
    const tokens: string[] = []
    const fetchMock: typeof fetch = async (url, init) => {
      if (String(url).includes('/messages/send')) {
        const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
        tokens.push(auth)
        return {
          ok: true,
          json: async () => ({ id: 'msg-2' }),
        } as Response
      }
      return { ok: true, json: async () => ({}) } as Response
    }
    const getA = vi.fn(async () => 'tok-a')
    const getB = vi.fn(async () => 'tok-b')
    const smtp = make(
      [
        { ...accountA, getAccessToken: getA },
        { ...accountB, getAccessToken: getB },
      ],
      fetchMock,
    )
    await smtp.sendEmail({
      to: 'you@example.com',
      from: 'b@example.com',
      subject: 'Subj',
      text: 'Hello',
    })
    expect(getB).toHaveBeenCalled()
    expect(getA).not.toHaveBeenCalled()
    expect(tokens[0]).toContain('tok-b')
  })

  it('inlines an image in the raw MIME the Gmail API receives', async () => {
    const jpeg = Uint8Array.from([1, 2, 3, 4])
    let raw = ''
    const fetchMock: typeof fetch = async (_url, init) => {
      const parsed: unknown = JSON.parse(String(init?.body))
      const encoded =
        typeof parsed === 'object' &&
        parsed !== null &&
        'raw' in parsed &&
        typeof parsed.raw === 'string'
          ? parsed.raw
          : ''
      const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
      const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
      raw = Buffer.from(b64 + pad, 'base64').toString('utf8')
      return new Response(JSON.stringify({ id: 'msg-img' }), { status: 200 })
    }
    const opened: PeerBytesOpenResult = {
      kind: 'body',
      body: {
        status: 200,
        contentType: 'image/jpeg',
        declaredBytes: jpeg.byteLength,
        stream: Readable.from([jpeg]),
        writeToFile: async () => ({ kind: 'written', bytes: jpeg.byteLength }),
        cancel: () => undefined,
      },
    }
    const withImage = createGmailSmtpProvider({
      accounts: () => [accountA],
      fetch: fetchMock,
      peerBytes: { open: async () => opened },
    })
    await withImage.sendEmail({
      to: 'you@example.com',
      subject: 'Hi',
      text: 'Hello',
      html: `<h2>T</h2><div>Hello</div>${EMAIL_IMAGE_SLOT}<p><a href="https://click.example/go">go</a></p>`,
      images: [
        {
          ticket: {
            url: 'http://127.0.0.1:9/img',
            hostNodeId: 'hub',
            expiresAtMs: Date.now() + 30_000,
            declaredBytes: jpeg.byteLength,
          },
          mime: 'image/jpeg',
          name: 'still.jpg',
          contentId: 'camstack-image-1',
          placement: 'inline',
        },
      ],
    })
    expect(raw).toContain('multipart/related')
    const htmlAt = raw.indexOf('Content-Type: text/html')
    const html = raw.slice(htmlAt)
    expect(html.indexOf('src="cid:camstack-image-1"')).toBeGreaterThan(html.indexOf('Hello'))
    expect(html.indexOf('https://click.example/go')).toBeGreaterThan(
      html.indexOf('cid:camstack-image-1'),
    )
    expect(raw).toContain('Content-ID: <camstack-image-1>')
  })
})

describe('the account a sender link names', () => {
  const linked = (brokerId: string, connected: boolean): GmailAccountView => ({
    brokerId,
    accountEmail: `${brokerId}@example.com`,
    fromAddress: '',
    fromName: '',
    connected,
    getAccessToken: async () => `tok-${brokerId}`,
  })

  it('picks the account the instance id names, not the first connected one', () => {
    const picked = selectGmailSender([linked('google_001', true), linked('google_002', true)], {
      instanceId: 'google_002',
    })
    expect(picked.brokerId).toBe('google_002')
  })

  it('refuses when the named account is not connected, instead of sending from another', () => {
    expect(() =>
      selectGmailSender([linked('google_001', true), linked('google_002', false)], {
        instanceId: 'google_002',
      }),
    ).toThrow(/google_002/)
  })

  it('without an instance id keeps choosing by From', () => {
    const picked = selectGmailSender([linked('google_001', true), linked('google_002', true)], {
      from: 'google_002@example.com',
    })
    expect(picked.brokerId).toBe('google_002')
  })
})
