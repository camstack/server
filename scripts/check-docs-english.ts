#!/usr/bin/env tsx
/**
 * Docs-language guard — documentation under docs/ is written in English.
 *
 * ## The failure this catches
 *
 * The planning notes, ledgers and several docs pages were written in Italian while the
 * repository was a private working copy. The repository is becoming public and the
 * operator's rule is that all documentation, comments and commit messages are English
 * (AGENTS.md, Working style). A translation pass is a one-off; nothing about how the next
 * ledger gets written changes, so this guard is what makes the pass stick.
 *
 * ## How it decides (a heuristic, not a language model)
 *
 * Each prose line of every `*.md` / `*.mdx` / `*.txt` file in the git index under `docs/`
 * is scored on common Italian function words (`STRONG`: not English
 * words at all; `WEAK`: short or shared with English, counted only as support). A line is
 * Italian when it has two strong hits, one strong plus two weak, an Italian-only accented
 * form plus one more hit, or a dense mix. Short lines are judged more strictly on
 * accented forms and headings/table rows.
 *
 * Never scored: fenced code blocks, inline code spans (also when wrapped over lines), link
 * targets, URLs, file paths, HTML comments that score clean, blockquote lines that carry an
 * English gloss, and paragraphs marked as product copy (see below).
 *
 * ## Verbatim quotes (the only way Italian may stay)
 *
 * A quoted Italian span immediately followed by a bracketed English gloss is allowed:
 *
 *     «Il campanello non suona» [The doorbell does not ring]
 *     "Il campanello non suona" [The doorbell does not ring]
 *
 * (also with curly double quotes). The span may wrap across lines of one paragraph, may be
 * wrapped in emphasis (`*"…"* [gloss]`, `_«…»_ [gloss]`), and may be followed by closing
 * punctuation or emphasis, a line break, and a short English attribution after a dash
 * (`"…" — the operator. [gloss]`) before the `[`. The gloss must be English prose of at least
 * two letters and not a link label: `[x]`, `[1]` and an Italian gloss do not count (`isEnglishGloss`).
 * A quote with no valid gloss is scored like any other text and fails.
 *
 * ## Headings and short quotes
 *
 * A Markdown heading is prose: a short heading is judged on Italian-only words and a leading
 * article (`## Il problema`), not only on the density score that suits a sentence. A short quote
 * of two to four words that is made of Italian-only words (`"non funziona più"`) is a finding
 * without a gloss, even though the line around it is English.
 *
 * A blockquote (`>`) is exempt only when English, or when its Italian line is glossed: an inline
 * `[English]` on the line, a `> [English]` line or paragraph later in the same blockquote (blank `>` lines may sit
 * between; one gloss paragraph covers the whole quote block before it). Quotes
 * inside a blockquote are masked with the same rules. An unglossed Italian blockquote line is a
 * finding.
 *
 * ## Product copy (UI strings shown in both languages)
 *
 * Docs that list i18n copy side by side (`Name / Nome`, an `it` column, `it: "…"`) carry the HTML
 * comment `<!-- docs-english: product-copy -->` inside that paragraph (a table is one paragraph:
 * put it on the line above the table, no blank line between). The operator excluded product copy
 * from translation; the marker makes the exemption explicit, greppable and scoped to one paragraph.
 *
 * ## Allowlist
 *
 * `scripts/docs-english-allowlist.json` lists `{ file, text, why }`: `text` is the exact
 * trimmed line. For a string that cannot take a gloss (a product string, a verbatim log
 * line). An entry that matches nothing FAILS the guard: an exception nobody needs is a
 * hole. There is no per-file baseline: the guard is red until the tree is English.
 *
 * Run: npx tsx scripts/check-docs-english.ts [file...]   (no args = whole scope)
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST_FILE = path.join(ROOT, 'scripts', 'docs-english-allowlist.json')
const SCOPES: readonly string[] = ['docs']
const DOC_EXT: ReadonlySet<string> = new Set(['.md', '.mdx', '.txt'])

const wordSet = (src: string): ReadonlySet<string> => new Set(src.split(/\s+/).filter(Boolean))

const STRONG: ReadonlySet<string> = wordSet(
  `che della delle degli dello dei nella nelle nello negli nei sono questo questa questi queste quello quella
   viene vengono perché perche quando anche già gia dopo prima solo ancora ogni fatto deve devono può possono
   essere stato stata stati state era erano sia siano ma però pero quindi invece mentre dove cosa cose tutto tutti
   tutte tutta senza sempre molto più piu meno poi allora oppure oltre stesso stessa stessi stesse altro altra
   altri altre nostro nostra loro suo sua suoi sue dal dalla dalle dagli dai sul sulla sulle sugli sui fra tra
   lo gli il del al alla alle agli allo dallo uno una un' dell' nell' all' sull' dall' c'è cioè cioe ossia
   quindi infatti ovvero perciò percio dunque comunque affinché affinche nessun nessuna nessuno ciò cio
   fare fatta fatti fatte fanno faccio ha hanno ho abbiamo avere aveva avevano avrebbe sarebbe saranno sarà
   verrà viene venuto vedi vedere usare usato usata usati usa usano serve servono basta bastano
   quanto quanta quanti quante come cui quale quali chi vale valgono mai già giorno giorni volta volte
   perchè nuovo nuova nuovi nuove vecchio vecchia ora adesso prima poiché poiche siccome sebbene benché benche
   tuttavia inoltre ad ed eppure`,
)
/** Words that are also English (or very short): they count only as support. */
const AMBIGUOUS: ReadonlySet<string> = wordSet(
  `come ora fra tra ha ho mai chi cui usa basta vale era sia ma lo il al ad ed dei dal sul sui uno un poi state
   stato fare cose cosa dove loro altro prima volta solo meno sono tutto ogni nuovo fatto stesso serve vedi
   vedere quale quanto sempre molto sua suo nostro sebbene`,
)
const WEAK: ReadonlySet<string> = wordSet(
  `per con non in di da su a e o si ne ci mi ti vi la le li un lo il i è`,
)
/** Plain English words that a short line must not be judged Italian on. */
const ENGLISH_GUARD: ReadonlySet<string> = wordSet(
  `a i in on no me do to or an is as at it be by so us we he my of if up go now all one the and for are was not
   but can will with`,
)
/** Italian-only accented and elided forms. */
const ACCENT_ONLY =
  /(?:perché|già\b|più\b|può\b|così\b|è\b|né\b|cioè|ciò\b|però\b|sarà\b|verrà\b|città\b|attività\b|qualità\b|funzionalità\b|\b(?:nell|dell|all|sull|dall|quest|dov)['’](?!s\b)\w)/i
const ELIDED = /^(?:dell|nell|all|sull|dall|quest|dov|com|un|l|c)['’](?!s$)/

/** True when one line of prose reads as Italian. Pure; the unit the whole guard is built on. */
export function scoreLine(raw: string): boolean {
  const text = raw
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z0-9_./-]*[/.][A-Za-z0-9_./-]*\.(?:ts|tsx|md|json|js|yml|yaml)\b/g, ' ')
  const words = text.toLowerCase().match(/[a-zàèéìòù]+(?:['’][a-zàèéìòù]+)?/g) ?? []
  if (words.length === 0) return false
  let strong = 0
  let weak = 0
  let english = 0
  for (const w0 of words) {
    const w = w0.replace(/['’]$/, '')
    if (ELIDED.test(w0) || (STRONG.has(w) && !AMBIGUOUS.has(w))) strong++
    else if (AMBIGUOUS.has(w) || WEAK.has(w)) weak++
    if (ENGLISH_GUARD.has(w)) english++
  }
  const accent = ACCENT_ONLY.test(text)
  const hits = strong + weak
  if (words.length < 4)
    return (
      accent ||
      strong >= 2 ||
      (strong >= 1 &&
        /^\s*#{1,6}\s|^\s*\|/.test(raw) &&
        words.length >= 2 &&
        !words.every((w) => ENGLISH_GUARD.has(w)) &&
        hits === words.length)
    )
  if (strong >= 2) return true
  if (strong >= 1 && weak >= 2) return true
  if (accent && hits >= 2) return true
  return strong >= 1 && hits >= 4 && hits / words.length >= 0.3 && english < hits
}

export interface AllowlistEntry {
  readonly file: string
  readonly text: string
  readonly why: string
}
export interface ItalianLine {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * A quoted span followed by a non-empty bracketed gloss. Only the quoted span is masked.
 * The quote may wrap over lines and may be wrapped in emphasis (`*"…"*`, `_«…»_`); trailing
 * emphasis and punctuation between the closing quote and the `[` are allowed, and so is one
 * line break (inside a blockquote also a blank `>` line, see `GLOSSED_QUOTE_BQ`).
 */
const QUOTE_BODY = '(?:«[^»]{1,1500}?»|“[^”]{1,1500}?”|"[^"]{1,1500}?")'
const ATTRIBUTION = '(?:[—–-][ \\t]*[^\\[\\]\\n"«»“”]{1,40}?[ \\t]*)?'
const QUOTE_GLOSS_GAP = `[*_~]*[.,;:!?)]*[*_~]*[ \\t]*\\n?[ \\t]*${ATTRIBUTION}[.:]?[ \\t]*\\n?[ \\t]*`
const QUOTE_GLOSS_GAP_BQ = `[*_~]*[.,;:!?)]*[*_~]*(?:[ \\t]*\\n)*[ \\t]*${ATTRIBUTION}[.:]?(?:[ \\t]*\\n)*[ \\t]*`
/** Groups: 1 the quote, 2 the gap, 3 the text between the brackets of the gloss. */
const GLOSSED_QUOTE = new RegExp(`(${QUOTE_BODY})(${QUOTE_GLOSS_GAP})\\[([^\\]]*)\\](?!\\()`, 'g')
const GLOSSED_QUOTE_BQ = new RegExp(
  `(${QUOTE_BODY})(${QUOTE_GLOSS_GAP_BQ})\\[([^\\]]*)\\](?!\\()`,
  'g',
)

/**
 * Words that mark Italian and cannot be read as English: the strong function words that are not
 * also English, plus the articles and a few everyday words short quotes are made of.
 */
const IT_MARKERS: ReadonlySet<string> = new Set([
  ...[...STRONG].filter((w) => !AMBIGUOUS.has(w) && !ENGLISH_GUARD.has(w) && !w.endsWith("'")),
  ...wordSet(
    `il la le gli non del dei nel nei nella nelle bene male niente nulla sì tutto posto funziona
     funzionano suona suonano manca mancano rotto rotta perso persa vedo vedi vuoto vuota giusto
     sbagliato sbagliata errore telecamera telecamere campanello`,
  ),
])
const IT_HEADING_WORDS: ReadonlySet<string> = wordSet(
  `cosa cose causa regola regole decisione decisioni conseguenze conseguenza motivo motivi esempio
   esempi scelta scelte risultato risultati problema problemi soluzione soluzioni rischio rischi
   verifica verifiche misura misure perché`,
)
const ITALIAN_ARTICLE = /^(?:il|lo|la|le|gli|una|uno|del|della|dei|degli|nel|nella|sul|sulla)$/

function wordsOf(text: string): readonly string[] {
  // A hyphenated compound (`non-goals`, `per-camera`) is English whatever its parts look like.
  return (
    text
      .toLowerCase()
      .replace(/[\p{L}\d]+(?:-[\p{L}\d]+)+/gu, ' ')
      .match(/[a-zàèéìòù]+(?:['’][a-zàèéìòù]+)?/g) ?? []
  )
}

/** True when a bracketed gloss is English prose: two letters at least, and nothing Italian in it. */
export function isEnglishGloss(gloss: string): boolean {
  if (!/[A-Za-z]{2}/.test(gloss)) return false
  if (scoreLine(gloss) || ACCENT_ONLY.test(gloss)) return false
  return !wordsOf(gloss).some((w) => IT_MARKERS.has(w) || ELIDED.test(w))
}

/** Masks every quote that is followed by a valid English gloss; an invalid gloss masks nothing. */
function maskGlossedQuotes(text: string, pattern: RegExp): string {
  return text.replace(pattern, (m: string, quote: string, _gap: string, gloss: string) =>
    isEnglishGloss(gloss) ? blank(quote) + m.slice(quote.length) : m,
  )
}

/** A heading is judged as prose, but short: Italian-only words or a leading article decide. */
export function isItalianHeading(raw: string): boolean {
  const m = /^\s*#{1,6}\s+(.*)$/.exec(raw)
  if (m === null) return false
  const words = wordsOf((m[1] ?? '').replace(/`[^`]*`/g, ' '))
  if (words.length < 2) return false
  if (ACCENT_ONLY.test(m[1] ?? '')) return true
  const first = words[0] ?? ''
  if (ITALIAN_ARTICLE.test(first) && words.length >= 2 && !words.every((w) => ENGLISH_GUARD.has(w)))
    return true
  return words.some(
    (w) => IT_HEADING_WORDS.has(w) || (IT_MARKERS.has(w) && !ITALIAN_ARTICLE.test(w)),
  )
}

/**
 * A short quote (two to four words) of Italian-only words with no gloss: the line around it is
 * English, so the density score never sees it. Judged on the markers alone.
 */
export function hasShortItalianQuote(text: string): boolean {
  const quotes = text.match(/«[^»\n]{1,60}»|“[^”\n]{1,60}”|"[^"\n]{1,60}"/g) ?? []
  return quotes.some((q) => {
    const words = wordsOf(q.slice(1, -1))
    if (words.length < 2 || words.length > 4) return false
    const hits = words.filter(
      (w) => IT_MARKERS.has(w) || IT_HEADING_WORDS.has(w) || ACCENT_ONLY.test(w),
    ).length
    return hits >= 2 || (hits >= 1 && hits * 2 >= words.length)
  })
}

/** An inline code span, which may wrap over lines of one paragraph. */
const CODE_SPAN = /`[^`]+`/g

/**
 * Product copy: a paragraph (a table counts as one) carrying this HTML comment lists UI strings
 * in both languages side by side (`en: …` / `it: …`, an `it` column). The operator excluded
 * product copy from translation, so the paragraph is not judged. The marker is explicit and
 * per paragraph; it never covers the next one.
 */
const PRODUCT_COPY_MARKER = /<!--\s*docs-english:\s*product-copy\s*-->/

function blank(match: string): string {
  return match.replace(/[^\n]/g, ' ')
}

/** The text of a blockquote line without its `>` markers. */
function quoteBody(line: string): string {
  return line.replace(/^\s*(?:>\s?)+/, '').trim()
}

/** A non-empty `[..]` that is not a link label (not followed by `(`). */
const INLINE_GLOSS = /\[([^\]\n]*)\](?!\()/g

/** True when the text carries a bracketed gloss that is English prose. */
function hasInlineGloss(text: string): boolean {
  return [...text.matchAll(INLINE_GLOSS)].some((m) => isEnglishGloss(m[1] ?? ''))
}

function maskBlockquote(bodies: readonly string[]): readonly string[] {
  return maskGlossedQuotes(bodies.join('\n'), GLOSSED_QUOTE_BQ).split('\n')
}

/**
 * A blockquote line that is Italian prose with no English gloss: no inline `[..]` gloss, and no
 * gloss line (`> [...]`) later in the same blockquote (a quote block of several paragraphs, with
 * blank `>` lines between, is glossed by one `> [...]` paragraph after it). A gloss line is never judged.
 * `bodies` are the lines of one blockquote block without their `>` markers, blank ones empty.
 */
function isUnglossedItalianQuote(bodies: readonly string[], idx: number): boolean {
  const body = bodies[idx] ?? ''
  if (body === '') return false
  if (body.startsWith('[')) return !isEnglishGloss(glossText(body)) && scoreLine(body)
  const masked = maskBlockquote(bodies)[idx] ?? ''
  if (!scoreLine(masked) && !hasShortItalianQuote(masked)) return false
  if (hasInlineGloss(body)) return false
  // Any later line of the same blockquote that opens with an English `[` glosses the quote block.
  return !bodies.slice(idx + 1).some((b) => b.startsWith('[') && isEnglishGloss(glossText(b)))
}

/** The text of a gloss line `[…]` (the rest of the line when the bracket does not close). */
function glossText(line: string): string {
  return line.slice(1).split(']')[0] ?? ''
}

/** Italian prose lines of one markdown/text source. `file` is only echoed into the findings. */
export function findItalianLines(src: string, file: string): readonly ItalianLine[] {
  const lines = src.split('\n')
  const found: ItalianLine[] = []
  let fence = false
  let para: number[] = []
  const flush = (): void => {
    if (para.length === 0) return
    const paraText = para.map((n) => lines[n - 1] ?? '').join('\n')
    if (PRODUCT_COPY_MARKER.test(paraText)) {
      para = []
      return
    }
    const masked = maskGlossedQuotes(paraText.replace(CODE_SPAN, blank), GLOSSED_QUOTE)
    const maskedLines = masked.split('\n')
    para.forEach((n, i) => {
      const original = lines[n - 1] ?? ''
      if (/^\s*>/.test(original)) {
        if (
          isUnglossedItalianQuote(
            para.map((m) => quoteBody(lines[m - 1] ?? '')),
            i,
          )
        )
          found.push({ file, line: n, text: original.trim() })
        return
      }
      const text = maskedLines[i] ?? ''
      if (scoreLine(text) || isItalianHeading(text) || hasShortItalianQuote(text))
        found.push({ file, line: n, text: original.trim() })
    })
    para = []
  }
  lines.forEach((l, idx) => {
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence
      flush()
      return
    }
    if (fence) return
    if (l.trim() === '') {
      flush()
      return
    }
    para.push(idx + 1)
  })
  flush()
  return found
}

export function applyAllowlist(
  findings: readonly ItalianLine[],
  allowlist: readonly AllowlistEntry[],
): {
  readonly remaining: readonly ItalianLine[]
  readonly unused: readonly AllowlistEntry[]
} {
  const used = new Set<AllowlistEntry>()
  const remaining = findings.filter((f) => {
    const hit = allowlist.find((a) => a.file === f.file && a.text === f.text)
    if (hit) used.add(hit)
    return !hit
  })
  return { remaining, unused: allowlist.filter((a) => !used.has(a)) }
}

function isAllowlistEntry(v: unknown): v is AllowlistEntry {
  if (typeof v !== 'object' || v === null) return false
  const o: Record<string, unknown> = { ...v }
  return (
    typeof o['file'] === 'string' && typeof o['text'] === 'string' && typeof o['why'] === 'string'
  )
}

function loadAllowlist(): readonly AllowlistEntry[] {
  if (!fs.existsSync(ALLOWLIST_FILE)) return []
  const parsed: unknown = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'))
  if (!Array.isArray(parsed) || !parsed.every(isAllowlistEntry))
    throw new Error(`${ALLOWLIST_FILE}: expected an array of { file, text, why }`)
  return parsed
}

function scopeFiles(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...SCOPES], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\0')
    .filter((f) => f !== '' && DOC_EXT.has(path.extname(f).toLowerCase()))
}

function main(): void {
  const args = process.argv.slice(2)
  const explicit = args.length > 0
  const files = explicit ? args : scopeFiles()
  const findings = files.flatMap((f) => {
    const abs = path.resolve(explicit ? process.cwd() : ROOT, f)
    if (!fs.existsSync(abs)) return []
    return findItalianLines(fs.readFileSync(abs, 'utf8'), f)
  })
  const { remaining, unused } = applyAllowlist(findings, explicit ? [] : loadAllowlist())
  if (remaining.length > 0 || unused.length > 0) {
    const withFindings = new Set(remaining.map((f) => f.file)).size
    console.error(
      `\n✗ docs-english guard: ${remaining.length} Italian line(s) in ${withFindings} of ${files.length} scanned file(s).\n` +
        `  Documentation is written in English. A verbatim Italian quote stays only with a bracketed\n` +
        `  gloss right after it: «testo» [text]. Anything else: translate it.\n`,
    )
    for (const f of remaining) console.error(`  ${f.file}:${f.line}  ${f.text.slice(0, 120)}`)
    for (const u of unused)
      console.error(`  unused allowlist entry: ${u.file}  "${u.text.slice(0, 80)}"  (${u.why})`)
    process.exitCode = 1
    return
  }
  console.log(`✓ docs-english guard: ${files.length} file(s), no Italian prose.`)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main()
