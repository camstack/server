/**
 * A refusal sentence has to SURVIVE the header it travels in.
 *
 * Measured 2026-09-23 on 1436: a Hikvision replay refusal read
 * `SETUP of the video track answered 500 — the camera refused this replay`,
 * and the EM DASH threw `Invalid character in header content` inside the
 * response handler. The client got a socket hang up — no status, no reason —
 * so every clip the operator opened did nothing at all, and the log line that
 * would have explained it was the very thing that broke.
 *
 * The first test here is not a unit test on purpose: it drives a real
 * `http.ServerResponse`, because the bug was Node's rule and not ours, and a
 * hand-written "is this Latin-1" assertion would have passed on the day the
 * bug shipped.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { get } from 'node:http'
import { describe, expect, it } from 'vitest'
import { CLIP_REASON_HEADER_MAX, clipReasonHeaderValue } from '../videoclips.cap.js'

/** The exact sentence the camera refusal carried. */
const REAL_REFUSAL =
  'SETUP of the video track answered 500 — the camera refused this replay, and nothing a retry changes'

async function statusFor(headerValue: string): Promise<number | string> {
  const server = createServer((_req, res) => {
    try {
      res.writeHead(502, { 'x-camstack-reason': headerValue })
      res.end()
    } catch (err) {
      // What production did: the handler dies mid-response and the socket
      // is left hanging.
      res.destroy()
      void err
    }
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<number | string>((resolve) => {
      get({ port, path: '/' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', (err: Error) => resolve(`client-error: ${err.message}`))
    })
  } finally {
    server.close()
  }
}

describe('a refusal reason survives the header it travels in', () => {
  it('reproduces the failure: the raw sentence hangs the socket', async () => {
    // This is the bug, pinned. If Node ever starts accepting it, this test
    // goes red and the helper can be reconsidered — it must not pass by
    // accident.
    expect(await statusFor(REAL_REFUSAL)).toMatch(/^client-error:/)
  })

  it('and the folded one answers 502, so the surface can show the reason', async () => {
    expect(await statusFor(clipReasonHeaderValue(REAL_REFUSAL))).toBe(502)
  })

  it('substitutes rather than strips — the sentence stays readable', () => {
    expect(clipReasonHeaderValue(REAL_REFUSAL)).toBe(
      'SETUP of the video track answered 500 - the camera refused this replay, and nothing a retry changes',
    )
  })

  it('folds the typography this repo actually writes', () => {
    expect(clipReasonHeaderValue('the camera’s own words')).toBe("the camera's own words")
    expect(clipReasonHeaderValue('waiting…')).toBe('waiting...')
    expect(clipReasonHeaderValue('an – en dash')).toBe('an - en dash')
    expect(clipReasonHeaderValue('a “quoted” word')).toBe('a "quoted" word')
    expect(clipReasonHeaderValue('non breaking')).toBe('non breaking')
  })

  it('keeps Latin-1 that a header CAN carry', () => {
    // Italian device names reach these sentences. Folding them to `?` would
    // make a legible reason unreadable for no gain.
    expect(clipReasonHeaderValue('perché la telecamera è giù')).toBe('perché la telecamera è giù')
  })

  it('replaces anything else non-Latin-1 with a VISIBLE mark', () => {
    // Silent removal is how a reason becomes a shorter, wronger sentence.
    expect(clipReasonHeaderValue('camera 中文 name')).toBe('camera ?? name')
  })

  it('never lets a newline split the response', async () => {
    const injected = 'refused\r\nx-evil: yes'
    expect(clipReasonHeaderValue(injected)).not.toMatch(/[\r\n]/)
    expect(await statusFor(clipReasonHeaderValue(injected))).toBe(502)
  })

  it('bounds the sentence, and the bound is the shared constant', () => {
    const long = 'x'.repeat(CLIP_REASON_HEADER_MAX + 200)
    expect(clipReasonHeaderValue(long)).toHaveLength(CLIP_REASON_HEADER_MAX)
  })
})
