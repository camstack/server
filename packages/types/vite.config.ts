import { buildLibPreset } from '../../tools/build/vite-lib.preset.ts'

/**
 * Framework package — types. DTS still emitted by tsc separately
 * (build script chains `vite build && tsc -p tsconfig.json
 * --emitDeclarationOnly`) because tsup historically truncated the
 * massive AppRouter type. Same workaround applies under Vite —
 * vite-plugin-dts has the same TS compiler limits as tsup's DTS.
 */
export default buildLibPreset({
  entries: {
    index: 'src/index.ts',
    node: 'src/node.ts',
    // Lightweight addon-authoring/runner entry — avoids the full schema barrel
    // (~47MB heap per process). See src/addon.ts.
    addon: 'src/addon.ts',
    // Dependency-free enums (EventCategory, EventSourceType) — a runtime entry
    // small enough for CLIENT bundles (the RN/Expo viewer imports the bus
    // categories from here without dragging the schema barrel into Metro).
    enums: 'src/enums/index.ts',
    // Node palette ids + assignNodeColorId — small entry for store schemas and UI.
    'node-color': 'src/node-color.ts',
  },
  externals: 'framework',
})
