/**
 * A small markdown view for registry README and CHANGELOG text.
 *
 * It never parses HTML. Angle brackets stay text, so a `<script>` in the
 * file cannot run. Links are anchors only for http(s); anything else
 * (javascript:, data:, a relative path) is the label with no href.
 */
import type { JSX, ReactNode } from 'react'

const FENCE = /```[^\n]*\n([\s\S]*?)```/g

interface Block {
  readonly kind: 'code' | 'text'
  readonly body: string
}

function blocksOf(markdown: string): readonly Block[] {
  const blocks: Block[] = []
  let cursor = 0
  for (const match of markdown.matchAll(FENCE)) {
    const index = match.index ?? 0
    if (index > cursor) blocks.push({ kind: 'text', body: markdown.slice(cursor, index) })
    blocks.push({ kind: 'code', body: match[1] ?? '' })
    cursor = index + match[0].length
  }
  if (cursor < markdown.length) blocks.push({ kind: 'text', body: markdown.slice(cursor) })
  return blocks
}

function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (href.startsWith('https://') || href.startsWith('http://')) return href
  return null
}

function inlineOf(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > cursor) nodes.push(text.slice(cursor, at))
    const token = match[0]
    const key = `${keyPrefix}-${index}`
    index += 1
    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="font-mono text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      const linked = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      const label = linked?.[1] ?? token
      const href = linked ? safeHref(linked[2] ?? '') : null
      nodes.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline"
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      )
    }
    cursor = at + token.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function textBlocks(body: string, keyPrefix: string): ReactNode[] {
  const lines = body.split('\n')
  const nodes: ReactNode[] = []
  let paragraph: string[] = []
  let list: string[] = []
  let index = 0

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const text = paragraph.join(' ').trim()
    paragraph = []
    if (text.length === 0) return
    nodes.push(
      <p key={`${keyPrefix}-p-${index}`} className="mb-2 last:mb-0">
        {inlineOf(text, `${keyPrefix}-p-${index}`)}
      </p>,
    )
    index += 1
  }
  const flushList = (): void => {
    if (list.length === 0) return
    const items = list
    list = []
    nodes.push(
      <ul key={`${keyPrefix}-ul-${index}`} className="mb-2 list-disc pl-4 last:mb-0">
        {items.map((item, itemIndex) => (
          <li key={`${keyPrefix}-li-${index}-${itemIndex}`}>
            {inlineOf(item, `${keyPrefix}-li-${index}-${itemIndex}`)}
          </li>
        ))}
      </ul>,
    )
    index += 1
  }

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const item = /^\s*[-*]\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1]?.length ?? 1
      const content = inlineOf(heading[2] ?? '', `${keyPrefix}-h-${index}`)
      const className =
        level === 1 ? 'text-sm font-semibold mb-2' : 'text-xs font-semibold mb-1.5 mt-2'
      nodes.push(
        level === 1 ? (
          <h3 key={`${keyPrefix}-h-${index}`} className={className}>
            {content}
          </h3>
        ) : (
          <h4 key={`${keyPrefix}-h-${index}`} className={className}>
            {content}
          </h4>
        ),
      )
      index += 1
      continue
    }
    if (item) {
      flushParagraph()
      list = [...list, item[1] ?? '']
      continue
    }
    if (line.trim().length === 0) {
      flushParagraph()
      flushList()
      continue
    }
    flushList()
    paragraph = [...paragraph, line.trim()]
  }
  flushParagraph()
  flushList()
  return nodes
}

export function AddonMarkdown({ markdown }: { readonly markdown: string }): JSX.Element {
  const blocks = blocksOf(markdown)
  return (
    <div className="text-xs text-foreground leading-relaxed">
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <pre
            key={`code-${index}`}
            className="mb-2 overflow-auto rounded-md bg-surface-hover p-2 font-mono text-[10px] last:mb-0"
          >
            {block.body.replace(/\n$/, '')}
          </pre>
        ) : (
          <div key={`text-${index}`}>{textBlocks(block.body, `b${index}`)}</div>
        ),
      )}
    </div>
  )
}
