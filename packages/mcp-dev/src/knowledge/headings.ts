/** Heading split shared by the search index and `read_section`. */

export interface HeadingChunk {
  readonly heading: string
  readonly body: string
}

export function splitByHeading(text: string): HeadingChunk[] {
  const lines = text.split('\n')
  const chunks: HeadingChunk[] = []
  let heading = ''
  let buf: string[] = []
  const flush = (): void => {
    if (buf.length === 0 && !heading) return
    chunks.push({ heading, body: buf.join('\n') })
    buf = []
  }
  for (const line of lines) {
    const h = /^#{1,3}\s+(.+)$/.exec(line)
    if (h) {
      flush()
      heading = h[1]!.trim()
    } else {
      buf.push(line)
    }
  }
  flush()
  return chunks.length > 0 ? chunks : [{ heading: '', body: text }]
}

export function headingSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
