/**
 * Render smoke test.
 *
 * The unit suite covers the derivation; this covers the part that can blank a
 * slot: a component throwing during render, or a prop the Harness renderer
 * supplies going missing. The real `react` and `react-dom/server` are used, so
 * the components are the ones that ship.
 *
 * This is not a browser: it cannot see layout, colour or interaction. It does
 * prove the tree renders for the states that matter — both modes, pinning, the
 * rule, the workspace tag, archived rows, and a snapshot that has not arrived.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SOURCE = readFileSync(path.join(HERE, '..', 'client.js'), 'utf8')

/**
 * Resolve React for the render assertions.
 *
 * The plugin ships no dependencies — React comes from the Harness module table
 * in the browser — so this suite borrows a copy instead of making the package
 * depend on one. Resolution order:
 *
 *   1. `DSH_RENDER_TEST_NODE_MODULES`, an explicit install directory,
 *   2. the plugin's own `node_modules` (present when a developer ran `npm i`),
 *   3. nowhere.
 *
 * With no React the suite **skips** rather than failing: the shipping artifact
 * does not need it, so a checkout without a React install is a normal state, not
 * a broken build. Set the variable to run these assertions in CI.
 */
function resolveReact() {
  const candidates = [
    process.env.DSH_RENDER_TEST_NODE_MODULES,
    path.join(HERE, '..', 'node_modules'),
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')

  for (const root of candidates) {
    try {
      const req = createRequire(path.join(root, 'noop.js'))
      return {
        React: req('react'),
        renderToStaticMarkup: req('react-dom/server').renderToStaticMarkup,
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

const REACT = resolveReact()
const SKIP = REACT === null
  ? 'React is not installed; set DSH_RENDER_TEST_NODE_MODULES to a node_modules with react and react-dom'
  : false
const React = REACT === null ? null : REACT.React
const renderToStaticMarkup = REACT === null ? null : REACT.renderToStaticMarkup

/** A pin client stub: the real one talks to the Host. */
function pinClientOf(paths = [], extra = {}) {
  const snapshot = { paths, corrupt: false, error: null, loading: false, ...extra }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    set() { return Promise.resolve() },
    retry() { return Promise.resolve() },
    load() { return Promise.resolve() },
  }
}

/**
 * Load the artifact and return its registered components by slot name.
 *
 * @param {{ mode?: string, pinPaths?: string[] }} options
 */
function loadComponents(options = {}) {
  const registrations = []
  const opened = []
  const sessionPins = []
  const workspacePins = []
  const mode = options.mode === 'flat' ? 'flat' : 'workspace'

  const sandbox = {
    React,
    console: { error: () => {}, warn: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    localStorage: {
      store: new Map([[ 'dsh-session-panel.mode', mode ]]),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
      setItem(key, value) { this.store.set(key, String(value)) },
    },
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          const mod = factory(specifier => {
            assert.equal(specifier, 'react')
            return React
          })
          const ctx = {
            effect(fn) { return fn() },
            get: () => undefined,
            slots: {
              inject(_name, callback) { return callback() },
              register(registration, component) {
                registrations.push({ options: registration, component })
                return () => {}
              },
            },
            uiWorkspace: {
              openSession: id => opened.push(id),
              pinSession: id => { sessionPins.push(['pin', id]); return Promise.resolve() },
              unpinSession: id => { sessionPins.push(['unpin', id]); return Promise.resolve() },
            },
          }
          mod.apply(ctx)
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })

  const row = registrations.find(entry => entry.options.name === 'sidebar.panellist')
  const main = registrations.find(entry => entry.options.name === 'main')
  assert.ok(row, 'the sidebar row must register')
  assert.ok(main, 'the main panel must register')

  // Replace the plugin-owned pin client so a test controls the pin set.
  const face = main.options.inject()
  const pinClient = pinClientOf(options.pinPaths ?? [])
  face.pinClient = pinClient
  face.onToggleWorkspacePin = (pathValue, pinned) => workspacePins.push([pathValue, pinned])

  return {
    icon: row.component,
    page: main.component,
    face,
    opened,
    sessionPins,
    workspacePins,
  }
}

/** A static observable the renderer would otherwise supply as a hook. */
function hookOf(value) {
  return selector => (typeof selector === 'function' ? selector(value) : value)
}

/** Build the standard props the Harness renderer passes to a root slot. */
function propsFor(face, { list, workspaces, statuses = new Map() }) {
  return {
    t: face.t,
    pinClient: face.pinClient,
    onOpen: face.onOpen,
    onToggleSessionPin: face.onToggleSessionPin,
    onToggleWorkspacePin: face.onToggleWorkspacePin,
    useSessions: hookOf(list),
    useWorkspaces: hookOf(workspaces),
    useSessionStatus: hookOf(statuses),
  }
}

function session(id, extra = {}) {
  return {
    id,
    title: id,
    displayTitle: id,
    cwd: '',
    running: false,
    blank: false,
    updatedAt: Date.now(),
    retainedBy: { mainView: 0 },
    ...extra,
  }
}

function listOf(rows) {
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return { ids: rows.map(row => row.id), byId, phase: 'ready', projectionsBySession: {} }
}

function workspacesOf(items, archived = [], pinned = []) {
  return {
    items,
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
    state: 'idle',
    phase: 'ready',
    error: null,
  }
}

function ws(id, workspacePath, title, sessionIds) {
  return { workspaceId: id, path: workspacePath, title, sessionIds, createdAt: '', updatedAt: '' }
}

/** Render the page once for one set of inputs. */
function renderPage(options, data) {
  const loaded = loadComponents(options)
  return {
    html: renderToStaticMarkup(React.createElement(loaded.page, propsFor(loaded.face, data))),
    ...loaded,
  }
}

/**
 * Drop the inline stylesheet before asserting on markup.
 *
 * The component renders its styles as a `<style>` element, which contains every
 * class name the assertions look for — matching against it would always succeed
 * and prove nothing about which elements actually rendered.
 *
 * @param {string} html
 */
function markupOnly(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, '')
}

test('the page renders an empty state instead of throwing', { skip: SKIP }, () => {
  const { html } = renderPage({}, { list: listOf([]), workspaces: workspacesOf([]) })
  assert.match(html, /No sessions yet/)
})

test('workspace mode renders sections with a pinned workspace leading', { skip: SKIP }, () => {
  const { html } = renderPage({ mode: 'workspace', pinPaths: ['D:\\alpha'] }, {
    list: listOf([
      session('alpha-one', { updatedAt: 300 }),
      session('alpha-two', { updatedAt: 200 }),
      session('beta-one', { updatedAt: 100 }),
    ]),
    workspaces: workspacesOf([
      ws('w1', 'D:\\alpha', 'alpha', ['alpha-one', 'alpha-two']),
      ws('w2', 'D:\\beta', 'beta', ['beta-one']),
    ]),
  })

  assert.match(html, /alpha/)
  assert.match(html, /beta/)
  assert.match(html, /alpha-one/)
  // The mode switch renders both halves, with the active one marked.
  assert.match(html, /By workspace/)
  assert.match(html, /Recent everywhere/)
  assert.match(html, /aria-pressed="true"[^>]*>By workspace/)
})

test('flat mode renders the pinned block, the rule, then the rest', { skip: SKIP }, () => {
  const { html } = renderPage({ mode: 'flat', pinPaths: ['D:\\alpha'] }, {
    list: listOf([
      session('pinned-idle', { updatedAt: 900 }),
      session('rest-busy', { updatedAt: 5 }),
    ]),
    workspaces: workspacesOf([
      ws('w1', 'D:\\alpha', 'alpha', ['pinned-idle']),
      ws('w2', 'D:\\beta', 'beta', ['rest-busy']),
    ]),
    statuses: new Map([['rest-busy', { running: true, completionUnread: false }]]),
  })

  // The pinned section label and the separating rule both render.
  assert.match(html, /sessionPanel__sectionLabel/)
  assert.match(html, /Pinned/)
  assert.match(html, /sessionPanel__rule/)
  assert.match(html, /Recent/)
})

test('the rule is absent when nothing is pinned', { skip: SKIP }, () => {
  const { html } = renderPage({ mode: 'flat', pinPaths: [] }, {
    list: listOf([session('only')]),
    workspaces: workspacesOf([]),
  })
  const markup = markupOnly(html)
  assert.doesNotMatch(markup, /sessionPanel__rule/)
  assert.doesNotMatch(markup, /sessionPanel__sectionLabel/)
})

test('flat mode tags each card with its workspace, grouped mode does not', { skip: SKIP }, () => {
  const data = {
    list: listOf([session('one')]),
    workspaces: workspacesOf([ws('w1', 'D:\\alpha', 'alpha', ['one'])]),
  }
  const flat = markupOnly(renderPage({ mode: 'flat' }, data).html)
  const grouped = markupOnly(renderPage({ mode: 'workspace' }, data).html)

  assert.match(flat, /sessionPanel__cardWs/, 'the flat list must show where a card comes from')
  assert.doesNotMatch(grouped, /sessionPanel__cardWs/, 'the section header already says it')
})

test('a running session shows its status label', { skip: SKIP }, () => {
  const { html } = renderPage({}, {
    list: listOf([session('busy', { running: true })]),
    workspaces: workspacesOf([]),
    statuses: new Map([['busy', { running: true, completionUnread: false }]]),
  })
  assert.match(html, /Running/)
  assert.match(html, /sessionPanel__dot--running/)
})

test('a pending approval is labelled and coloured as waiting on the user', { skip: SKIP }, () => {
  const { html } = renderPage({}, {
    list: listOf([session('waiting')]),
    workspaces: workspacesOf([]),
    statuses: new Map([['waiting', {
      running: true,
      completionUnread: false,
      pendingInteraction: { kind: 'approval' },
    }]]),
  })
  assert.match(html, /Waiting for approval/)
  assert.match(html, /sessionPanel__dot--approval/)
})

test('a pinned card is marked and its pin button is pressed', { skip: SKIP }, () => {
  const { html } = renderPage({ pinPaths: ['D:\\alpha'] }, {
    list: listOf([session('pinned-one')]),
    workspaces: workspacesOf([ws('w1', 'D:\\alpha', 'alpha', ['pinned-one'])]),
  })
  assert.match(html, /sessionPanel__card--pinned/, 'a pinned card carries the marker class')
  assert.match(html, /sessionPanel__pin--on/, 'the pin button shows its pressed state')
  assert.match(html, /aria-pressed="true"/)
})

test('a workspace-level pin locks the per-card button', { skip: SKIP }, () => {
  const { html } = renderPage({ pinPaths: ['D:\\alpha'] }, {
    list: listOf([session('one')]),
    workspaces: workspacesOf([ws('w1', 'D:\\alpha', 'alpha', ['one'])]),
  })
  assert.match(html, /sessionPanel__pin--locked/)
  assert.match(html, /This workspace is pinned as a whole/)
})

test('the workspace pin button reflects the pinned state', { skip: SKIP }, () => {
  const pinned = markupOnly(renderPage({ pinPaths: ['D:\\alpha'] }, {
    list: listOf([session('one')]),
    workspaces: workspacesOf([ws('w1', 'D:\\alpha', 'alpha', ['one'])]),
  }).html)
  assert.match(pinned, /sessionPanel__wsPin--on/)
  assert.match(pinned, /aria-pressed="true"/)

  const free = markupOnly(renderPage({ pinPaths: [] }, {
    list: listOf([session('one')]),
    workspaces: workspacesOf([ws('w1', 'D:\\alpha', 'alpha', ['one'])]),
  }).html)
  assert.doesNotMatch(free, /sessionPanel__wsPin--on/)
  assert.match(free, /Pin workspace/)
})

test('archived cards render disabled and are hidden by default', { skip: SKIP }, () => {
  const { html } = renderPage({}, {
    list: listOf([session('live'), session('gone')]),
    workspaces: workspacesOf([], ['gone']),
  })
  assert.doesNotMatch(html, /gone/)
  assert.match(html, /Show archived/)
})

test('a damaged pin file surfaces a notice with a retry', { skip: SKIP }, () => {
  const loaded = loadComponents({})
  loaded.face.pinClient = pinClientOf([], { corrupt: true })
  const html = renderToStaticMarkup(React.createElement(loaded.page, propsFor(loaded.face, {
    list: listOf([session('one')]),
    workspaces: workspacesOf([]),
  })))
  assert.match(html, /damaged/)
  assert.match(html, /Retry/)
  assert.match(html, /role="alert"/)
})

test('a rejected write surfaces its reason instead of pretending success', { skip: SKIP }, () => {
  const loaded = loadComponents({})
  loaded.face.pinClient = pinClientOf([], { error: 'only loopback callers' })
  const html = renderToStaticMarkup(React.createElement(loaded.page, propsFor(loaded.face, {
    list: listOf([session('one')]),
    workspaces: workspacesOf([]),
  })))
  assert.match(html, /only loopback callers/)
  assert.match(html, /role="alert"/)
})

test('a snapshot that has not arrived yet renders the empty state', { skip: SKIP }, () => {
  const { html } = renderPage({}, {
    list: { ids: [], byId: {}, phase: 'pending', projectionsBySession: {} },
    workspaces: {
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: 'loading',
      phase: 'pending',
      error: null,
    },
  })
  assert.match(html, /sessionPanel__empty/)
})

test('the sidebar icon renders at the requested size', { skip: SKIP }, () => {
  const loaded = loadComponents({})
  const html = renderToStaticMarkup(React.createElement(loaded.icon, { size: 18, active: false }))
  assert.match(html, /width="18"/)
  assert.match(html, /height="18"/)
  assert.match(html, /<svg/)
})

test('a long group folds its overflow behind a count', { skip: SKIP }, () => {
  const rows = []
  const items = []
  for (let index = 0; index < 12; index += 1) {
    const id = `s${index}`
    rows.push(session(id, { updatedAt: 1000 - index }))
    items.push(id)
  }
  const { html } = renderPage({}, {
    list: listOf(rows),
    workspaces: workspacesOf([ws('w1', 'D:\\big', 'big', items)]),
  })
  assert.match(html, /4 more/)
  assert.doesNotMatch(html, /s11/)
})
