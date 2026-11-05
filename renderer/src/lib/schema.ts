// The sidecar's schema models by name, for the window (api.ts
// re-exports it) and the main process (electron/renderLoop.ts), which
// cannot import api.ts: types only, no DOM.

import type { components } from './api.gen'

/** A model the sidecar's schema names, by its Python class name. */
export type Schema<Name extends keyof components['schemas']> = components['schemas'][Name]
