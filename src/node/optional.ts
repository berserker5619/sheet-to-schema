/**
 * optional.ts — `/node`'s optional peers, loaded by the shared loader under its own name.
 */
import { loadPeer } from '../shared/optional';

/**
 * Load an optional peer dependency, or fail with what to install and why.
 *
 * `load` is the import itself, written at the call site so a bundler can see it. Any other
 * failure, such as a broken install of the package, is rethrown as it is.
 */
export function loadOptional<T>(name: string, neededTo: string, load: () => Promise<T>): Promise<T> {
  return loadPeer('sheet-to-schema/node', name, neededTo, load);
}
