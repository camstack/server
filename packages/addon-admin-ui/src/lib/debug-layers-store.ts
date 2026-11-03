/**
 * The browser-bound instance of the debug-layers flags (planning#362): the
 * session's `sessionStorage` and the page's query, read once, shared by the
 * overlay and the menu item. Logic and specs live in `debug-layers.ts`.
 */
import { useSyncExternalStore } from 'react'
import {
  createDebugLayersStore,
  type DebugLayersState,
  type DebugLayersStore,
  type FlagStorage,
} from './debug-layers'

let instance: DebugLayersStore | null = null

function sessionStorageOrNull(): FlagStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function debugLayersStore(): DebugLayersStore {
  if (instance === null) {
    instance = createDebugLayersStore(sessionStorageOrNull(), window.location.search)
  }
  return instance
}

export function useDebugLayers(): DebugLayersState & {
  readonly setOn: (on: boolean) => void
  readonly setNoBlur: (noBlur: boolean) => void
} {
  const store = debugLayersStore()
  const state = useSyncExternalStore(store.subscribe, store.getState)
  return { ...state, setOn: store.setOn, setNoBlur: store.setNoBlur }
}
