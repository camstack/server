/// <reference types="@testing-library/jest-dom" />

import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

expect.extend(jestDomMatchers)

const browseQuery = vi.fn()
const listAllowedRootsQuery = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    Button: actual.Button,
    Input: actual.Input,
    Select: actual.Select,
    FileInput: actual.FileInput,
    Textarea: actual.Textarea,
    Checkbox: actual.Checkbox,
    Slider: actual.Slider,
    Radio: actual.Radio,
    useSystem: () => ({
      trpcClient: {
        filesystemBrowse: {
          browse: { query: browseQuery },
          listAllowedRoots: { query: listAllowedRootsQuery },
          createDir: { mutate: vi.fn() },
        },
      },
    }),
  }
})

import { PathBrowser } from '../PathBrowser'

const ROOT_LISTING = {
  path: '/',
  entries: [
    { name: 'proc', path: '/proc' },
    { name: 'recordings-high', path: '/recordings-high' },
    { name: 'mnt', path: '/mnt' },
    { name: 'recordings', path: '/recordings' },
  ],
  freeBytes: 220_000_000_000,
  totalBytes: 506_000_000_000,
}

describe('PathBrowser chips', () => {
  beforeEach(() => {
    browseQuery.mockReset()
    listAllowedRootsQuery.mockReset()
  })

  it('suggests the real directories that exist at / on the selected node', async () => {
    browseQuery.mockImplementation(({ path }: { path: string }) =>
      path === '/' ? Promise.resolve(ROOT_LISTING) : Promise.reject(new Error('unexpected')),
    )
    listAllowedRootsQuery.mockResolvedValue(['/mnt'])

    render(<PathBrowser nodeId="hub" value="" onChange={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '/recordings' })).toBeVisible())
    expect(screen.getByRole('button', { name: '/recordings-high' })).toBeVisible()
    expect(screen.getByRole('button', { name: '/mnt' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '/proc' })).toBeNull()
  })

  it('never overwrites the stored path just by opening the browser', async () => {
    browseQuery.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(path === '/' ? ROOT_LISTING : { ...ROOT_LISTING, path, entries: [] }),
    )
    listAllowedRootsQuery.mockResolvedValue(['/mnt'])
    const onChange = vi.fn()

    render(<PathBrowser nodeId="hub" value="/recordings-high/cam1" onChange={onChange} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '/recordings' })).toBeVisible())
    expect(onChange).not.toHaveBeenCalled()
  })

  // A node still running a framework that confines browsing to the write roots
  // answers `/` with a refusal. The picker must keep working exactly as it did.
  it('falls back to the allowed roots when the node refuses to list /', async () => {
    browseQuery.mockImplementation(({ path }: { path: string }) =>
      path === '/'
        ? Promise.reject(new Error('path "/" is not within an allowed root'))
        : Promise.resolve({ ...ROOT_LISTING, path, entries: [] }),
    )
    listAllowedRootsQuery.mockResolvedValue(['/mnt', '/Volumes', '/media', '/home/camstack'])

    render(<PathBrowser nodeId="hub" value="" onChange={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('button', { name: '/mnt' })).toBeVisible())
    expect(screen.getByRole('button', { name: '/Volumes' })).toBeVisible()
    expect(screen.getByRole('button', { name: '/home/camstack' })).toBeVisible()
  })

  it('degrades to manual entry when the node hosts no browse provider', async () => {
    browseQuery.mockRejectedValue(new Error('Capability "filesystem-browse" not available on node'))
    listAllowedRootsQuery.mockRejectedValue(
      new Error('Capability "filesystem-browse" not available on node'),
    )

    render(<PathBrowser nodeId="macmini" value="" onChange={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/can't be browsed remotely/i)).toBeVisible())
    expect(screen.getByPlaceholderText('/absolute/path')).toBeVisible()
  })
})
