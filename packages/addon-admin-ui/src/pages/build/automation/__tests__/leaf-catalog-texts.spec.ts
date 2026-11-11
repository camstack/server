import { AUTOMATION_LEAF_KINDS, leafCatalogEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import en from '../../../../i18n/en.json'
import itLocale from '../../../../i18n/it.json'
import { EVENT_LEAF_KINDS, LEAF_KINDS, newLeaf, STATE_LEAF_KINDS } from '../recipe-parts'

type LocaleNode = string | { readonly [key: string]: LocaleNode }

function isBranch(node: LocaleNode | undefined): node is { readonly [key: string]: LocaleNode } {
  return typeof node === 'object' && node !== null
}

function textAt(root: LocaleNode, dotted: string): string | null {
  let node: LocaleNode | undefined = root
  for (const part of dotted.split('.')) {
    if (!isBranch(node)) return null
    node = node[part]
  }
  return typeof node === 'string' && node.trim().length > 0 ? node : null
}

describe('leaf catalogue texts', () => {
  it('names, describes and exemplifies every row kind in English and Italian', () => {
    const missing: string[] = []
    for (const kind of AUTOMATION_LEAF_KINDS) {
      for (const part of ['label', 'description', 'example']) {
        const key = `${leafCatalogEntry(kind).i18nKey}.${part}`
        if (textAt(en, key) === null) missing.push(`en:${key}`)
        if (textAt(itLocale, key) === null) missing.push(`it:${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('the editor lists the catalogue, and seeds a row of the kind asked for', () => {
    expect(LEAF_KINDS).toEqual(AUTOMATION_LEAF_KINDS)
    expect([...EVENT_LEAF_KINDS, ...STATE_LEAF_KINDS]).toEqual(AUTOMATION_LEAF_KINDS)
    for (const kind of LEAF_KINDS) expect(newLeaf(kind).kind).toBe(kind)
  })
})
