import { describe, expect, it } from 'vitest'
import { EMAIL_IMAGE_SLOT, buildRawMime, type EmailMimeImage } from '../email-mime.js'

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])

function image(placement: EmailMimeImage['placement']): EmailMimeImage {
  return {
    bytes: JPEG,
    mime: 'image/jpeg',
    name: 'still.jpg',
    contentId: 'camstack-image-1',
    placement,
  }
}

function htmlPart(raw: string): string {
  const at = raw.indexOf('Content-Type: text/html')
  return at < 0 ? '' : raw.slice(at)
}

describe('email MIME images', () => {
  it('shows an HTML image inline, under the body and above the click link', () => {
    const html = `<h2>Title</h2><div>Hello</div>${EMAIL_IMAGE_SLOT}<p><a href="https://click.example/go">https://click.example/go</a></p>`
    const raw = buildRawMime({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hi',
      text: 'Hello',
      html,
      images: [image('inline')],
    })
    expect(raw).toContain('multipart/related')
    const htmlBody = htmlPart(raw)
    const cidAt = htmlBody.indexOf('src="cid:camstack-image-1"')
    const linkAt = htmlBody.indexOf('https://click.example/go')
    const bodyAt = htmlBody.indexOf('Hello')
    expect(cidAt).toBeGreaterThan(bodyAt)
    expect(linkAt).toBeGreaterThan(cidAt)
    expect(raw).toContain('Content-ID: <camstack-image-1>')
    expect(raw).toContain('Content-Disposition: inline')
  })

  it('attaches the image on a text mail', () => {
    const raw = buildRawMime({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hi',
      text: 'Hello',
      images: [image('attachment')],
    })
    expect(raw).toContain('multipart/mixed')
    expect(raw).toContain('Content-Disposition: attachment; filename="still.jpg"')
    expect(raw).not.toContain('multipart/related')
    expect(raw).not.toContain('cid:camstack-image-1')
  })
})
