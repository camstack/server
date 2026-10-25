/// <reference types="vite/client" />
import './index.css'
import {
  type AddonPageProps,
  mountAddonPage,
  PageShell,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@camstack/ui-library'
import { useState } from 'react'
import { useT } from './i18n/index.js'
import { NodeBenchmarkSection } from './node-benchmark/NodeBenchmarkSection'
import { AudioTab } from './tabs/AudioTab'
import { ImageTab } from './tabs/ImageTab'

/**
 * Three sections (D791, D792):
 *  - Node benchmark — what ONE node can carry, measured on the node itself
 *    by the orchestrator's benchmark mode; feeds Auto tune and the shares.
 *  - Image — one run of a step tree on one image, to inspect what it finds.
 *  - Audio — one classification of a reference sound.
 * The session replay and the per-page history are gone; the WebRTC probe
 * lives under Network. Image/Audio host their own NodePicker (Model Studio
 * toolbar pattern); Node benchmark keeps its picker inside the section.
 */
export default function BenchmarkPage({ trpc }: AddonPageProps) {
  const { t } = useT()
  const [section, setSection] = useState('node')
  const [inspectNodeId, setInspectNodeId] = useState('hub')

  return (
    <PageShell title={t('page.title')} subtitle={t('page.subtitle')}>
      <Tabs value={section} onValueChange={setSection}>
        <TabsList>
          <TabsTrigger value="node">{t('page.tabNode')}</TabsTrigger>
          <TabsTrigger value="image">{t('page.tabImage')}</TabsTrigger>
          <TabsTrigger value="audio">{t('page.tabAudio')}</TabsTrigger>
        </TabsList>
        <TabsContent value="node">
          <NodeBenchmarkSection trpc={trpc} />
        </TabsContent>
        <TabsContent value="image">
          <ImageTab trpc={trpc} nodeId={inspectNodeId} onNodeChange={setInspectNodeId} />
        </TabsContent>
        <TabsContent value="audio">
          <AudioTab trpc={trpc} nodeId={inspectNodeId} onNodeChange={setInspectNodeId} />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}

// ---------------------------------------------------------------------------
// Dev mode: auto-mount when loaded as entry point (not as imported module)
// ---------------------------------------------------------------------------
if (import.meta.env?.DEV && document.getElementById('root')) {
  mountAddonPage(BenchmarkPage, { title: 'Benchmark' })
}
