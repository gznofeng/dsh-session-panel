/**
 * Pinned-workspace state: the pure data layer.
 *
 * Nothing here touches the filesystem or DSH. Every function is a plain
 * transform over a `State` value, so the pinning rules can be exercised
 * directly and the route layer stays a thin validation shell.
 *
 * ## State shape (v1)
 *
 * ```json
 * {
 *   "version": 1,
 *   "pinnedWorkspaces": ["D:\\ds_plugin", "D:\\work\\order-service"]
 * }
 * ```
 *
 * **Workspaces are keyed by their canonical path, not by title.** A title is
 * editable and two Workspaces may share one; a path is what the Host uses to
 * identify a Workspace, and it survives a rename. Pinning therefore follows the
 * folder, which is what a user means by "pin this project".
 *
 * ## Why a path may outlive its Workspace
 *
 * Removing a Workspace leaves its entry here rather than pruning it. The user
 * may re-add the same folder later, and silently dropping the pin would make
 * re-adding feel like a reset. The panel filters entries it cannot resolve at
 * read time and never writes that filtered view back.
 *
 * ## What this layer refuses to do
 *
 * - **It never accepts a non-string entry.** A malformed file is a bug, not a
 *   request to coerce values, so unknown shapes are dropped rather than fixed.
 * - **It never returns duplicates.** The list is the source of truth and is
 *   de-duplicated on read, so a hand-edited file cannot produce two pins.
 * - **It never mutates its input.** Every function returns a new state.
 */

/** Schema version written into every saved state. */
export const STATE_VERSION = 1

/** Upper bound on a stored path; generous, but not unbounded. */
export const MAX_PATH_LENGTH = 4096

/** Upper bound on pinned entries. A human cannot meaningfully pin more. */
export const MAX_PINNED = 500

/**
 * An empty state.
 *
 * @returns {{ version: number, pinnedWorkspaces: string[] }}
 */
export function emptyState() {
  return { version: STATE_VERSION, pinnedWorkspaces: [] }
}

/**
 * Normalize one candidate path.
 *
 * Only the trailing separator is trimmed: two Workspaces that differ inside the
 * path are genuinely different folders, and the Host treats canonical paths as
 * distinct. Windows and POSIX separators are both accepted because a profile
 * may hold Workspaces from either.
 *
 * @param {unknown} value
 * @returns {string | null} the normalized path, or null when unusable
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > MAX_PATH_LENGTH) return null
  // Trim trailing separators but keep a root such as "/" or "D:\".
  const stripped = trimmed.replace(/[/\\]+$/, '')
  const normalized = stripped === '' ? trimmed.slice(0, 1) : stripped
  return normalized === '' ? null : normalized
}

/**
 * Coerce arbitrary parsed JSON into a valid state.
 *
 * A wrong version, a missing array, or a non-string entry is dropped instead of
 * throwing: the file is machine-written, so an unreadable shape means damage,
 * and the durable copy is still worth keeping for inspection. The caller decides
 * whether to overwrite it — see `lifecycle.js`, which refuses while corrupt.
 *
 * @param {unknown} value
 * @returns {{ version: number, pinnedWorkspaces: string[] }}
 */
export function sanitizeState(value) {
  if (value === null || typeof value !== 'object') return emptyState()
  const raw = /** @type {any} */ (value)
  const list = Array.isArray(raw.pinnedWorkspaces) ? raw.pinnedWorkspaces : []
  /** @type {string[]} */
  const seen = []
  const kept = new Set()
  for (const entry of list) {
    const path = normalizePath(entry)
    if (path === null) continue
    if (kept.has(path)) continue
    kept.add(path)
    seen.push(path)
    if (seen.length >= MAX_PINNED) break
  }
  return { version: STATE_VERSION, pinnedWorkspaces: seen }
}

/**
 * Is this path pinned?
 *
 * @param {{ pinnedWorkspaces: readonly string[] }} state
 * @param {unknown} path
 * @returns {boolean}
 */
export function isPinned(state, path) {
  const normalized = normalizePath(path)
  if (normalized === null) return false
  return state.pinnedWorkspaces.includes(normalized)
}

/**
 * Return the next state with `path` pinned.
 *
 * Idempotent: pinning twice keeps one entry, so a double click or a retried
 * request cannot grow the file.
 *
 * @param {{ pinnedWorkspaces: readonly string[] }} state
 * @param {unknown} path
 * @returns {{ version: number, pinnedWorkspaces: string[] }}
 * @throws {TypeError} when the path is unusable
 */
export function pin(state, path) {
  const normalized = normalizePath(path)
  if (normalized === null) throw new TypeError('路径无效，无法置顶')
  if (state.pinnedWorkspaces.includes(normalized)) {
    return { version: STATE_VERSION, pinnedWorkspaces: [...state.pinnedWorkspaces] }
  }
  return { version: STATE_VERSION, pinnedWorkspaces: [...state.pinnedWorkspaces, normalized] }
}

/**
 * Return the next state without `path`.
 *
 * Idempotent: unpinning an absent path is a no-op rather than an error, so a
 * stale browser tab cannot leave the UI fighting a rejection.
 *
 * @param {{ pinnedWorkspaces: readonly string[] }} state
 * @param {unknown} path
 * @returns {{ version: number, pinnedWorkspaces: string[] }}
 * @throws {TypeError} when the path is unusable
 */
export function unpin(state, path) {
  const normalized = normalizePath(path)
  if (normalized === null) throw new TypeError('路径无效，无法取消置顶')
  return {
    version: STATE_VERSION,
    pinnedWorkspaces: state.pinnedWorkspaces.filter(entry => entry !== normalized),
  }
}
