/**
 * src/legacy/config.js
 *
 * Shim: re-exports the store-backed legacy config adapter under the old
 * `CONFIG` name so legacy modules can keep their access pattern
 * (`CONFIG.smoothing`, etc.) while reading live values from the observable
 * store.
 */

export { legacyConfig as CONFIG } from "../store/legacy-config";
