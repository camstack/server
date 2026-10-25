import { useUiText } from '../contexts/ui-text'
import { useCallback, useState, type JSX } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '../lib/cn'
import { ScrollArea, IconButton } from '../primitives'

export interface CodeBlockProps {
  children: string
  maxHeight?: number
  className?: string
}

export function CodeBlock({ children, maxHeight = 300, className }: CodeBlockProps): JSX.Element {
  const t = useUiText()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [children])

  return (
    <div className={cn('relative group', className)}>
      <ScrollArea style={{ maxHeight }}>
        <pre className="font-mono text-xs bg-surface p-3 rounded-md border border-border-subtle">
          <code>{children}</code>
        </pre>
      </ScrollArea>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton
          icon={copied ? Check : Copy}
          aria-label={t('uiLibrary.codeBlock.copy', 'Copy code')}
          variant="ghost"
          size="sm"
          onClick={handleCopy}
        />
      </div>
    </div>
  )
}
