export { ModelStudioAddon } from './model-studio.addon.js'
// Re-export the custom-action catalog so the hub can register them in its
// CustomActionRegistry without instantiating the addon (static zod schemas).
export { modelStudioActions as customActions } from './model-studio-actions.js'
