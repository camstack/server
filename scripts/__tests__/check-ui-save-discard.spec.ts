import { describe, expect, it } from 'vitest'
import { findHits, judge, type SourceFile } from '../check-ui-save-discard.js'

const F = 'packages/addon-admin-ui/src/pages/X.tsx'
const file = (text: string, path = F): SourceFile => ({ path, text })

describe('check-ui-save-discard (planning#675)', () => {
  it('flags a mutation fired inline from onBlur / onCheckedChange', () => {
    const hits = findHits([
      file(`export function Row() {
  const save = useMutation()
  return <><input onBlur={(e) => save.mutate({ v: e.target.value })} />
  <Switch onCheckedChange={(v) => doIt.mutateAsync(v)} /></>
}`),
    ])
    expect(hits.map((h) => h.anchor)).toEqual([
      'Row/onBlur/inline#1',
      'Row/onCheckedChange/inline#1',
    ])
  })

  it('flags a named handler, and one that reaches a mutation through another same-file function', () => {
    const hits = findHits([
      file(`export function Row() {
  const m = useThingMutation()
  const commit = () => m.mutate({})
  const handleChange = () => { commit() }
  return <input onChange={handleChange} />
}`),
    ])
    expect(hits.map((h) => h.anchor)).toEqual(['Row/onChange/handleChange#1'])
  })

  it('does not flag onClick, a draft setter, or a local callback parameter named mutate', () => {
    expect(
      findHits([
        file(`export function Row() {
  const m = useMutation()
  return <><button onClick={() => m.mutate({})} />
  <input onChange={(e) => setDraft(e.target.value)} /></>
}
function replace(mutate: (p: string) => void): void { mutate('x') }
export function Tabs() { return <T onValueChange={(id) => replace((p) => p)} /> }`),
      ]),
    ).toEqual([])
  })

  it('ignores specs and non-tsx files', () => {
    const text = 'export const A = () => <input onBlur={() => m.mutate()} />'
    expect(
      findHits([
        file(text, 'packages/ui-library/src/a.spec.tsx'),
        file(text, 'packages/x/src/a.ts'),
      ]),
    ).toEqual([])
  })

  it('passes an allowlisted hit and fails a new one', () => {
    const hits = findHits([file('export const A = () => <input onBlur={() => m.mutate()} />')])
    expect(hits).toHaveLength(1)
    const entry = {
      file: F,
      anchor: hits[0]?.anchor ?? '',
      reason: 'known violation — planning#675 sweep',
    }
    expect(judge(hits, [entry])).toEqual({
      unlisted: [],
      stale: [],
      badReasons: [],
      missingMarker: [],
    })
    expect(judge(hits, []).unlisted).toHaveLength(1)
  })

  it('fails a stale allowlist entry and an unknown reason', () => {
    const entry = { file: F, anchor: 'Gone/onBlur/inline#1', reason: 'because' }
    const v = judge([], [entry])
    expect(v.stale).toEqual([entry])
    expect(v.badReasons).toEqual([entry])
  })

  it('flags a destructured or aliased mutate from any use*() hook', () => {
    const hits = findHits([
      file(`export function Row() {
  const { mutate: save } = useFoo()
  const { mutateAsync } = useBar()
  return <><input onBlur={() => save(1)} /><input onInput={() => mutateAsync(2)} /></>
}`),
    ])
    expect(hits.map((h) => h.anchor)).toEqual(['Row/onBlur/inline#1', 'Row/onInput/inline#1'])
  })

  it('flags the result of a save-shaped hook called from a handler, not useFormSaveController', () => {
    const hits = findHits([
      file(`export function Row() {
  const save = useQuickDetailSave()
  const tpl = useTemplateSave()
  const boot = useSaveBootstrapForm()
  const ctl = useFormSaveController()
  return <><a onChange={() => save(1)} /><b onChange={() => tpl(1)} />
  <c onChange={() => boot(1)} /><d onChange={() => ctl(1)} /></>
}`),
    ])
    expect(hits.map((h) => h.anchor)).toEqual([
      'Row/onChange/inline#1',
      'Row/onChange/inline#2',
      'Row/onChange/inline#3',
    ])
  })

  it('scopes parameter shadowing to the enclosing function, not the file', () => {
    const hits = findHits([
      file(`function replace(mutate: (p: string) => void): void { mutate('x') }
export function Row() {
  const { mutate } = useFoo()
  return <input onChange={() => mutate(1)} />
}`),
    ])
    expect(hits.map((h) => h.anchor)).toEqual(['Row/onChange/inline#1'])
  })

  it('requires a save-discard comment for live control / documented instant entries', () => {
    const bare = findHits([file('export const A = () => <input onBlur={() => m.mutate()} />')])
    const marked = findHits([
      file(`export const A = () => (
  // save-discard: switch turns the light on
  <input onBlur={() => m.mutate()} />
)`),
    ])
    for (const reason of ['live control', 'documented instant']) {
      const e = (hs: typeof bare) => ({ file: F, anchor: hs[0]?.anchor ?? '', reason })
      expect(judge(bare, [e(bare)]).missingMarker).toHaveLength(1)
      expect(judge(marked, [e(marked)]).missingMarker).toEqual([])
    }
    const known = { file: F, anchor: bare[0]?.anchor ?? '', reason: 'one-shot' }
    expect(judge(bare, [known]).missingMarker).toEqual([])
  })
})
