/// <reference types="vite/client" />

/**
 * Build id injected by Vite's `define` (see vite.config.ts). It matches the
 * `build` field of the served version.json and is used to detect a newer deploy.
 */
declare const __BUILD_ID__: string
