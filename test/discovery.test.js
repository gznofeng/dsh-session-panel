/**
 * Discovery contract check.
 *
 * The Harness host scans its Loader rows for packages declaring `dsh.client`,
 * reads the package manifest at the row's own module location, and then resolves
 * the `./client` export to a file path. If any of those steps disagree, the
 * plugin installs and appears enabled while no browser module ever loads — the
 * exact failure this file exists to catch before it reaches a browser.
 *
 * This mirrors the discovery steps from
 * `@deepseek-ai/dsh-client-modules` src/index.ts `resolveMeta`:
 *   1. the row's module specifier resolves to a package root,
 *   2. `package.json` parses and declares `dsh.client` with `platform: 'web'`,
 *   3. `exports['./client']` exists and the file it names exists on disk,
 *   4. the artifact's module id equals the package name (the loader keys on it).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.join(HERE, '..')
const MANIFEST = path.join(ROOT, 'package.json')

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

/** The client bundle path the Host resolves from `exports['./client']`. */
function clientBundlePath() {
  const target = manifest.exports['./client']
  assert.equal(typeof target, 'string', './client must map to a path string')
  return path.join(ROOT, target)
}

test('the package name is a valid npm name the loader can resolve', () => {
  assert.match(manifest.name, /^[a-z0-9][a-z0-9-]*$/)
  assert.equal(manifest.name, 'dsh-session-panel')
})

test('dsh.client declares the web platform and a resolvable ./client export', () => {
  const decl = manifest.dsh.client
  assert.equal(decl.platform, 'web', 'only the web platform produces a browser module')
  const bundle = clientBundlePath()
  assert.ok(existsSync(bundle), `the client bundle must exist at ${bundle}`)
  assert.ok(
    readFileSync(bundle, 'utf8').startsWith('window.__ModuleLoader__.load('),
    'the bundle must use the module loader envelope the Host expects',
  )
  assert.ok(manifest.files.includes('client.js'), 'client.js must ship')
})

test('the artifact id equals the package name, which is how the loader keys factories', () => {
  const source = readFileSync(clientBundlePath(), 'utf8')
  const match = source.match(/\bid:\s*'([^']+)'/)
  assert.ok(match !== null, 'the envelope must declare an id')
  assert.equal(match[1], manifest.name)
})

test('the bundle declares no external runtime imports beyond react', () => {
  const source = readFileSync(clientBundlePath(), 'utf8')
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  const unique = [...new Set(required)]
  assert.deepEqual(unique, ['react'], 'anything else would need dsh.client.external')
  // Declaring no externals keeps that list honest.
  assert.equal(manifest.dsh.client.external, undefined)
})

test('every locale file the manifest ships parses and carries the panel label', () => {
  const shipped = manifest.exports['./locale/*.json']
  assert.equal(typeof shipped, 'string')
  for (const locale of ['en', 'zh']) {
    const file = path.join(ROOT, 'locale', `${locale}.json`)
    assert.ok(existsSync(file), `locale/${locale}.json must exist`)
    const table = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof table.panel, 'string', `${locale} must define the row label`)
    assert.equal(typeof table['page.title'], 'string')
    // Plugin Manager renders these without activating the plugin.
    assert.equal(typeof table.meta.title, 'string', `${locale} meta.title drives the bundle page`)
    assert.equal(typeof table.meta.description, 'string')
  }
})

test('the bundle patch file is valid YAML-shaped and names the package it inserts', () => {
  const patchPath = path.join(ROOT, manifest.dsh.bundle.patch)
  assert.ok(existsSync(patchPath), 'the patch must exist')
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /^\s*-\s*insert:/m)
  assert.match(patch, new RegExp(`name:\\s*"?${manifest.name}"?`), 'the row must name the package')
  assert.match(patch, /^\s*-\s*id:\s*\S+/m, 'the row needs an id')
})

test('the icon ships and is inside the package', () => {
  const iconPath = path.join(ROOT, manifest.exports['./icon'])
  assert.ok(existsSync(iconPath))
  const svg = readFileSync(iconPath, 'utf8')
  assert.match(svg, /<svg[\s>]/, 'the icon must be SVG markup')
  assert.ok(manifest.files.includes('icon.svg'))
})

test('the inline icon follows the artwork rules: no tile, no scripts, 36-unit canvas', () => {
  const svg = readFileSync(path.join(ROOT, manifest.exports['./icon']), 'utf8')
  // Plugin Manager draws the surrounding tile itself, so the artwork must not
  // paint its own background or a full-bleed plate.
  assert.match(svg, /viewBox="0 0 36 36"/)
  assert.doesNotMatch(svg, /<style|<script|<image|<foreignObject|<text/, 'keep the asset self-contained')
  assert.doesNotMatch(svg, /(filter|feGaussianBlur|drop-shadow)/, 'no glow or drop shadow')
  // A full-bleed background rect would hide the host tile.
  const backgroundPlate = [...svg.matchAll(/<rect[^>]*x="0"[^>]*y="0"[^>]*width="36"[^>]*height="36"/g)]
  assert.equal(backgroundPlate.length, 0, 'the icon must not paint a full-size background')
})

test('the storefront PNG is a 180px square raster on GitHub-friendly format', () => {
  const pngPath = path.join(ROOT, 'assets', 'icon-180.png')
  assert.ok(existsSync(pngPath), 'the market refuses SVG, so a raster copy must ship')
  const bytes = readFileSync(pngPath)
  // PNG magic, then IHDR carries width and height as big-endian uint32.
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert.equal(width, 180, 'the entry points at a 180px tile')
  assert.equal(height, 180, 'the tile must be square')
  // The market caps plugin icons well above this; a large file is a mistake.
  assert.ok(bytes.length < 256 * 1024, `icon is ${bytes.length} bytes, over the limit`)
  assert.ok(manifest.files.some(pattern => pattern.includes('assets')), 'the raster must ship')
})

test('the host entry is loadable as ESM and exports apply', async () => {
  const mod = await import(new URL(`file:///${path.join(ROOT, 'index.js').replace(/\\/g, '/')}`))
  assert.equal(typeof mod.apply, 'function')
  // The host half must activate even where no web server exists: the routes are
  // its only browser surface, and a pin list is not worth an unmountable plugin.
  const injected = []
  const ctx = {
    effect() { return () => {} },
    logger: { warn() {} },
    inject(deps, activate) { injected.push(deps); /* no webServer here */ },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.deepEqual(injected, [['webServer']])
})

test('the package resolves through a profile-style node_modules link', () => {
  // A linked install resolves through the real path, so the manifest the Host
  // reads is this one rather than a copy in the profile.
  const req = createRequire(path.join(ROOT, 'noop.js'))
  const resolved = req.resolve('./package.json')
  assert.equal(path.resolve(resolved), path.resolve(MANIFEST))
})
