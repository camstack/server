import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddonHttpReply } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ALEXA_SPEAK_ICON_URL } from '../speak/constants.js'
import { ALEXA_ICON_SVG, speakIconRoutes } from '../speak/icon-routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))

interface Captured {
  contentType: string
  headers: Record<string, string>
  body: unknown
}

function capturingReply(): { reply: AddonHttpReply; captured: Captured } {
  const captured: Captured = { contentType: '', headers: {}, body: null }
  const reply: AddonHttpReply = {
    status() {
      return reply
    },
    code() {
      return reply
    },
    type(mime) {
      captured.contentType = mime
      return reply
    },
    header(name, value) {
      captured.headers[name.toLowerCase()] = value
      return reply
    },
    send(data) {
      captured.body = data
    },
    redirect() {},
  }
  return { reply, captured }
}

describe('the Alexa brand icon', () => {
  it('is the vendored simple-icons mark, byte for byte', () => {
    const vendored = fs.readFileSync(path.join(here, '../../assets/alexa-echo.svg'), 'utf8')
    expect(ALEXA_ICON_SVG).toBe(vendored)
    expect(vendored).toContain('<title>Amazon Alexa</title>')
  })

  it('ships its licence note beside it', () => {
    const note = fs.readFileSync(path.join(here, '../../assets/alexa-echo.LICENSE.md'), 'utf8')
    expect(note).toContain('CC0')
    expect(note).toContain('simple-icons')
  })

  it('is served at the url the kind advertises, as an SVG a bare <img> can load', async () => {
    const [route] = speakIconRoutes()
    expect(`/addon/import-alexa${route?.path}`).toBe(ALEXA_SPEAK_ICON_URL)
    expect(route?.method).toBe('GET')
    expect(route?.access).toBe('public')
    const { reply, captured } = capturingReply()
    await route?.handler({ params: {}, query: {}, body: undefined, headers: {} }, reply)
    expect(captured.contentType).toBe('image/svg+xml')
    expect(String(captured.body)).toContain('<svg')
    expect(captured.headers['content-encoding']).toBeUndefined()
  })

  it('stays under the 1 KiB the hub compressor mishandles on a bridged route', () => {
    expect(Buffer.byteLength(ALEXA_ICON_SVG)).toBeLessThan(1024)
  })
})
