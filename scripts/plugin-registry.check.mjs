import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  checkResultExitCode,
  checkManifestAgainstIndex,
  createIndex,
  detectClaimConflicts,
  loadRegistry,
  searchIndex,
  validateManifest,
  validateRegistry,
} from './plugin-registry.mjs'

function manifest(owner, slug, overrides = {}) {
  const base = {
    schemaVersion: 1,
    plugin: {
      id: `${owner}/${slug}`,
      repository: `https://github.com/${owner}/${slug}`,
      package: `@${owner}/${slug}`,
      status: 'active',
    },
    compatibility: { dsh: '>=0.1.2-alpha.2 <0.2.0' },
    claims: {
      loaderIds: [`${owner}-${slug}`],
      services: ['sharedSearch'],
      tools: ['shared_search'],
      commands: ['shared-search'],
      skills: [`${owner}-${slug}`],
      routes: [{ method: 'GET', path: '/api/shared-search' }],
      ports: [{ protocol: 'tcp', port: 43123, configurable: false }],
    },
  }
  return {
    ...base,
    ...overrides,
    plugin: { ...base.plugin, ...(overrides.plugin ?? {}) },
    compatibility: { ...base.compatibility, ...(overrides.compatibility ?? {}) },
    claims: { ...base.claims, ...(overrides.claims ?? {}) },
  }
}

async function writeEntry(registryRoot, value) {
  const [owner, slug] = value.plugin.id.split('/')
  const file = join(registryRoot, 'entries', owner, `${slug}.json`)
  await mkdir(join(registryRoot, 'entries', owner), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function runPluginRegistryChecks() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-registry-'))
  const registryRoot = join(root, 'registry')
  try {
    await mkdir(join(registryRoot, 'entries'), { recursive: true })
    const alice = manifest('alice', 'search')
    const bob = manifest('bob', 'search', {
      claims: {
        loaderIds: ['bob-search'],
        skills: ['bob-search'],
      },
    })
    await writeEntry(registryRoot, alice)
    await writeEntry(registryRoot, bob)

    const loaded = await loadRegistry(registryRoot)
    assert.deepEqual(loaded.errors, [])
    const index = createIndex(loaded.records)
    assert.deepEqual(index.plugins.map((entry) => entry.plugin.id), ['alice/search', 'bob/search'])

    const conflicts = detectClaimConflicts(index.plugins)
    for (const kind of ['commands', 'ports', 'routes', 'services', 'tools']) {
      assert(conflicts.some((entry) => entry.kind === kind), `expected ${kind} collision`)
    }
    assert(conflicts.every((entry) => entry.plugins.map((plugin) => plugin.id).includes('alice/search')))
    assert(conflicts.every((entry) => entry.plugins.map((plugin) => plugin.id).includes('bob/search')))

    await writeFile(join(registryRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
    const valid = await validateRegistry({ registryRoot, checkIndex: true })
    assert.deepEqual(valid.errors, [])

    const stale = JSON.parse(await readFile(join(registryRoot, 'index.json'), 'utf8'))
    stale.plugins = []
    await writeFile(join(registryRoot, 'index.json'), `${JSON.stringify(stale, null, 2)}\n`)
    const staleReport = await validateRegistry({ registryRoot, checkIndex: true })
    assert(staleReport.errors.some((entry) => entry.message.includes('generated index is stale')))

    const candidate = manifest('carol', 'search', {
      claims: { loaderIds: ['carol-search'], skills: ['carol-search'] },
    })
    const candidateReport = await checkManifestAgainstIndex(candidate, index, { file: 'dsh-plugin.registry.json' })
    assert.equal(candidateReport.errors.length, 0)
    const serviceConflict = candidateReport.conflicts.find((entry) => entry.kind === 'services')
    assert(serviceConflict)
    assert.deepEqual(
      serviceConflict.plugins.map((plugin) => plugin.id),
      ['alice/search', 'bob/search', 'carol/search'],
    )

    const aliceUpdate = manifest('alice', 'search', {
      plugin: { release: '2.0.0' },
      claims: { services: ['aliceSearchV2'], tools: ['alice_search_v2'], commands: ['alice-search-v2'] },
    })
    const updateReport = await checkManifestAgainstIndex(aliceUpdate, index, { file: 'dsh-plugin.registry.json' })
    assert(!updateReport.conflicts.some((entry) => entry.plugins.filter((plugin) => plugin.id === 'alice/search').length > 1))

    const aliceTrailingSlash = manifest('alice', 'search', {
      plugin: { repository: 'https://github.com/alice/search/' },
    })
    const trailingSlashReport = await checkManifestAgainstIndex(aliceTrailingSlash, index, {
      file: 'dsh-plugin.registry.json',
    })
    assert(!trailingSlashReport.conflicts.some((entry) => entry.kind === 'pluginIds'))

    const hijack = manifest('alice', 'search', { plugin: { repository: 'https://github.com/alice/not-the-owner-repo' } })
    const hijackReport = await checkManifestAgainstIndex(hijack, index, { file: 'dsh-plugin.registry.json' })
    assert(hijackReport.conflicts.some((entry) => entry.kind === 'pluginIds' && entry.severity === 'error'))
    assert.equal(checkResultExitCode(hijackReport), 1)

    assert.equal(checkResultExitCode(candidateReport), 0)
    assert.equal(checkResultExitCode(candidateReport, { strict: true }), 2)

    const search = searchIndex(index, 'service', 'sharedSearch')
    assert.equal(search.count, 2)
    assert.deepEqual(search.matches.map((entry) => entry.id), ['alice/search', 'bob/search'])

    const duplicateClaims = manifest('dora', 'search', { claims: { services: ['same', 'same'] } })
    assert(validateManifest(duplicateClaims).some((entry) => entry.message.includes('duplicates')))

    await mkdir(join(registryRoot, 'entries', 'broken'), { recursive: true })
    await writeFile(join(registryRoot, 'entries', 'broken', 'manifest.json'), '{"schemaVersion":1}\n')
    const malformedRegistry = await validateRegistry({ registryRoot })
    assert(malformedRegistry.errors.some((entry) => entry.message === 'must be an object'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  await runPluginRegistryChecks()
  console.log('Plugin registry checks OK: schema, index, advisory collisions, updates, identity, search')
}
