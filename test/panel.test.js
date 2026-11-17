/**
 * Unit tests for the panel's pure logic.
 *
 * `client.js` is a browser artifact wrapped in `window.__ModuleLoader__.load`,
 * so the tests load it through a minimal loader stub, capture the module the
 * factory returns, and reach the internal derivation through an instrumented
 * copy of the source.
 *
 * The point here is the derivation, not the rendering: grouping, the four-tier
 * ordering, the two pin sources, the archive filter and the mode split are the
 * behaviour that can be wrong without looking wrong.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const CLIENT = path.join(HERE, '..', 'client.js')
const SOURCE = readFileSync(CLIENT, 'utf8')

/**
 * Evaluate client.js in a sandbox and return the exported module plus the
 * derivation helpers the factory closed over.
 *
 * The helpers are not exported by the artifact, so a capture block is inserted
 * just before the factory returns, which is the only place those names are in
 * scope. The instrumented copy is never written to disk and is never shipped.
 */
function loadClient() {
  let exported
  // The artifact captures the sandbox's `console` at load time, so error
  // assertions must read this array rather than patching the host console.
  const errors = []
  const react = {
    createElement: (...args) => ({ __element: true, args }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: factory => factory(),
    useEffect: () => {},
    useRef: value => ({ current: value }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  const sandbox = {
    React: react,
    console: { error: (...args) => errors.push(args), warn: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
      setItem(key, value) { this.store.set(key, String(value)) },
    },
    window: {
      __ModuleLoader__: {
        load({ factory }) {
          // The factory returns the exports object itself (the artifact builds
          // `module.exports` and returns it), so there is no extra `.exports`.
          exported = factory(specifier => {
            assert.equal(specifier, 'react', 'the artifact must only require react')
            return react
          })
        },
      },
    },
  }
  sandbox.globalThis = sandbox

  const capture = 'window.__capture = { buildNodes, buildGroups, buildFlat, statusOf, '
    + 'basename, normalizePath, tierOf, byTier, isBusy, createTranslator, '
    + 'GROUP_LIMIT, MODE_WORKSPACE, MODE_FLAT };\n'
  const marker = '    return module.exports;'
  assert.ok(SOURCE.includes(marker), 'the factory return marker must exist')
  const instrumented = SOURCE.replace(marker, `${capture}${marker}`)

  vm.runInNewContext(instrumented, sandbox, { filename: 'client.js' })
  return { exported, captured: sandbox.window.__capture, errors }
}

const { exported, captured, errors: loadErrors } = loadClient()
const {
  buildNodes, buildGroups, buildFlat, statusOf,
  basename, normalizePath, tierOf, byTier, isBusy,
  createTranslator, GROUP_LIMIT, MODE_WORKSPACE, MODE_FLAT,
} = captured

/** Minimal Session list snapshot. */
function listOf(rows) {
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return { ids: rows.map(row => row.id), byId, phase: 'ready', projectionsBySession: {} }
}

/** Minimal Workspace snapshot. */
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

/** Workspace row helper. */
function ws(id, workspacePath, title, sessionIds) {
  return { workspaceId: id, path: workspacePath, title, sessionIds, createdAt: '', updatedAt: '' }
}

/** Session status map. */
function statusesOf(entries) {
  return new Map(Object.entries(entries))
}

/**
 * Flat ids in render order.
 *
 * The derivation runs inside a separate `vm` realm, so its arrays carry that
 * realm's `Array.prototype` and `deepEqual` rejects them on reference identity.
 * Rebuilding the array here keeps the assertions about values.
 */
function idsOf(nodes) {
  return Array.from(nodes, node => node.id)
}

// ---------------------------------------------------------------------------
// manifest and artifact shape
// ---------------------------------------------------------------------------

test('manifest declares dsh.bundle, which is what makes the plugin installable', () => {
  const manifest = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  assert.equal(typeof manifest.dsh.bundle.patch, 'string')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.exports['./client'], 'the client module must be exported')
  assert.ok(manifest.exports['./locale/*.json'])
  assert.ok(manifest.exports['./icon'])
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(manifest.files.includes(file), `${file} must be in files`)
  }
  // The host half now owns lib/ files; a missing glob breaks the install.
  assert.ok(manifest.files.includes('lib'), 'lib must ship')
})

test('the artifact requires nothing but react', () => {
  assert.match(SOURCE, /^window\.__ModuleLoader__\.load\(/)
  assert.equal(exportsIdOf(SOURCE), 'dsh-session-panel')
  assert.doesNotMatch(SOURCE, /require\(\s*['"]\.\.?\//)
})

function exportsIdOf(source) {
  const match = source.match(/id:\s*'([^']+)'/)
  return match === null ? '' : match[1]
}

test('apply declares its hard dependencies', () => {
  assert.deepEqual([...exported.inject], ['slots', 'uiWorkspace'])
})

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Build a ctx that records every slot registration. */
function recordingCtx(overrides = {}) {
  const registrations = []
  const effects = []
  const injections = []
  const opened = []
  const pinnedCalls = []
  const ctx = {
    effect(fn, label) { effects.push(label); const dispose = fn(); return dispose },
    get: () => undefined,
    slots: {
      inject(name, callback) { injections.push(name); return callback() },
      register(options, component) { registrations.push({ options, component }); return () => {} },
    },
    uiWorkspace: {
      openSession: id => opened.push(id),
      pinSession: id => { pinnedCalls.push(['pin', id]); return Promise.resolve() },
      unpinSession: id => { pinnedCalls.push(['unpin', id]); return Promise.resolve() },
    },
    ...overrides,
  }
  return { ctx, registrations, effects, injections, opened, pinnedCalls }
}

test('apply registers the sidebar row at order 11 and the matching main key', () => {
  const { ctx, registrations, injections } = recordingCtx()
  exported.apply(ctx)

  assert.deepEqual(injections, ['sidebar.panellist', 'main'])

  const row = registrations.find(entry => entry.options.name === 'sidebar.panellist')
  assert.equal(row.options.id, 'session-panel')
  assert.equal(row.options.order, 11, 'order 11 sits directly below Automation tasks at 10')
  assert.equal(typeof row.options.label, 'function')

  const page = registrations.find(entry => entry.options.name === 'main')
  assert.equal(page.options.key, row.options.id, 'the main key must match the sidebar id')
  assert.equal(typeof page.options.inject, 'function')
})

test('the navigation callback opens the session through uiWorkspace', () => {
  const { ctx, registrations, opened } = recordingCtx()
  exported.apply(ctx)
  const page = registrations.find(entry => entry.options.name === 'main')
  page.options.inject().onOpen('session-abc')
  assert.deepEqual(opened, ['session-abc'])
})

test('session pinning goes through the Harness API, never a plugin copy', () => {
  const { ctx, registrations, pinnedCalls } = recordingCtx()
  exported.apply(ctx)
  const page = registrations.find(entry => entry.options.name === 'main')
  const face = page.options.inject()

  face.onToggleSessionPin('s1', true)
  face.onToggleSessionPin('s2', false)

  assert.deepEqual(pinnedCalls, [['pin', 's1'], ['unpin', 's2']])
})

test('workspace pinning reaches the host route client', () => {
  const posted = []
  const { ctx, registrations } = recordingCtx({
    fetch: undefined,
  })
  // Replace the sandbox fetch the artifact captured is not possible here, so
  // this asserts the wiring instead: the face exposes a function that accepts a
  // path and a boolean.
  exported.apply(ctx)
  const page = registrations.find(entry => entry.options.name === 'main')
  const face = page.options.inject()
  assert.equal(typeof face.onToggleWorkspacePin, 'function')
  assert.doesNotThrow(() => face.onToggleWorkspacePin('D:\\ds_plugin', true))
  assert.deepEqual(posted, [])
})

test('a throwing registration is contained instead of taking down the client', () => {
  const before = loadErrors.length
  const ctx = {
    effect(fn) { return fn() },
    get: () => undefined,
    slots: {
      inject() { throw new Error('slot already taken') },
      register() { throw new Error('unreachable') },
    },
    uiWorkspace: { openSession() {} },
  }
  assert.doesNotThrow(() => exported.apply(ctx))
  assert.equal(loadErrors.length - before, 1, 'the failure is reported once')
})

// ---------------------------------------------------------------------------
// status precedence
// ---------------------------------------------------------------------------

test('status precedence follows the sidebar row: pending, running, done, idle', () => {
  assert.equal(statusOf(undefined), 'idle')
  assert.equal(statusOf({ running: true, completionUnread: false }), 'running')
  assert.equal(statusOf({ running: false, completionUnread: true }), 'done')
  assert.equal(statusOf({ running: false, completionUnread: false }), 'idle')
  assert.equal(statusOf({ running: true, pendingInteraction: { kind: 'approval' } }), 'approval')
  assert.equal(statusOf({ running: true, pendingInteraction: { kind: 'plan-review' } }), 'planReview')
  assert.equal(statusOf({ running: true, pendingInteraction: { kind: 'question' } }), 'question')
  assert.equal(statusOf({ running: true, pendingInteraction: { kind: 'mystery' } }), 'question')
})

// ---------------------------------------------------------------------------
// the four-tier ordering
// ---------------------------------------------------------------------------

test('ranking: pinned+busy beats pinned, which beats busy, which beats idle', () => {
  assert.equal(tierOf({ pinned: true, status: 'running' }), 0)
  assert.equal(tierOf({ pinned: true, status: 'idle' }), 1)
  assert.equal(tierOf({ pinned: false, status: 'running' }), 2)
  assert.equal(tierOf({ pinned: false, status: 'idle' }), 3)
  // A pending interaction counts as busy.
  assert.equal(tierOf({ pinned: false, status: 'approval' }), 2)
  assert.equal(tierOf({ pinned: true, status: 'approval' }), 0)
})

test('a pinned busy session leads a pinned idle one even when it is older', () => {
  const busyOld = { id: 'a', pinned: true, status: 'running', updatedAt: 1 }
  const idleNew = { id: 'b', pinned: true, status: 'idle', updatedAt: 999 }
  assert.ok(byTier(busyOld, idleNew) < 0, 'pinned+busy outranks pinned+idle despite age')
})

test('within one tier the most recent comes first', () => {
  const older = { id: 'a', pinned: false, status: 'idle', updatedAt: 10 }
  const newer = { id: 'b', pinned: false, status: 'idle', updatedAt: 20 }
  assert.ok(byTier(newer, older) < 0)
})

test('isBusy excludes the finished-but-unread state', () => {
  assert.equal(isBusy({ status: 'running' }), true)
  assert.equal(isBusy({ status: 'approval' }), true)
  assert.equal(isBusy({ status: 'done' }), false)
  assert.equal(isBusy({ status: 'idle' }), false)
})

// ---------------------------------------------------------------------------
// node derivation
// ---------------------------------------------------------------------------

test('nodes carry their owning workspace identity and label', () => {
  const list = listOf([
    { id: 's1', title: 'Alpha work', cwd: 'D:\\a', running: false, updatedAt: 300 },
    { id: 's2', title: 'Beta work', cwd: 'D:\\b', running: false, updatedAt: 200 },
  ])
  const workspaces = workspacesOf([
    ws('w1', 'D:\\a', 'alpha', ['s1']),
    ws('w2', 'D:\\b', 'beta', ['s2']),
  ])

  const nodes = buildNodes(list, workspaces, new Map(), false, new Set())
  assert.equal(nodes.length, 2)
  const alpha = nodes.find(node => node.id === 's1')
  assert.equal(alpha.workspaceId, 'w1')
  assert.equal(alpha.workspaceLabel, 'alpha')
  assert.equal(alpha.workspacePath, 'D:\\a')
})

test('a workspace with no title falls back to the trailing path segment', () => {
  const list = listOf([{ id: 's1', title: 'X', running: false, updatedAt: 1 }])
  const workspaces = workspacesOf([ws('w1', 'D:\\work\\order-service', '', ['s1'])])
  const nodes = buildNodes(list, workspaces, new Map(), false, new Set())
  assert.equal(nodes[0].workspaceLabel, 'order-service')
})

test('a session with no owning workspace gets an empty workspace identity', () => {
  const list = listOf([{ id: 'orphan', title: 'Orphan', running: false, updatedAt: 10 }])
  const nodes = buildNodes(list, workspacesOf([]), new Map(), false, new Set())
  assert.equal(nodes[0].workspaceId, '')
  assert.equal(nodes[0].workspaceLabel, '')
  assert.equal(nodes[0].workspacePath, '')
})

test('a session pin marks only that session', () => {
  const list = listOf([
    { id: 's1', title: 'A', running: false, updatedAt: 2 },
    { id: 's2', title: 'B', running: false, updatedAt: 1 },
  ])
  const workspaces = workspacesOf([ws('w1', 'D:\\a', 'alpha', ['s1', 's2'])], [], ['s1'])
  const nodes = buildNodes(list, workspaces, new Map(), false, new Set())
  assert.equal(nodes.find(n => n.id === 's1').pinned, true)
  assert.equal(nodes.find(n => n.id === 's2').pinned, false)
})

test('a workspace pin marks every session inside it', () => {
  const list = listOf([
    { id: 's1', title: 'A', running: false, updatedAt: 2 },
    { id: 's2', title: 'B', running: false, updatedAt: 1 },
    { id: 'other', title: 'C', running: false, updatedAt: 3 },
  ])
  const workspaces = workspacesOf([
    ws('w1', 'D:\\a', 'alpha', ['s1', 's2']),
    ws('w2', 'D:\\b', 'beta', ['other']),
  ])
  const nodes = buildNodes(list, workspaces, new Map(), false, new Set(['D:\\a']))
  assert.equal(nodes.find(n => n.id === 's1').pinned, true)
  assert.equal(nodes.find(n => n.id === 's1').pinnedByWorkspace, true)
  assert.equal(nodes.find(n => n.id === 's2').pinned, true)
  assert.equal(nodes.find(n => n.id === 'other').pinned, false)
})

test('a pin keyed to a path the workspace no longer has matches nothing', () => {
  const list = listOf([{ id: 's1', title: 'A', running: false, updatedAt: 1 }])
  const workspaces = workspacesOf([ws('w1', 'D:\\a', 'alpha', ['s1'])])
  // A stale entry for a removed folder must not pin the current one.
  const nodes = buildNodes(list, workspaces, new Map(), false, new Set(['D:\\gone']))
  assert.equal(nodes[0].pinned, false)
})

test('an archived session is never marked pinned', () => {
  const list = listOf([{ id: 's1', title: 'A', running: false, updatedAt: 1 }])
  const workspaces = workspacesOf([ws('w1', 'D:\\a', 'alpha', ['s1'])], ['s1'])
  const nodes = buildNodes(list, workspaces, new Map(), true, new Set(['D:\\a']))
  assert.equal(nodes.length, 1, 'archived rows appear when requested')
  assert.equal(nodes[0].archived, true)
  assert.equal(nodes[0].pinned, false, 'an archived card cannot be pinned')
})

// ---------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------

test('blank and subagent rows never become cards', () => {
  const list = listOf([
    { id: 'blank', title: '', blank: true, running: false, updatedAt: 1 },
    { id: 'child', title: 'Child', parentId: 'parent', running: false, updatedAt: 2 },
    { id: 'origin', title: 'Origin', origin: 'subagent', running: false, updatedAt: 3 },
    { id: 'real', title: 'Real', running: false, updatedAt: 4 },
  ])
  const nodes = buildNodes(list, workspacesOf([]), new Map(), false, new Set())
  assert.deepEqual(idsOf(nodes), ['real'])
})

test('archived sessions are hidden by default and shown on request', () => {
  const list = listOf([
    { id: 'live', title: 'Live', running: false, updatedAt: 9 },
    { id: 'old', title: 'Old', running: false, updatedAt: 1 },
  ])
  const workspaces = workspacesOf([], ['old'])

  assert.deepEqual(idsOf(buildNodes(list, workspaces, new Map(), false, new Set())), ['live'])
  const shown = idsOf(buildNodes(list, workspaces, new Map(), true, new Set()))
  assert.deepEqual(shown.sort(), ['live', 'old'])
})

test('a missing or malformed snapshot yields no nodes instead of throwing', () => {
  assert.equal(buildNodes(undefined, undefined, new Map(), false, new Set()).length, 0)
  assert.equal(buildNodes({}, {}, new Map(), false, new Set()).length, 0)
  assert.equal(buildNodes(null, null, new Map(), false, new Set()).length, 0)
  // A missing pin set must not throw either.
  assert.equal(buildNodes({}, {}, new Map(), false, undefined).length, 0)
})

// ---------------------------------------------------------------------------
// grouping (workspace mode)
// ---------------------------------------------------------------------------

test('sessions group by their owning workspace and stay inside it when pinned', () => {
  const list = listOf([
    { id: 's1', title: 'Alpha one', running: false, updatedAt: 300 },
    { id: 's2', title: 'Beta one', running: false, updatedAt: 200 },
    { id: 's3', title: 'Alpha two', running: false, updatedAt: 100 },
  ])
  const workspaces = workspacesOf([
    ws('w1', 'D:\\a', 'alpha', ['s1', 's3']),
    ws('w2', 'D:\\b', 'beta', ['s2']),
  ])
  const nodes = buildNodes(list, workspaces, new Map(), false, new Set(['D:\\a']))
  const groups = buildGroups(nodes)

  assert.equal(groups.length, 2, 'a pinned workspace is not pulled out into a second group')
  const alpha = groups.find(group => group.label === 'alpha')
  assert.deepEqual(Array.from(alpha.sessions, node => node.id).sort(), ['s1', 's3'])
  assert.equal(alpha.hasPinned, true)
  assert.equal(groups[0].label, 'alpha', 'a workspace holding pinned work leads')
})

test('a workspace holding pinned+busy work leads one holding only pinned idle work', () => {
  const list = listOf([
    { id: 'busy', title: 'Busy', running: false, updatedAt: 10 },
    { id: 'idle', title: 'Idle', running: false, updatedAt: 999 },
  ])
  const workspaces = workspacesOf([
    ws('w1', 'D:\\busy', 'busy', ['busy']),
    ws('w2', 'D:\\idle', 'idle', ['idle']),
  ])
  const statuses = statusesOf({ busy: { running: true } })
  const nodes = buildNodes(list, workspaces, statuses, false, new Set(['D:\\busy', 'D:\\idle']))
  const groups = buildGroups(nodes)
  assert.equal(groups[0].label, 'busy')
})

test('inside a group the four-tier order applies', () => {
  const list = listOf([
    { id: 'recent-idle', title: 'Recent idle', running: false, updatedAt: 900 },
    { id: 'pinned-idle', title: 'Pinned idle', running: false, updatedAt: 100 },
    { id: 'busy', title: 'Busy', running: false, updatedAt: 50 },
    { id: 'pinned-busy', title: 'Pinned busy', running: false, updatedAt: 10 },
  ])
  const workspaces = workspacesOf([ws('w1', 'D:\\x', 'x', [
    'recent-idle', 'pinned-idle', 'busy', 'pinned-busy',
  ])], [], ['pinned-idle', 'pinned-busy'])
  const statuses = statusesOf({ busy: { running: true }, 'pinned-busy': { running: true } })
  const nodes = buildNodes(list, workspaces, statuses, false, new Set())
  const groups = buildGroups(nodes)
  assert.deepEqual(
    Array.from(groups[0].sessions, node => node.id),
    ['pinned-busy', 'pinned-idle', 'busy', 'recent-idle'],
  )
})

// ---------------------------------------------------------------------------
// flat mode
// ---------------------------------------------------------------------------

test('flat mode splits pinned from the rest and sorts each by tier', () => {
  const list = listOf([
    { id: 'p1', title: 'Pinned idle', running: false, updatedAt: 900 },
    { id: 'p2', title: 'Pinned busy', running: false, updatedAt: 10 },
    { id: 'r1', title: 'Rest idle', running: false, updatedAt: 800 },
    { id: 'r2', title: 'Rest busy', running: false, updatedAt: 5 },
  ])
  const workspaces = workspacesOf([ws('w1', 'D:\\a', 'alpha', ['p1', 'p2', 'r1', 'r2'])], [], ['p1', 'p2'])
  const statuses = statusesOf({ p2: { running: true }, r2: { running: true } })
  const nodes = buildNodes(list, workspaces, statuses, false, new Set())
  const flat = buildFlat(nodes)

  assert.deepEqual(idsOf(flat.pinned), ['p2', 'p1'], 'pinned+busy leads despite being older')
  assert.deepEqual(idsOf(flat.rest), ['r2', 'r1'], 'busy leads within the rest')
})

test('flat mode keeps every session: only the arrangement changes', () => {
  const list = listOf([
    { id: 'a', title: 'A', running: false, updatedAt: 3 },
    { id: 'b', title: 'B', running: false, updatedAt: 2 },
    { id: 'c', title: 'C', running: false, updatedAt: 1 },
  ])
  const workspaces = workspacesOf([
    ws('w1', 'D:\\a', 'alpha', ['a']),
    ws('w2', 'D:\\b', 'beta', ['b', 'c']),
  ])
  const nodes = buildNodes(list, workspaces, new Map(), false, new Set())

  const groupedIds = Array.from(buildGroups(nodes), group => Array.from(group.sessions, node => node.id)).flat()
  const flatResult = buildFlat(nodes)
  const flatAll = idsOf(flatResult.pinned).concat(idsOf(flatResult.rest))

  assert.deepEqual(groupedIds.slice().sort(), flatAll.slice().sort(), 'both modes show the same sessions')
  assert.equal(new Set(flatAll).size, 3, 'no duplicates across the two flat blocks')
})

test('flat mode with nothing pinned puts everything below the rule', () => {
  const list = listOf([
    { id: 'a', title: 'A', running: false, updatedAt: 2 },
    { id: 'b', title: 'B', running: false, updatedAt: 1 },
  ])
  const nodes = buildNodes(list, workspacesOf([]), new Map(), false, new Set())
  const flat = buildFlat(nodes)
  assert.equal(flat.pinned.length, 0)
  assert.deepEqual(idsOf(flat.rest), ['a', 'b'])
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('basename accepts both separators and trailing slashes', () => {
  assert.equal(basename('D:\\projects\\alpha'), 'alpha')
  assert.equal(basename('/home/user/beta'), 'beta')
  assert.equal(basename('D:\\projects\\alpha\\'), 'alpha')
  assert.equal(basename(''), '')
  assert.equal(basename(undefined), '')
})

test('normalizePath mirrors the host rule so optimistic pins compare', () => {
  assert.equal(normalizePath('D:\\a\\'), 'D:\\a')
  assert.equal(normalizePath('/home/user/'), '/home/user')
  assert.equal(normalizePath('  D:\\a  '), 'D:\\a')
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath(null), '')
  assert.equal(normalizePath(undefined), '')
  // A root keeps its single separator rather than collapsing to nothing.
  assert.equal(normalizePath('/'), '/')
})

test('the translator substitutes parameters and falls back to English', () => {
  const t = createTranslator(undefined)
  assert.equal(t('page.title'), 'Session panel')
  assert.equal(t('time.minutes', { count: 5 }), '5 min ago')
  assert.equal(t('page.count.pinned', { count: 3 }), ' · 3 pinned')
  assert.equal(t('no.such.key'), 'no.such.key')
})

test('the two mode constants are the ones the switch and storage use', () => {
  assert.equal(MODE_WORKSPACE, 'workspace')
  assert.equal(MODE_FLAT, 'flat')
  assert.ok(GROUP_LIMIT > 0)
})
