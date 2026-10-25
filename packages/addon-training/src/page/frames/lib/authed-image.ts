/**
 * Load an admin-gated data-plane image into a revocable object URL.
 *
 * The `retrain-frame` plane is Bearer-token gated and an `<img src>` cannot
 * carry an `Authorization` header, so the bytes come through `fetch` and are
 * handed to the element as a blob. Same mechanism as `authed-download.ts`
 * (and the admin UI's `useAuthedImage`), kept local because this page is a
 * separate bundle.
 *
 * This is what replaced `getRetrainFrameImage`: the browser fetches a JPEG it
 * can cache, instead of the hub shipping the frame as base64 inside an RPC
 * answer (D613).
 */
import { useEffect, useState } from 'react'

const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'

/** Fetch a blob with the admin bearer token attached; throws on non-2xx. */
export async function authedFetchBlob(url: string): Promise<Blob> {
  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  const headers: Record<string, string> = {}
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`image fetch failed: ${String(res.status)}`)
  return res.blob()
}

export interface AuthedImage {
  /** An object URL once loaded; `null` while loading or when `url` is absent. */
  readonly src: string | null
  readonly failed: boolean
}

export function useAuthedImage(url: string | undefined): AuthedImage {
  const [state, setState] = useState<AuthedImage>({ src: null, failed: false })
  useEffect(() => {
    setState({ src: null, failed: false })
    if (url === undefined) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const blob = await authedFetchBlob(url)
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ src: objectUrl, failed: false })
      } catch {
        if (!cancelled) setState({ src: null, failed: true })
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [url])
  return state
}
