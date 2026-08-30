#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultRegistryRoot = join(repoRoot, 'registry')

export const simpleClaimKinds = ['loaderIds', 'services', 'tools', 'commands', 'skills']
export const searchKinds = ['pluginIds', 'packages', ...simpleClaimKinds, 'routes', 'ports']

const namespacePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/
const claimPattern = /^[^\s\u0000-\u001f\u007f]{1,128}$/u
const allowedMethods = new Set(['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])

function posixPath(value) {
  return value.replaceAll('\\', '/')
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function normalizeNewlines(value) {
  return value.replaceAll('\r\n', '\n')
}

function addError(errors, path, message) {
  errors.push({ path, message })
}

function checkObject(value, path, errors) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    addError(errors, path, 'must be an object')
    return false
  }
  return true
}

function checkUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${path}.${key}`, 'unknown field')
  }
}

function checkOptionalString(value, path, errors, { pattern, maxLength = 512 } = {}) {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    addError(errors, path, `must be a non-empty string up to ${maxLength} characters`)
  } else if (pattern && !pattern.test(value)) {
    addError(errors, path, `has an invalid format (${String(pattern)})`)
  }
}

function repositoryOwner(repository) {
  try {
    const url = new URL(repository)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) return undefined
    const segments = url.pathname.replace(/^\/|\/$/g, '').split('/')
    if (segments.length !== 2 || !segments[0] || !segments[1]) return undefined
    return segments[0].toLowerCase()
  } catch {
    return undefined
  }
}

function normalizedRepository(repository) {
  return repository.replace(/\/$/, '').toLowerCase()
}

function validateClaimArray(value, path, errors) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    addError(errors, path, 'must be an array')
    return
  }
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const claim = value[index]
    if (typeof claim !== 'string' || !claimPattern.test(claim)) {
      addError(errors, `${path}[${index}]`, 'must be a non-empty, whitespace-free name up to 128 characters')
      continue
    }
    if (seen.has(claim)) addError(errors, `${path}[${index}]`, `duplicates ${JSON.stringify(claim)} in this manifest`)
    seen.add(claim)
  }
}

export function validateManifest(manifest, { file = 'manifest', expectedId, allowManifestPath = false } = {}) {
  const errors = []
  if (!checkObject(manifest, file, errors)) return errors
  const topLevel = new Set(['$schema', 'schemaVersion', 'plugin', 'compatibility', 'claims'])
  if (allowManifestPath) topLevel.add('manifestPath')
  checkUnknownKeys(manifest, topLevel, file, errors)

  if (manifest.schemaVersion !== 1) addError(errors, `${file}.schemaVersion`, 'must be 1')
  checkOptionalString(manifest.$schema, `${file}.$schema`, errors)
  if (allowManifestPath) checkOptionalString(manifest.manifestPath, `${file}.manifestPath`, errors)

  if (checkObject(manifest.plugin, `${file}.plugin`, errors)) {
    checkUnknownKeys(
      manifest.plugin,
      new Set(['id', 'displayName', 'repository', 'package', 'release', 'status']),
      `${file}.plugin`,
      errors,
    )
    checkOptionalString(manifest.plugin.id, `${file}.plugin.id`, errors, { maxLength: 193 })
    const parts = typeof manifest.plugin.id === 'string' ? manifest.plugin.id.split('/') : []
    if (parts.length !== 2 || !namespacePattern.test(parts[0] ?? '') || !slugPattern.test(parts[1] ?? '')) {
      addError(errors, `${file}.plugin.id`, 'must use the lowercase <github-owner>/<plugin-slug> form')
    }
    if (expectedId && manifest.plugin.id !== expectedId) {
      addError(errors, `${file}.plugin.id`, `must match the entry path (${expectedId})`)
    }
    checkOptionalString(manifest.plugin.displayName, `${file}.plugin.displayName`, errors, { maxLength: 128 })
    checkOptionalString(manifest.plugin.repository, `${file}.plugin.repository`, errors)
    const owner = repositoryOwner(manifest.plugin.repository)
    if (!owner) {
      addError(errors, `${file}.plugin.repository`, 'must be a canonical https://github.com/<owner>/<repo> URL')
    } else if (parts[0] && owner !== parts[0]) {
      addError(errors, `${file}.plugin.repository`, `GitHub owner must match plugin namespace ${JSON.stringify(parts[0])}`)
    }
    checkOptionalString(manifest.plugin.package, `${file}.plugin.package`, errors, { maxLength: 214 })
    checkOptionalString(manifest.plugin.release, `${file}.plugin.release`, errors, { maxLength: 128 })
    if (!['active', 'deprecated', 'archived'].includes(manifest.plugin.status)) {
      addError(errors, `${file}.plugin.status`, 'must be active, deprecated, or archived')
    }
  }

  if (manifest.compatibility !== undefined && checkObject(manifest.compatibility, `${file}.compatibility`, errors)) {
    checkUnknownKeys(manifest.compatibility, new Set(['dsh']), `${file}.compatibility`, errors)
    checkOptionalString(manifest.compatibility.dsh, `${file}.compatibility.dsh`, errors, { maxLength: 128 })
  }

  if (checkObject(manifest.claims, `${file}.claims`, errors)) {
    checkUnknownKeys(manifest.claims, new Set([...simpleClaimKinds, 'routes', 'ports']), `${file}.claims`, errors)
    for (const kind of simpleClaimKinds) validateClaimArray(manifest.claims[kind], `${file}.claims.${kind}`, errors)

    const routes = manifest.claims.routes
    if (routes !== undefined && !Array.isArray(routes)) addError(errors, `${file}.claims.routes`, 'must be an array')
    if (Array.isArray(routes)) {
      const seen = new Set()
      for (let index = 0; index < routes.length; index += 1) {
        const path = `${file}.claims.routes[${index}]`
        const route = routes[index]
        if (!checkObject(route, path, errors)) continue
        checkUnknownKeys(route, new Set(['method', 'path']), path, errors)
        if (!allowedMethods.has(route.method)) addError(errors, `${path}.method`, 'must be an HTTP method or *')
        if (typeof route.path !== 'string' || !route.path.startsWith('/') || route.path.length > 512) {
          addError(errors, `${path}.path`, 'must be an absolute HTTP path up to 512 characters')
        }
        const key = `${route.method} ${route.path}`
        if (seen.has(key)) addError(errors, path, `duplicates route ${JSON.stringify(key)} in this manifest`)
        seen.add(key)
      }
    }

    const ports = manifest.claims.ports
    if (ports !== undefined && !Array.isArray(ports)) addError(errors, `${file}.claims.ports`, 'must be an array')
    if (Array.isArray(ports)) {
      const seen = new Set()
      for (let index = 0; index < ports.length; index += 1) {
        const path = `${file}.claims.ports[${index}]`
        const port = ports[index]
        if (!checkObject(port, path, errors)) continue
        checkUnknownKeys(port, new Set(['protocol', 'port', 'configurable']), path, errors)
        if (!['tcp', 'udp'].includes(port.protocol)) addError(errors, `${path}.protocol`, 'must be tcp or udp')
        if (!Number.isInteger(port.port) || port.port < 1 || port.port > 65535) {
          addError(errors, `${path}.port`, 'must be an integer from 1 to 65535')
        }
        if (typeof port.configurable !== 'boolean') addError(errors, `${path}.configurable`, 'must be a boolean')
        const key = `${port.protocol}:${port.port}`
        if (seen.has(key)) addError(errors, path, `duplicates port ${JSON.stringify(key)} in this manifest`)
        seen.add(key)
      }
    }
  }
  return errors
}

async function walkJsonFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkJsonFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
  }
  return files.sort()
}

function expectedIdForEntry(entriesRoot, file) {
  const path = posixPath(relative(entriesRoot, file))
  const match = /^([^/]+)\/([^/]+)\.json$/.exec(path)
  return match ? `${match[1]}/${match[2]}` : undefined
}

export async function loadRegistry(registryRoot = defaultRegistryRoot) {
  const root = resolve(registryRoot)
  const entriesRoot = join(root, 'entries')
  const files = await walkJsonFiles(entriesRoot)
  const errors = []
  const records = []
  const identities = new Map()

  for (const file of files) {
    const entryPath = posixPath(relative(repoRoot, file))
    const expectedId = expectedIdForEntry(entriesRoot, file)
    if (!expectedId) addError(errors, entryPath, 'entry path must be registry/entries/<github-owner>/<plugin-slug>.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      addError(errors, entryPath, `invalid JSON: ${error.message}`)
      continue
    }
    const manifestErrors = validateManifest(manifest, { file: entryPath, expectedId })
    errors.push(...manifestErrors)
    if (manifestErrors.length) continue
    const id = manifest?.plugin?.id
    if (typeof id === 'string') {
      if (identities.has(id)) {
        addError(errors, entryPath, `duplicates plugin identity already declared by ${identities.get(id)}`)
        continue
      }
      else identities.set(id, entryPath)
    }
    records.push({ manifest, manifestPath: entryPath })
  }
  return { records, errors }
}

function publicManifest(record) {
  const { $schema: _schema, ...manifest } = record.manifest
  return { ...manifest, manifestPath: record.manifestPath }
}

export function createIndex(records) {
  return {
    schemaVersion: 1,
    source: 'registry/entries',
    plugins: records
      .map(publicManifest)
      .sort((left, right) => left.plugin.id.localeCompare(right.plugin.id)),
  }
}

function claimRows(plugin) {
  const rows = []
  const claims = plugin.claims ?? {}
  rows.push(...simpleClaimKinds.flatMap((kind) => (claims[kind] ?? []).map((claim) => ({ kind, claim, raw: claim }))))
  if (plugin.plugin?.package) rows.push({ kind: 'packages', claim: plugin.plugin.package, raw: plugin.plugin.package })
  for (const route of claims.routes ?? []) {
    rows.push({ kind: 'routes', claim: `${route.method} ${route.path}`, raw: route })
  }
  for (const port of claims.ports ?? []) {
    rows.push({ kind: 'ports', claim: `${port.protocol}:${port.port}`, raw: port })
  }
  return rows
}

function conflictReason(kind, claim, entries) {
  if (kind === 'ports') {
    const fixed = entries.filter((entry) => entry.raw.configurable === false)
    return fixed.length >= 2
      ? `multiple plugins require fixed port ${claim}`
      : `multiple plugins mention port ${claim}, but at least one declaration is configurable`
  }
  if (kind === 'loaderIds') return 'the same loader ID conflicts when these plugins are mounted in one composition group'
  if (kind === 'routes') return 'the same HTTP method and path may collide when these plugins share one router'
  if (kind === 'packages') return 'the same package coordinate is claimed by multiple plugin identities'
  return `the same ${kind} name may collide when these plugins are composed in one scope`
}

export function detectClaimConflicts(plugins) {
  const groups = new Map()
  for (const plugin of plugins) {
    for (const row of claimRows(plugin)) {
      const key = `${row.kind}\u0000${row.claim}`
      const entries = groups.get(key) ?? []
      entries.push({
        ...row,
        id: plugin.plugin.id,
        repository: plugin.plugin.repository,
        manifestPath: plugin.manifestPath,
      })
      groups.set(key, entries)
    }
  }

  const conflicts = []
  for (const entries of groups.values()) {
    const ids = sortedUnique(entries.map((entry) => entry.id))
    if (ids.length < 2) continue
    const first = entries[0]
    const fixedPortCount = first.kind === 'ports' ? entries.filter((entry) => entry.raw.configurable === false).length : 0
    conflicts.push({
      severity: first.kind === 'ports' && fixedPortCount < 2 ? 'notice' : 'warning',
      kind: first.kind,
      claim: first.claim,
      reason: conflictReason(first.kind, first.claim, entries),
      plugins: ids.map((id) => {
        const entry = entries.find((candidate) => candidate.id === id)
        return { id, repository: entry.repository, manifestPath: entry.manifestPath }
      }),
    })
  }
  return conflicts.sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.claim.localeCompare(right.claim),
  )
}

export async function validateRegistry({ registryRoot = defaultRegistryRoot, checkIndex = false } = {}) {
  const root = resolve(registryRoot)
  const { records, errors } = await loadRegistry(root)
  const index = createIndex(records)
  if (checkIndex) {
    const indexPath = join(root, 'index.json')
    try {
      const actual = await readFile(indexPath, 'utf8')
      if (normalizeNewlines(actual) !== stableStringify(index)) {
        addError(errors, posixPath(relative(repoRoot, indexPath)), 'generated index is stale; run build-index')
      }
    } catch (error) {
      addError(errors, posixPath(relative(repoRoot, indexPath)), `cannot read generated index: ${error.message}`)
    }
  }
  return { errors, conflicts: detectClaimConflicts(index.plugins), index }
}

export async function readIndexSource({ indexPath, registryUrl } = {}) {
  let index
  if (indexPath) {
    index = JSON.parse(await readFile(resolve(indexPath), 'utf8'))
  } else {
    if (!registryUrl) throw new Error('provide --index or --registry-url')
    const response = await fetch(registryUrl, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-conflict-check' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`registry request failed: HTTP ${response.status} ${response.statusText}`)
    index = await response.json()
  }
  if (index?.schemaVersion !== 1 || !Array.isArray(index.plugins)) throw new Error('registry index must use schemaVersion 1')
  for (let offset = 0; offset < index.plugins.length; offset += 1) {
    const errors = validateManifest(index.plugins[offset], {
      file: `index.plugins[${offset}]`,
      allowManifestPath: true,
    })
    if (errors.length) throw new Error(errors.map((entry) => `${entry.path}: ${entry.message}`).join('; '))
  }
  return index
}

export async function checkManifestAgainstIndex(manifest, index, { file = 'manifest' } = {}) {
  const errors = validateManifest(manifest, { file })
  if (errors.length) return { candidate: manifest?.plugin?.id, errors, conflicts: [] }
  const candidateId = manifest.plugin.id
  const existing = index.plugins.find((plugin) => plugin.plugin.id === candidateId)
  const identityConflict =
    existing && normalizedRepository(existing.plugin.repository) !== normalizedRepository(manifest.plugin.repository)
      ? {
          severity: 'error',
          kind: 'pluginIds',
          claim: candidateId,
          reason: 'the plugin identity is already registered by a different repository',
          plugins: [
            { id: existing.plugin.id, repository: existing.plugin.repository, manifestPath: existing.manifestPath },
            { id: candidateId, repository: manifest.plugin.repository, manifestPath: file },
          ],
        }
      : undefined
  const candidate = { ...manifest, manifestPath: file }
  const base = existing && !identityConflict ? index.plugins.filter((plugin) => plugin.plugin.id !== candidateId) : index.plugins
  const conflicts = detectClaimConflicts([...base, candidate]).filter((conflict) =>
    conflict.plugins.some((plugin) => plugin.id === candidateId && plugin.manifestPath === file),
  )
  if (identityConflict) conflicts.unshift(identityConflict)
  return { candidate: candidateId, errors: [], conflicts }
}

function normalizedSearchKind(kind) {
  const aliases = {
    id: 'pluginIds',
    plugin: 'pluginIds',
    package: 'packages',
    loader: 'loaderIds',
    service: 'services',
    tool: 'tools',
    command: 'commands',
    skill: 'skills',
    route: 'routes',
    port: 'ports',
  }
  return aliases[kind] ?? kind
}

export function searchIndex(index, kindInput, name) {
  const kind = normalizedSearchKind(kindInput)
  if (!searchKinds.includes(kind)) throw new Error(`unknown kind ${JSON.stringify(kindInput)}; use ${searchKinds.join(', ')}`)
  const matches = []
  for (const plugin of index.plugins) {
    if (kind === 'pluginIds' && plugin.plugin.id === name) matches.push(plugin)
    else if (kind === 'packages' && plugin.plugin.package === name) matches.push(plugin)
    else if (simpleClaimKinds.includes(kind) && (plugin.claims?.[kind] ?? []).includes(name)) matches.push(plugin)
    else if (kind === 'routes' && (plugin.claims?.routes ?? []).some((route) => `${route.method} ${route.path}` === name)) matches.push(plugin)
    else if (kind === 'ports' && (plugin.claims?.ports ?? []).some((port) => `${port.protocol}:${port.port}` === name)) matches.push(plugin)
  }
  return {
    kind,
    name,
    count: matches.length,
    matches: matches.map((plugin) => ({
      id: plugin.plugin.id,
      repository: plugin.plugin.repository,
      status: plugin.plugin.status,
      manifestPath: plugin.manifestPath,
    })),
  }
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function renderConflicts(conflicts) {
  if (!conflicts.length) return ['- No conflicts found.']
  const lines = ['| Severity | Kind | Claim | Registered plugins |', '|---|---|---|---|']
  for (const conflict of conflicts) {
    lines.push(
      `| ${conflict.severity} | ${conflict.kind} | \`${escapeCell(conflict.claim)}\` | ${escapeCell(conflict.plugins.map((plugin) => plugin.id).join(', '))} |`,
    )
  }
  return lines
}

function renderErrors(errors) {
  return errors.length ? errors.map((entry) => `- \`${entry.path}\`: ${entry.message}`) : ['- None.']
}

export function renderCheckMarkdown(report) {
  return `${[
    '# DSH plugin conflict check',
    '',
    `- Candidate: \`${report.candidate ?? 'unknown'}\``,
    `- Result: ${report.errors.length ? 'invalid manifest' : report.conflicts.some((conflict) => conflict.severity === 'error') ? 'blocking identity conflict' : report.conflicts.length ? 'advisory conflicts found' : 'no conflicts found'}`,
    '- Claim collisions are advisory unless strict mode is enabled.',
    '',
    '## Manifest errors',
    '',
    ...renderErrors(report.errors),
    '',
    '## Conflicts',
    '',
    ...renderConflicts(report.conflicts),
  ].join('\n')}\n`
}

export function checkResultExitCode(report, { strict = false } = {}) {
  if (report.errors.length || report.conflicts.some((conflict) => conflict.severity === 'error')) return 1
  if (strict && report.conflicts.length) return 2
  return 0
}

function renderRegistryMarkdown(report) {
  return `${[
    '# DSH plugin registry validation',
    '',
    `- Registered plugins: ${report.index.plugins.length}`,
    `- Manifest errors: ${report.errors.length}`,
    `- Advisory claim collisions: ${report.conflicts.length}`,
    '',
    '## Errors',
    '',
    ...renderErrors(report.errors),
    '',
    '## Advisory collisions',
    '',
    ...renderConflicts(report.conflicts),
  ].join('\n')}\n`
}

function renderSearchMarkdown(result) {
  const lines = [
    '# DSH plugin registry search',
    '',
    `- Kind: \`${result.kind}\``,
    `- Name: \`${result.name}\``,
    `- Matches: ${result.count}`,
    '',
  ]
  if (!result.matches.length) lines.push('- No registered plugin uses this value.')
  else {
    lines.push('| Plugin | Status | Repository |', '|---|---|---|')
    for (const match of result.matches) lines.push(`| ${match.id} | ${match.status} | ${match.repository} |`)
  }
  return `${lines.join('\n')}\n`
}

function annotationText(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

async function emit(value, format, kind) {
  let markdown
  if (kind === 'check') markdown = renderCheckMarkdown(value)
  else if (kind === 'search') markdown = renderSearchMarkdown(value)
  else markdown = renderRegistryMarkdown(value)

  if (format === 'json') process.stdout.write(stableStringify(value))
  else if (format === 'markdown') process.stdout.write(markdown)
  else if (format === 'github') {
    for (const error of value.errors ?? []) {
      process.stdout.write(`::error file=${annotationText(error.path)}::${annotationText(error.message)}\n`)
    }
    for (const conflict of value.conflicts ?? []) {
      const command = conflict.severity === 'notice' ? 'notice' : conflict.severity
      process.stdout.write(`::${command}::${annotationText(`${conflict.kind} ${conflict.claim}: ${conflict.reason}; plugins: ${conflict.plugins.map((plugin) => plugin.id).join(', ')}`)}\n`)
    }
    process.stdout.write(markdown)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
  } else throw new Error('--format must be json, markdown, or github')
}

function parseOptions(args, booleanFlags = new Set()) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`)
    if (booleanFlags.has(flag)) {
      options[flag.slice(2)] = true
      continue
    }
    const value = args[++index]
    if (value === undefined) throw new Error(`missing value for ${flag}`)
    options[flag.slice(2)] = value
  }
  return options
}

function usage() {
  return `Usage:
  node scripts/plugin-registry.mjs validate [--registry registry] [--check-index] [--strict-claims] [--format markdown|json|github]
  node scripts/plugin-registry.mjs build-index [--registry registry] [--output registry/index.json] [--check]
  node scripts/plugin-registry.mjs search --kind service --name <value> [--index registry/index.json | --registry-url <url>] [--format markdown|json]
  node scripts/plugin-registry.mjs check --manifest <file> [--index registry/index.json | --registry-url <url>] [--strict] [--format markdown|json|github]

Conflict checks are advisory by default. --strict exits with code 2 when a collision is found.
`
}

export async function runCli(argv) {
  const [command, ...args] = argv
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage())
    return 0
  }

  if (command === 'validate') {
    const options = parseOptions(args, new Set(['--check-index', '--strict-claims']))
    const report = await validateRegistry({
      registryRoot: options.registry ?? defaultRegistryRoot,
      checkIndex: options['check-index'] ?? false,
    })
    await emit(report, options.format ?? 'markdown', 'registry')
    if (report.errors.length) return 1
    if (options['strict-claims'] && report.conflicts.some((conflict) => conflict.severity !== 'notice')) return 2
    return 0
  }

  if (command === 'build-index') {
    const options = parseOptions(args, new Set(['--check']))
    const registryRoot = resolve(options.registry ?? defaultRegistryRoot)
    const report = await validateRegistry({ registryRoot })
    if (report.errors.length) {
      await emit(report, 'markdown', 'registry')
      return 1
    }
    const output = resolve(options.output ?? join(registryRoot, 'index.json'))
    const expected = stableStringify(report.index)
    if (options.check) {
      let actual
      try {
        actual = await readFile(output, 'utf8')
      } catch {
        actual = undefined
      }
      if (actual === undefined || normalizeNewlines(actual) !== expected) {
        process.stderr.write(`plugin-registry: stale index at ${output}; run build-index without --check\n`)
        return 1
      }
      process.stdout.write(`Plugin registry index is current: ${report.index.plugins.length} plugins\n`)
      return 0
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, expected)
    process.stdout.write(`Wrote ${output}: ${report.index.plugins.length} plugins\n`)
    return 0
  }

  if (command === 'search') {
    const options = parseOptions(args)
    if (!options.kind || !options.name) throw new Error('search requires --kind and --name')
    const index = await readIndexSource({ indexPath: options.index, registryUrl: options['registry-url'] })
    const result = searchIndex(index, options.kind, options.name)
    await emit(result, options.format ?? 'markdown', 'search')
    return 0
  }

  if (command === 'check') {
    const options = parseOptions(args, new Set(['--strict']))
    if (!options.manifest) throw new Error('check requires --manifest')
    const manifestPath = resolve(options.manifest)
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      const report = {
        candidate: undefined,
        errors: [{ path: posixPath(relative(process.cwd(), manifestPath)), message: `cannot read manifest: ${error.message}` }],
        conflicts: [],
      }
      await emit(report, options.format ?? 'markdown', 'check')
      return 1
    }
    const index = await readIndexSource({ indexPath: options.index, registryUrl: options['registry-url'] })
    const report = await checkManifestAgainstIndex(manifest, index, { file: posixPath(relative(process.cwd(), manifestPath)) })
    await emit(report, options.format ?? 'markdown', 'check')
    return checkResultExitCode(report, { strict: options.strict })
  }

  throw new Error(`unknown command: ${command}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`plugin-registry: ${error.message}\n${usage()}`)
    process.exitCode = 1
  }
}
