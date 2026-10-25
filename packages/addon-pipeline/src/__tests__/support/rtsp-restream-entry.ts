/** Broker restream lookup row — both URLs are required on `RtspEntryLookup`. */
export function restreamEntry(url: string, mutedUrl?: string): { url: string; mutedUrl: string } {
  return { url, mutedUrl: mutedUrl ?? `${url}/muted` }
}
