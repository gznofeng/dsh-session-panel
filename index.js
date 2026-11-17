/**
 * Session panel — host entry.
 *
 * Owns two things and delegates the rest:
 *
 * - the pin file lifecycle (`lib/lifecycle.js` owns the snapshot, the atomic
 *   write, the corruption guard and the write chain),
 * - the loopback routes (`lib/routes.js` owns validation, the loopback guard and
 *   the response envelopes).
 *
 * Design notes:
 *
 * - **`webServer` is optional.** The routes are the only browser-facing surface,
 *   so the plugin stays active in a profile without a web server and simply
 *   registers nothing there, rather than failing to activate.
 * - **The pin set is per-machine, not per-session.** Pins describe how the user
 *   organises their workspaces, so they outlive any conversation and must not
 *   live in a session log. It is one JSON file under the Harness home.
 * - **Only workspace pins live here.** Session pins are the Harness's own
 *   (`pinSession` / `pinnedSessionIds`), shared with the sidebar. Storing a
 *   second copy would give the panel two sources of truth that drift apart.
 * - **A failed startup read is surfaced, never papered over.** `lifecycle`
 *   captures a real I/O failure and rethrows it from `state()`, which the routes
 *   turn into a 500 with the reason. The plugin still activates: a pin list is
 *   cosmetic, and refusing to mount the whole plugin over it would be worse.
 * - **Teardown closes the routes and nothing else.** Every registration below is
 *   owned by `ctx.effect`, so unloading removes the routes and leaves no state
 *   behind for the next activation to trip over.
 */

import path from 'node:path'
import { homedir } from 'node:os'

import { createStateLifecycle } from './lib/lifecycle.js'
import { createRoutes } from './lib/routes.js'
import { pin, unpin } from './lib/store.js'

/** Directory for plugin-owned files under the Harness home. */
const PLUGIN_DATA_DIR = 'plugin-data'

/** File name inside {@link PLUGIN_DATA_DIR}. */
const STATE_FILE_NAME = 'dsh-session-panel.json'

/**
 * Absolute path of this plugin's state file.
 *
 * `$DSH_HOME` wins when set (the desktop build always sets it); otherwise the
 * documented default `~/.dsh` applies. Resolved per call rather than at module
 * scope so a swapped environment is not masked by the first value.
 *
 * @returns {string}
 */
function stateFilePath() {
  const configured = process.env.DSH_HOME
  const home =
    typeof configured === 'string' && configured.trim() !== ''
      ? configured
      : path.join(homedir(), '.dsh')
  return path.join(home, PLUGIN_DATA_DIR, STATE_FILE_NAME)
}

/**
 * @param {any} ctx the plugin context
 */
export function apply(ctx) {
  const lifecycle = createStateLifecycle({ file: stateFilePath(), logger: ctx.logger })

  // Nothing awaits `ready` here, and a rejection there would be an unhandled
  // rejection reported as a process warning. `lifecycle` already logs the
  // failure and keeps it for `state()` to rethrow, so this just silences the
  // promise itself.
  lifecycle.ready.catch(() => {})

  const deps = {
    state: () => lifecycle.state(),
    mutate: fn => lifecycle.mutate(fn),
    reload: () => lifecycle.reload(),
    pin,
    unpin,
  }

  // Routes exist only where a web server does. `ctx.inject` keeps the plugin
  // active when there is none.
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => {
      const disposers = createRoutes(deps).map(route => webCtx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'session-panel: loopback routes')
  })
}
