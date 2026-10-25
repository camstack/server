/**
 * A deliberately small XML reader for the Home Connect IDDF archive
 * (`*_DeviceDescription.xml`, `*_FeatureMapping.xml`). It builds an element
 * tree — name, attributes, children, text — and nothing else: no namespaces,
 * no DTDs, no entity declarations. The IDDF nests `<program>` blocks that carry
 * `<option refUID>` rows, which a flat regex pass cannot attribute to their
 * program, so the tree is the minimum that keeps the structure.
 */
export interface XmlElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly XmlElement[]
  readonly text: string
}

interface MutableXmlElement {
  readonly name: string
  readonly attrs: Record<string, string>
  readonly children: MutableXmlElement[]
  text: string
}

const TOKEN_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function decodeEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR_RE)) {
    const key = m[1]
    const value = m[2] ?? m[3] ?? ''
    if (key !== undefined) attrs[key] = decodeEntities(value)
  }
  return attrs
}

/** Parse a document; `null` when it has no root element. Tolerates unbalanced tags (closes to the nearest match). */
export function parseXml(xml: string): XmlElement | null {
  const stack: MutableXmlElement[] = []
  let root: MutableXmlElement | null = null
  for (const m of xml.matchAll(TOKEN_RE)) {
    const cdata = m[1]
    const closeName = m[2]
    const openName = m[3]
    const text = m[6]
    if (openName !== undefined) {
      const el: MutableXmlElement = {
        name: openName,
        attrs: parseAttrs(m[4] ?? ''),
        children: [],
        text: '',
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(el)
      else if (root === null) root = el
      if (m[5] !== '/') stack.push(el)
      continue
    }
    if (closeName !== undefined) {
      const at = stack.map((e) => e.name).lastIndexOf(closeName)
      if (at >= 0) stack.length = at
      continue
    }
    const parent = stack[stack.length - 1]
    if (parent) {
      if (cdata !== undefined) parent.text += cdata
      else if (text !== undefined) parent.text += decodeEntities(text)
    }
  }
  return root
}

/** Depth-first walk over every descendant element (the root included). */
export function walkXml(
  root: XmlElement,
  visit: (el: XmlElement, ancestors: readonly XmlElement[]) => void,
): void {
  const go = (el: XmlElement, ancestors: readonly XmlElement[]): void => {
    visit(el, ancestors)
    const next = [...ancestors, el]
    for (const child of el.children) go(child, next)
  }
  go(root, [])
}
