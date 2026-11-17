/**
 * Host-side tests: the pin file, the route guards and the request contract.
 *
 * These run against a real temporary directory, because the behaviour worth
 * testing here is exactly the file behaviour — atomic replacement, first-run
 * absence, a damaged file disabling writes. A mocked `fs` would let the very
 * bug that matters (silently overwriting a user's pins) pass.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStateLifecycle, CorruptStateError, SaveStateError } from '../lib/lifecycle.js'
import {
  emptyState, normalizePath, sanitizeState, isPinned, pin, unpin,
  STATE_VERSION, MAX_PATH_LENGTH, MAX_PINNED,
} from '../lib/store.js'
import { createRoutes, isLoopback, ROUTE_PATHS } from '../lib/routes.js'

/** A fresh temporary directory per test. */
async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-session-panel-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// store: the pure rules
// ---------------------------------------------------------------------------

test('normalizePath trims separators and whitespace but keeps the folder', () => {
  assert.equal(normalizePath('D:\\a\\'), 'D:\\a')
  assert.equal(normalizePath('  D:\\a  '), 'D:\\a')
  assert.equal(normalizePath('/home/user/'), '/home/user')
  // A root would collapse to nothing without the guard.
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath(''), null)
  assert.equal(normalizePath('   '), null)
  assert.equal(normalizePath(42), null)
  assert.equal(normalizePath(null), null)
  assert.equal(normalizePath('x'.repeat(MAX_PATH_LENGTH + 1)), null)
})

test('sanitizeState drops junk, de-duplicates, and keeps valid paths', () => {
  assert.deepEqual(sanitizeState(undefined), { version: STATE_VERSION, pinnedWorkspaces: [] })
  assert.deepEqual(sanitizeState('nope'), { version: STATE_VERSION, pinnedWorkspaces: [] })
  assert.deepEqual(sanitizeState({}), { version: STATE_VERSION, pinnedWorkspaces: [] })

  const cleaned = sanitizeState({
    version: 99,
    pinnedWorkspaces: ['D:\\a', 'D:\\a\\', '', null, 42, 'D:\\b'],
  })
  assert.deepEqual(cleaned.pinnedWorkspaces, ['D:\\a', 'D:\\b'], 'trailing separators unify, junk is dropped')
  assert.equal(cleaned.version, STATE_VERSION, 'the written version is always current')
})

test('sanitizeState caps an absurd list', () => {
  const many = Array.from({ length: MAX_PINNED + 50 }, (_, index) => `D:\\w${index}`)
  assert.equal(sanitizeState({ pinnedWorkspaces: many }).pinnedWorkspaces.length, MAX_PINNED)
})

test('pin and unpin are idempotent', () => {
  const base = emptyState()
  const once = pin(base, 'D:\\a')
  const twice = pin(once, 'D:\\a\\')
  assert.deepEqual(twice.pinnedWorkspaces, ['D:\\a'], 'pinning twice keeps one entry')

  const removed = unpin(once, 'D:\\a')
  assert.deepEqual(removed.pinnedWorkspaces, [])
  assert.deepEqual(unpin(removed, 'D:\\a'), removed, 'unpinning an absent path is a no-op')
})

test('pin and unpin refuse an unusable path', () => {
  const base = emptyState()
  assert.throws(() => pin(base, ''), TypeError)
  assert.throws(() => pin(base, null), TypeError)
  assert.throws(() => unpin(base, undefined), TypeError)
})

test('isPinned normalizes both sides before comparing', () => {
  const state = pin(emptyState(), 'D:\\a')
  assert.equal(isPinned(state, 'D:\\a'), true)
  assert.equal(isPinned(state, 'D:\\a\\'), true)
  assert.equal(isPinned(state, 'D:\\b'), false)
  assert.equal(isPinned(state, ''), false)
})

test('pin never mutates its input', () => {
  const base = emptyState()
  const next = pin(base, 'D:\\a')
  assert.equal(base.pinnedWorkspaces.length, 0, 'the original state is untouched')
  assert.notEqual(next, base)
})

// ---------------------------------------------------------------------------
// lifecycle: the file
// ---------------------------------------------------------------------------

test('a missing file is a clean first run, not an error', async t => {
  const dir = await scratch(t)
  const lifecycle = createStateLifecycle({ file: path.join(dir, 'nested', 'state.json') })
  await lifecycle.ready
  assert.deepEqual(lifecycle.state().pinnedWorkspaces, [])
  assert.equal(lifecycle.state().corrupt, false)
})

test('a pin survives a round trip through disk', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  const first = createStateLifecycle({ file })
  await first.ready
  await first.mutate(current => pin(current, 'D:\\a'))

  // A second lifecycle reads what the first wrote.
  const second = createStateLifecycle({ file })
  await second.ready
  assert.deepEqual(second.state().pinnedWorkspaces, ['D:\\a'])

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.version, STATE_VERSION)
  assert.deepEqual(onDisk.pinnedWorkspaces, ['D:\\a'])
})

test('the file is written atomically and leaves no temp files behind', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  await lifecycle.mutate(current => pin(current, 'D:\\a'))

  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir)
  assert.deepEqual(entries, ['state.json'], 'no .tmp file survives a successful write')
})

test('a damaged file is reported and refuses every write', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  await writeFile(file, '{ not json', 'utf8')

  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  const state = lifecycle.state()
  assert.equal(state.corrupt, true, 'the damage is surfaced')
  assert.deepEqual(state.pinnedWorkspaces, [], 'the reader still answers safely')

  await assert.rejects(
    () => lifecycle.mutate(current => pin(current, 'D:\\a')),
    CorruptStateError,
  )
  // The original bytes are still there: overwriting them would destroy the only
  // copy of whatever the user had.
  assert.equal(await readFile(file, 'utf8'), '{ not json')
})

test('reload recovers a file the user repaired by hand', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  await writeFile(file, 'broken', 'utf8')

  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  assert.equal(lifecycle.state().corrupt, true)

  await writeFile(file, JSON.stringify({ version: 1, pinnedWorkspaces: ['D:\\a'] }), 'utf8')
  await lifecycle.reload()
  assert.equal(lifecycle.state().corrupt, false)
  assert.deepEqual(lifecycle.state().pinnedWorkspaces, ['D:\\a'])

  // And a write works again.
  await lifecycle.mutate(current => pin(current, 'D:\\b'))
  assert.deepEqual(lifecycle.state().pinnedWorkspaces, ['D:\\a', 'D:\\b'])
})

test('an empty file is treated as empty rather than damaged', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  await writeFile(file, '   \n', 'utf8')
  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  assert.equal(lifecycle.state().corrupt, false)
  assert.deepEqual(lifecycle.state().pinnedWorkspaces, [])
})

test('a real I/O failure is rethrown instead of being read as empty', async t => {
  const dir = await scratch(t)
  // A directory where the file should be: readable as a path, not as a file.
  const file = path.join(dir, 'state.json')
  await mkdir(file)
  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  assert.throws(() => lifecycle.state())
})

test('concurrent writes are serialized instead of losing one', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready

  await Promise.all([
    lifecycle.mutate(current => pin(current, 'D:\\a')),
    lifecycle.mutate(current => pin(current, 'D:\\b')),
    lifecycle.mutate(current => pin(current, 'D:\\c')),
  ])

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.pinnedWorkspaces.slice().sort(), ['D:\\a', 'D:\\b', 'D:\\c'])
})

test('the written file is sorted so a rewrite is a stable diff', async t => {
  const dir = await scratch(t)
  const file = path.join(dir, 'state.json')
  const lifecycle = createStateLifecycle({ file })
  await lifecycle.ready
  await lifecycle.mutate(current => pin(pin(pin(current, 'D:\\c'), 'D:\\a'), 'D:\\b'))
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(onDisk.pinnedWorkspaces, ['D:\\a', 'D:\\b', 'D:\\c'])
})

// ---------------------------------------------------------------------------
// routes: the loopback guard
// ---------------------------------------------------------------------------

test('isLoopback accepts only local addresses', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('127.5.5.5'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)

  assert.equal(isLoopback('192.168.1.10'), false)
  assert.equal(isLoopback('10.0.0.1'), false)
  assert.equal(isLoopback('8.8.8.8'), false)
  assert.equal(isLoopback('::ffff:8.8.8.8'), false)
  // A missing or malformed address must fail closed: this is a write surface.
  assert.equal(isLoopback(undefined), false)
  assert.equal(isLoopback(''), false)
  assert.equal(isLoopback('not-an-address'), false)
  assert.equal(isLoopback('127.0.0.256'), false)
})

// ---------------------------------------------------------------------------
// routes: the request contract
// ---------------------------------------------------------------------------

/** Build a fake request/response pair. */
function exchange({ method = 'GET', remoteAddress = '127.0.0.1', body } = {}) {
  const listeners = {}
  const req = {
    method,
    socket: { remoteAddress },
    resume() {},
    on(event, handler) {
      listeners[event] = handler
      return req
    },
  }
  const res = {
    statusCode: 0,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(text) { res.payload = text },
  }
  return {
    req,
    res,
    /**
     * Deliver the body to whatever listeners the handler registered.
     *
     * Called after the handler has started, because the handler registers its
     * `data`/`end` listeners only once it begins reading the body.
     */
    finish() {
      if (listeners.data && body !== undefined) {
        listeners.data(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      }
      if (listeners.end) listeners.end()
    },
    json() {
      try {
        return JSON.parse(res.payload)
      } catch {
        return null
      }
    },
  }
}

/** A routes bundle over an in-memory state. */
function routesOver(initial = emptyState()) {
  let state = initial
  const routes = createRoutes({
    state: () => ({ ...state, corrupt: false }),
    mutate: async fn => { state = fn(state); return { ...state, corrupt: false } },
    reload: async () => {},
    pin,
    unpin,
  })
  return { routes, stateOf: () => state }
}


/**
 * Run one POST route to completion.
 *
 * The handler registers its body listeners only once it starts reading, so the
 * body has to be delivered after the call begins rather than before it.
 */
async function postTo(routes, routePath, body) {
  const io = exchange({ method: 'POST', body })
  const running = routeOf(routes, routePath).handler(io.req, io.res)
  io.finish()
  await running
  return io
}

function routeOf(routes, routePath) {
  const found = routes.find(route => route.path === routePath)
  assert.ok(found, `route ${routePath} must exist`)
  return found
}

test('every route refuses a non-loopback caller before reading the method', async () => {
  const { routes } = routesOver()
  for (const route of routes) {
    const io = exchange({ method: route === routeOf(routes, ROUTE_PATHS.pin) ? 'POST' : 'GET', remoteAddress: '192.168.1.5' })
    await route.handler(io.req, io.res)
    assert.equal(io.res.statusCode, 403, `${route.path} must refuse a remote caller`)
  }
})

test('a route refuses the wrong method', async () => {
  const { routes } = routesOver()
  const stateRoute = routeOf(routes, ROUTE_PATHS.state)
  const io = exchange({ method: 'POST' })
  await stateRoute.handler(io.req, io.res)
  assert.equal(io.res.statusCode, 405)
})

test('GET state answers the current set', async () => {
  const { routes } = routesOver(pin(emptyState(), 'D:\\a'))
  const io = exchange({ method: 'GET' })
  await routeOf(routes, ROUTE_PATHS.state).handler(io.req, io.res)
  assert.equal(io.res.statusCode, 200)
  assert.deepEqual(io.json().pinnedWorkspaces, ['D:\\a'])
  assert.equal(io.json().corrupt, false)
})

test('POST pin writes and answers the new set', async () => {
  const { routes, stateOf } = routesOver()
  const io = await postTo(routes, ROUTE_PATHS.pin, { path: 'D:\\a', pinned: true })
  assert.equal(io.res.statusCode, 200)
  assert.deepEqual(io.json().pinnedWorkspaces, ['D:\\a'])
  assert.deepEqual(stateOf().pinnedWorkspaces, ['D:\\a'])

  const off = await postTo(routes, ROUTE_PATHS.pin, { path: 'D:\\a', pinned: false })
  assert.deepEqual(off.json().pinnedWorkspaces, [])
})

test('POST pin rejects a malformed payload instead of writing it', async () => {
  const { routes, stateOf } = routesOver()
  const cases = [
    { body: {}, why: 'missing path' },
    { body: { path: '', pinned: true }, why: 'empty path' },
    { body: { path: 'D:\\a' }, why: 'missing pinned' },
    { body: { path: 'D:\\a', pinned: 'yes' }, why: 'pinned is not a boolean' },
  ]
  for (const entry of cases) {
    const io = await postTo(routes, ROUTE_PATHS.pin, entry.body)
    assert.equal(io.res.statusCode, 400, entry.why)
  }
  assert.deepEqual(stateOf().pinnedWorkspaces, [], 'nothing was written by a rejected request')
})

test('POST pin rejects a non-JSON body', async () => {
  const { routes } = routesOver()
  const io = await postTo(routes, ROUTE_PATHS.pin, 'not json at all')
  assert.equal(io.res.statusCode, 400)
})

test('POST reload re-reads and answers', async () => {
  const { routes } = routesOver(pin(emptyState(), 'D:\\a'))
  const io = await postTo(routes, ROUTE_PATHS.reload, {})
  assert.equal(io.res.statusCode, 200)
  assert.deepEqual(io.json().pinnedWorkspaces, ['D:\\a'])
})

test('a route surfaces an internal failure as a 500 with a reason', async () => {
  const routes = createRoutes({
    state: () => { throw new SaveStateError('D:\\x', new Error('disk on fire')) },
    mutate: async () => {},
    reload: async () => {},
    pin,
    unpin,
  })
  const io = exchange({ method: 'GET' })
  await routeOf(routes, ROUTE_PATHS.state).handler(io.req, io.res)
  assert.equal(io.res.statusCode, 500)
  assert.match(io.json().error, /disk on fire/)
})

test('every route path lives under the plugins prefix', () => {
  // A bare path registers on the Host but is unreachable: the Web composition's
  // fallback owns everything outside the reserved prefixes, so the request
  // answers 404 before the route table is consulted.
  for (const routePath of Object.values(ROUTE_PATHS)) {
    assert.ok(
      routePath.startsWith('/plugins/dsh-session-panel/'),
      `${routePath} must sit under /plugins/dsh-session-panel/`,
    )
  }
})

test('createRoutes refuses an incomplete dependency set', () => {
  assert.throws(() => createRoutes({}), TypeError)
  assert.throws(() => createRoutes({ state: () => emptyState() }), TypeError)
})
