/**
 * Pinned-workspace state lifecycle: the one place that owns the file on disk.
 *
 * Three jobs in one object so they cannot drift:
 *
 * - **`state()`** answers from an in-memory snapshot. Reads never touch disk.
 * - **`mutate(fn)`** computes the next state, persists it, and only then
 *   publishes it. A rejected write therefore leaves the process serving what was
 *   last durable, instead of a value the user believes was saved.
 * - **`reload()`** re-reads the file and replaces the snapshot. It is the only
 *   way a file that was unreadable at startup becomes healthy again without
 *   restarting the process.
 *
 * Two failure classes are deliberately kept apart:
 *
 * - A **missing** file is a normal first run: empty state, nothing to report.
 * - An **unparsable** file is flagged (`corrupt: true`) and never treated as
 *   empty. The bytes may still be recoverable by hand, so `mutate` refuses to
 *   write while that flag is set — overwriting them with the empty state this
 *   process is holding would destroy the only copy of the user's pins.
 *
 * A genuine I/O problem (permissions, the path is a directory) is rethrown: it
 * is neither "no pins" nor "corrupt", and pretending otherwise would let the
 * browser "fix" it with a save.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { emptyState, sanitizeState, STATE_VERSION } from './store.js'

/** True when the state file exists but cannot be parsed. */
export class CorruptStateError extends Error {
  /**
   * @param {string} file
   * @param {unknown} cause
   */
  constructor(file, cause) {
    super(`置顶配置无法解析：${file}`)
    this.name = 'CorruptStateError'
    this.file = file
    this.cause = cause
  }
}

/** The state file could not be written. */
export class SaveStateError extends Error {
  /**
   * @param {string} file
   * @param {unknown} cause
   */
  constructor(file, cause) {
    super(`写入置顶配置失败：${file}`)
    this.name = 'SaveStateError'
    this.file = file
    this.cause = cause
  }
}

/** True for a `node:fs` error meaning "the path is not there". */
function isMissing(error) {
  return error?.code === 'ENOENT'
}

/**
 * Read one file into a state.
 *
 * @param {string} file
 * @returns {Promise<{ version: number, pinnedWorkspaces: string[], corrupt: boolean, error?: Error }>}
 */
async function readStateFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    // A missing file is the first run, not a failure.
    if (isMissing(error)) return { ...emptyState(), corrupt: false }
    throw error
  }
  // An empty file is what a half-written truncate leaves behind; it carries no
  // data, so treating it as empty cannot lose anything a reader could use.
  if (text.trim() === '') return { ...emptyState(), corrupt: false }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // The bytes stay untouched on disk: `mutate` refuses while the flag is set.
    return { ...emptyState(), corrupt: true, error: new CorruptStateError(file, error) }
  }
  return { ...sanitizeState(parsed), corrupt: false }
}

/**
 * The on-disk envelope. One key so a hand-edit sees exactly what the code does.
 *
 * Entries are sorted so a diff of the file is stable — the pin *set* has no
 * order, and writing it in insertion order would produce noisy rewrites.
 *
 * @param {{ pinnedWorkspaces: string[] }} next
 * @returns {string}
 */
function serializeState(next) {
  const pinned = [...new Set(next.pinnedWorkspaces)].sort()
  return `${JSON.stringify({ version: STATE_VERSION, pinnedWorkspaces: pinned }, null, 2)}\n`
}

/**
 * Create the state lifecycle for one file.
 *
 * The read starts immediately and is exposed as `ready`. A failed read is
 * captured rather than thrown from the constructor so the plugin can still
 * activate and report the problem through its routes (a pin list is not worth an
 * unmountable plugin), while `state()` rethrows it so no read silently answers
 * empty.
 *
 * @param {{ file: string, logger?: { warn?: (...args: any[]) => void } }} options
 */
export function createStateLifecycle({ file, logger }) {
  /** @type {{ version: number, pinnedWorkspaces: string[], corrupt: boolean }} */
  let snapshot = { ...emptyState(), corrupt: false }

  /** Set when the initial read failed with a real I/O error. */
  let loadFailure = null

  /** Serializes writes: one commit at a time, so a burst cannot interleave. */
  let chain = Promise.resolve()

  /**
   * Write the snapshot to disk, atomically.
   *
   * Temp file plus rename: a crash mid-write leaves the previous file intact
   * instead of a truncated one, which matters precisely because a corrupt file
   * disables all writes.
   *
   * @param {{ version: number, pinnedWorkspaces: string[] }} next
   */
  async function persist(next) {
    const directory = path.dirname(file)
    await fs.mkdir(directory, { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    const body = serializeState(next)
    try {
      await fs.writeFile(temporary, body, 'utf8')
      await fs.rename(temporary, file)
    } catch (error) {
      // Best effort: a leftover temp file is harmless, a throw here is not.
      try {
        await fs.rm(temporary, { force: true })
      } catch {
        /* nothing useful to do */
      }
      throw new SaveStateError(file, error)
    }
  }

  /** @returns {Promise<void>} resolves once the first read has settled */
  const ready = (async () => {
    try {
      snapshot = await readStateFile(file)
    } catch (error) {
      loadFailure = error
      logger?.warn?.('会话面板：读取置顶配置失败', error)
    }
  })()

  return {
    file,
    ready,

    /**
     * The current snapshot.
     *
     * @returns {{ version: number, pinnedWorkspaces: string[], corrupt: boolean, error?: Error }}
     * @throws when the initial read hit a real I/O error
     */
    state() {
      if (loadFailure !== null) throw loadFailure
      return snapshot
    },

    /**
     * Apply `fn` to the current state and persist the result.
     *
     * The snapshot is published only after the write resolves, so a caller that
     * awaits this observes durable data. Concurrent calls are queued rather than
     * interleaved, so two pin clicks cannot lose one another.
     *
     * @param {(current: { version: number, pinnedWorkspaces: string[] }) => { version: number, pinnedWorkspaces: string[] }} fn
     * @returns {Promise<{ version: number, pinnedWorkspaces: string[] }>}
     * @throws {CorruptStateError} while the on-disk file cannot be parsed
     */
    mutate(fn) {
      const run = chain.then(async () => {
        // Re-check the guard per call: `reload()` may have cleared it.
        if (snapshot.corrupt) throw snapshot.error ?? new CorruptStateError(file, undefined)
        const next = fn({ ...snapshot, pinnedWorkspaces: [...snapshot.pinnedWorkspaces] })
        await persist(next)
        snapshot = { ...next, corrupt: false }
        return snapshot
      })
      // Keep the chain alive after a rejection so one failed write does not
      // wedge every later one.
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },

    /**
     * Re-read the file and replace the snapshot.
     *
     * @returns {Promise<void>}
     */
    async reload() {
      loadFailure = null
      snapshot = await readStateFile(file)
    },
  }
}
