/**
 * The API explorer's grouped method list (planning#595): macro groups with
 * counts, an `other` bucket for an unlisted router, search across groups.
 */
import type { ApiCatalogMethod } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApiMethodTable } from '../ApiMethodTable'

function method(path: string, kind: ApiCatalogMethod['kind'] = 'query'): ApiCatalogMethod {
  const dot = path.lastIndexOf('.')
  return {
    path,
    router: path.slice(0, dot),
    method: path.slice(dot + 1),
    kind,
    tier: 'protected',
    source: 'core',
    scope: null,
    hasInput: false,
    description: null,
    callable: 'yes',
  }
}

const METHODS = [
  method('deviceManager.getDevice'),
  method('deviceManager.setDisabled', 'mutation'),
  method('ptz.moveTo', 'mutation'),
  method('brandNewRouter.status'),
]

describe('ApiMethodTable', () => {
  it('shows the cap-carried description under the method name, none for a method without', () => {
    const described: ApiCatalogMethod = {
      ...method('ptz.moveTo', 'mutation'),
      description: 'Move the camera to an absolute pan/tilt position.',
    }
    render(
      <ApiMethodTable
        methods={[described, method('deviceManager.getDevice')]}
        selectedPath="ptz.moveTo"
        onSelect={() => undefined}
      />,
    )
    expect(
      screen.getByText('Move the camera to an absolute pan/tilt position.'),
    ).toBeInTheDocument()
    expect(screen.queryAllByText(/absolute pan/)).toHaveLength(1)
  })

  it('shows every non-empty macro group with its count, other included', () => {
    render(<ApiMethodTable methods={METHODS} selectedPath={null} onSelect={() => undefined} />)
    expect(screen.getByText('Devices').parentElement).toHaveTextContent('2')
    expect(screen.getByText('Cameras & media')).toBeInTheDocument()
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(screen.queryByText('Pipeline & detection')).toBeNull()
  })

  it("opens only the selected method's group at first", () => {
    render(
      <ApiMethodTable methods={METHODS} selectedPath="ptz.moveTo" onSelect={() => undefined} />,
    )
    expect(screen.getByText('moveTo')).toBeInTheDocument()
    expect(screen.queryByText('getDevice')).toBeNull()
  })

  it('searches across groups and opens the groups that matched', () => {
    render(<ApiMethodTable methods={METHODS} selectedPath={null} onSelect={() => undefined} />)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'status' } })
    expect(screen.getByText('status')).toBeInTheDocument()
    expect(screen.queryByText('Devices')).toBeNull()
    expect(screen.getByText('Other').parentElement).toHaveTextContent('of')
  })
})
