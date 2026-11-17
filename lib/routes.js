/**
 * The loopback HTTP surface the session panel talks to.
 *
 * Three routes:
 *
 * - `GET  /plugins/dsh-session-panel/state`  — the current pin set
 * - `POST /plugins/dsh-session-panel/pin`    — `{ path, pinned: boolean }`
 * - `POST /plugins/dsh-session-panel/reload` — re-read the file after a bad state
 *
 * **Every route is loopback-only.** This is a write surface backed by a file on
 * the user's machine, so a request from off-machine must not reach it even with
 * a valid session cookie. The check happens before the method check, so a remote
 * caller learns nothing about a route's contract.
 *
 * **The `/plugins/<name>/` prefix is not decoration.** A route registered at a
 * bare path is accepted by `webServer.register` and then never reached: the
 * Web composition's fallback owns every path outside the reserved prefixes, so
 * the request answers 404 before the route table is consulted. Every plugin's
 * own endpoints live under `plugins/`.
 *
 * The browser talks to these routes because the Client half cannot touch the
 * filesystem. That is the whole reason the Host half exists.
 */

import { normalizePath } from './store.js'

/** Hard ceiling on a request body. A pin request is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Route paths, exported so tests and the client agree on them.
 *
 * The `/plugins/<name>/` prefix is required: a bare path such as
 * `/dsh-session-panel/state` registers but is never reached, because the Web
 * composition's fallback owns every path outside the reserved prefixes. The
 * panel's own routes live under `plugins/` alongside every other plugin's.
 */
export const ROUTE_PATHS = {
  state: '/plugins/dsh-session-panel/state',
  pin: '/plugins/dsh-session-panel/pin',
  reload: '/plugins/dsh-session-panel/reload',
}

/** A failure that maps to a specific status code. */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeAddress(value) {
  if (typeof value !== 'string') return null
  const address = value.trim().toLowerCase()
  return address === '' ? null : address
}

/**
 * Parse a dotted-quad IPv4 address.
 *
 * @param {string} address
 * @returns {number[] | null}
 */
function parseIPv4(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number.parseInt(part, 10)
    if (value < 0 || value > 255) return null
    octets.push(value)
  }
  return octets
}

/** @returns {number[] | null} the embedded IPv4 of an `::ffff:` address */
function parseMappedIPv4(address) {
  if (address.includes('.')) return parseIPv4(address)
  const groups = address.split(':')
  if (groups.length !== 2) return null
  if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return null
  const high = Number.parseInt(groups[0], 16)
  const low = Number.parseInt(groups[1], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

/**
 * Is this peer on the loopback interface?
 *
 * Accepts `::1`, the whole `127.0.0.0/8` range, and the IPv4-mapped forms of
 * both. Everything else — including a missing address — is refused: this is a
 * write surface, so the safe default is "not local".
 *
 * @param {unknown} remoteAddress
 * @returns {boolean}
 */
export function isLoopback(remoteAddress) {
  const address = normalizeAddress(remoteAddress)
  if (address === null) return false
  if (address === '::1') return true
  const octets = address.startsWith('::ffff:')
    ? parseMappedIPv4(address.slice('::ffff:'.length))
    : parseIPv4(address)
  return octets !== null && octets[0] === 127
}

/** Consume a body we will not parse, so it cannot stay queued on the socket. */
function drain(req) {
  if (typeof req?.resume === 'function') req.resume()
}

/** @param {any} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** @param {any} res @param {number} status @param {string} message */
function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

/**
 * Read the request body as text, enforcing {@link MAX_BODY_BYTES} while
 * accumulating (a `Content-Length` header is attacker-controlled and may be
 * absent entirely).
 *
 * @param {any} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = message => {
      if (settled) return
      settled = true
      reject(new HttpError(400, message))
    }

    req.on('data', chunk => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        fail('请求体超过上限')
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => fail('请求体读取失败'))
  })
}

/**
 * Parse a JSON request body. An empty body is an error here on purpose: the POST
 * routes require a payload, and `JSON.parse('')` would only produce a confusing
 * syntax message.
 *
 * @param {any} req
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req) {
  const text = await readBody(req)
  if (text.trim() === '') throw new HttpError(400, '请求体不能为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON')
  }
}

/** @returns {string} a short readable reason from anything thrown */
function describeFailure(error) {
  if (error instanceof Error && typeof error.message === 'string') {
    const cause = /** @type {any} */ (error).cause
    if (cause instanceof Error && typeof cause.message === 'string') {
      return `${error.message}（${cause.message}）`
    }
    return error.message
  }
  return String(error)
}

/**
 * The answer payload every route returns.
 *
 * `corrupt` is surfaced so the panel can explain a refused write instead of
 * showing a generic failure: a damaged file needs the user's attention.
 *
 * @param {{ pinnedWorkspaces: string[], corrupt: boolean }} state
 */
function stateBody(state) {
  return {
    pinnedWorkspaces: state.pinnedWorkspaces,
    corrupt: state.corrupt === true,
  }
}

/**
 * Build the routes.
 *
 * @param {{
 *   state: () => { pinnedWorkspaces: string[], corrupt: boolean },
 *   mutate: (fn: (current: any) => any) => Promise<any>,
 *   reload: () => Promise<void>,
 *   pin: (state: any, path: string) => any,
 *   unpin: (state: any, path: string) => any,
 * }} deps
 * @returns {{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }[]}
 */
export function createRoutes(deps) {
  for (const key of ['state', 'mutate', 'reload', 'pin', 'unpin']) {
    if (typeof deps?.[key] !== 'function') {
      throw new TypeError(`createRoutes 需要 ${key} 函数`)
    }
  }

  /**
   * Wrap one route body with the guards every route shares. Order matters:
   * loopback, then method, then body — a remote caller learns nothing about a
   * route's payload contract.
   *
   * @param {'GET' | 'POST'} method
   * @param {(body: unknown, req: any) => Promise<{ status: number, body: unknown }>} handle
   */
  function makeHandler(method, handle) {
    return async function handler(req, res) {
      if (!isLoopback(req?.socket?.remoteAddress)) {
        drain(req)
        sendError(res, 403, '只接受来自本机回环地址的请求')
        return
      }
      if (req.method !== method) {
        drain(req)
        sendError(res, 405, `该路径只支持 ${method}`)
        return
      }
      try {
        const body = method === 'POST' ? await readJsonBody(req) : undefined
        const result = await handle(body, req)
        sendJson(res, result.status, result.body)
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(res, error.status, error.message)
          return
        }
        sendError(res, 500, `处理请求失败：${describeFailure(error)}`)
      }
    }
  }

  return [
    {
      kind: 'exact',
      path: ROUTE_PATHS.state,
      handler: makeHandler('GET', async () => ({
        status: 200,
        body: stateBody(deps.state()),
      })),
    },
    {
      kind: 'exact',
      path: ROUTE_PATHS.pin,
      handler: makeHandler('POST', async body => {
        if (body === null || typeof body !== 'object') {
          throw new HttpError(400, '请求体必须是对象')
        }
        const request = /** @type {any} */ (body)
        const path = normalizePath(request.path)
        if (path === null) throw new HttpError(400, 'path 无效')
        if (typeof request.pinned !== 'boolean') {
          throw new HttpError(400, 'pinned 必须是布尔值')
        }
        const next = await deps.mutate(current => (
          request.pinned ? deps.pin(current, path) : deps.unpin(current, path)
        ))
        return { status: 200, body: stateBody(next) }
      }),
    },
    {
      kind: 'exact',
      path: ROUTE_PATHS.reload,
      handler: makeHandler('POST', async () => {
        await deps.reload()
        return { status: 200, body: stateBody(deps.state()) }
      }),
    },
  ]
}
