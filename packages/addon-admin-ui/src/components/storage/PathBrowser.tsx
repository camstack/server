/**
 * PathBrowser — navigates a node's filesystem (via the `filesystem-browse` cap)
 * and lets the operator drill in + create a folder, producing the chosen
 * absolute path. Used only for node-local storage providers in the location
 * create/edit flow.
 *
 * The quick-suggestion chips are the REAL directories at `/` on the selected
 * node (D115). They used to be the node's `listAllowedRoots`, which are OS
 * defaults: on the hub that meant offering an empty `/mnt` plus two paths that
 * do not exist, while the node's own recordings sat at `/recordings`. A node
 * still running a framework that confines browsing to those roots refuses `/`;
 * we then fall back to the old chips rather than showing none.
 */

import { useSystem } from '@camstack/ui-library'
import { useCallback, useEffect, useState } from 'react'
import { derivePathChips } from './path-chips'
import { useTranslation } from 'react-i18next'

interface DirEntry {
  readonly name: string
  readonly path: string
}
interface BrowseResult {
  readonly path: string
  readonly entries: readonly DirEntry[]
  readonly freeBytes: number
  readonly totalBytes: number
}

interface PathBrowserProps {
  readonly nodeId: string
  readonly value: string
  readonly onChange: (path: string) => void
}

export function PathBrowser({ nodeId, value, onChange }: PathBrowserProps) {
  const { t } = useTranslation()
  const trpcClient = useSystem().trpcClient
  const [chips, setChips] = useState<readonly string[]>([])
  const [current, setCurrent] = useState<string>(value)
  const [result, setResult] = useState<BrowseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState<string>('')

  // `browse` drives the directory listing. `select` controls whether the
  // browsed path is committed back to the parent form: user-initiated
  // navigation selects it, but the initial auto-browse on mount must NOT —
  // otherwise opening an edit modal silently overwrites the stored path with
  // whichever root we happened to land on (the "current path isn't shown" bug).
  const browse = useCallback(
    async (path: string, select: boolean) => {
      setError(null)
      try {
        const r = (await trpcClient.filesystemBrowse.browse.query({ nodeId, path })) as BrowseResult
        setResult(r)
        setCurrent(r.path)
        if (select) onChange(r.path)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'browse failed')
      }
    },
    [trpcClient, nodeId, onChange],
  )

  useEffect(() => {
    // Keep the stored value visible immediately, before any async browse.
    setCurrent(value)
    void (async () => {
      // What actually exists at `/` on this node is the honest suggestion set.
      const rootListing = await trpcClient.filesystemBrowse.browse
        .query({ nodeId, path: '/' })
        .then((r) => r as BrowseResult)
        .catch(() => null)
      if (rootListing) {
        setChips(derivePathChips(rootListing.entries))
        // Seed the listing from the stored path, else from `/` — but never
        // commit it (select=false), so the operator's saved path survives
        // just opening the browser.
        await browse(value.startsWith('/') ? value : '/', false)
        return
      }
      try {
        // Older framework on this node: browsing is still confined to the
        // write roots, so `/` was refused. Offer those roots, as before.
        const rs = (await trpcClient.filesystemBrowse.listAllowedRoots.query({
          nodeId,
        })) as readonly string[]
        setChips(rs)
        await browse(value && rs.some((r) => value.startsWith(r)) ? value : (rs[0] ?? ''), false)
      } catch (e) {
        // The target node may not run `filesystem-browse` (e.g. an agent
        // without the storage addon). Degrade to the manual path input below
        // instead of throwing an uncaught rejection.
        setChips([])
        setResult(null)
        setError(
          e instanceof Error && /not available on node/i.test(e.message)
            ? `This node can't be browsed remotely. Enter the path manually.`
            : e instanceof Error
              ? e.message
              : 'browse unavailable',
        )
      }
    })()
    // re-run when the target node changes
  }, [nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const createFolder = async (): Promise<void> => {
    if (!newName.trim() || !result) return
    setError(null)
    try {
      const path = `${result.path.replace(/\/+$/, '')}/${newName.trim()}`
      await trpcClient.filesystemBrowse.createDir.mutate({ nodeId, path })
      setNewName('')
      await browse(result.path, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed')
    }
  }

  const fmtGb = (b: number): string => `${(b / 1_000_000_000).toFixed(1)} GB` // i18n-ignore: SI unit symbol

  return (
    <div className="space-y-2 rounded border border-border p-2">
      <div className="flex flex-wrap gap-1">
        {chips.map((r) => (
          <button
            key={r}
            onClick={() => void browse(r, true)}
            className="rounded border border-border px-2 py-0.5 text-[10px] font-mono hover:border-primary/40"
          >
            {r}
          </button>
        ))}
      </div>
      {/* Manual path entry — always available, and the only way to set a path
          when the node can't be browsed remotely. Committed on change so the
          stored value stays in sync. */}
      <input
        value={current}
        onChange={(ev) => {
          setCurrent(ev.target.value)
          onChange(ev.target.value)
        }}
        placeholder="/absolute/path"
        className="w-full rounded border border-border bg-background px-2 py-1 text-[11px] font-mono"
      />
      {result && (
        <div className="text-[10px] text-foreground-subtle">
          {t('storage.pathBrowser.free', {
            free: fmtGb(result.freeBytes),
            total: fmtGb(result.totalBytes),
          })}
        </div>
      )}
      <div className="max-h-40 space-y-0.5 overflow-y-auto">
        {result?.entries.map((e) => (
          <button
            key={e.path}
            onClick={() => void browse(e.path, true)}
            className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-primary/5"
          >
            📁 {e.name}
          </button>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          value={newName}
          onChange={(ev) => setNewName(ev.target.value)}
          placeholder={t('storage.pathBrowser.newFolder', 'new folder')}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
        />
        <button
          onClick={() => void createFolder()}
          className="rounded border border-border px-2 py-1 text-xs hover:border-primary/40"
        >
          {t('storage.pathBrowser.create', 'Create')}
        </button>
      </div>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
    </div>
  )
}
