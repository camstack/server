/**
 * The title of a node row. A node's id is its identity (`hub`, an agent's
 * name); the HUB also has a human name (D861), which leads, with the id kept as
 * the secondary label so the row still says which node it is.
 */
import { useServerName } from '../../hooks/use-server-name'

export interface NodeTitleProps {
  readonly node: { readonly id: string; readonly name: string; readonly isHub: boolean }
}

export function NodeTitle({ node }: NodeTitleProps) {
  const { info } = useServerName()
  if (!node.isHub || info === null) {
    return <span className="text-sm font-semibold shrink-0">{node.name}</span>
  }
  return (
    <>
      <span className="text-sm font-semibold shrink-0" data-testid="node-title-name">
        {info.name}
      </span>
      {info.name !== node.id && (
        <span className="text-xs text-foreground-subtle shrink-0" data-testid="node-title-id">
          {node.id}
        </span>
      )}
    </>
  )
}
