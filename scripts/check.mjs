#!/usr/bin/env node
/**
 * Lightweight repository check for CI and contributors.
 *
 * - validates package.json and required files
 * - runs `node --check` on both plugin halves
 * - runs the contract test (no DSH runtime required)
 *
 * Usage: node scripts/check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const failures = []

function check(condition, message) {
  if (condition) {
    console.log(`  ok  ${message}`)
  } else {
    failures.push(message)
    console.error(`  FAIL ${message}`)
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  return result.status === 0
}

console.log('package.json')
let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(true, 'parses as JSON')
} catch (error) {
  check(false, `parses as JSON (${error.message})`)
}
if (pkg !== null) {
  check(pkg.name === 'dsh-quote-ask', 'name is dsh-quote-ask')
  check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), `version is semver-ish (${pkg.version})`)
  check(pkg.type === 'module', 'type is module')
  check(Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), 'declares dsh.bundle.patch')
  check(Boolean(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web'), 'declares a web client')
  check(typeof pkg.engines.dsh === 'string', 'declares engines.dsh')
}

console.log('required files')
for (const file of ['lib/index.js', 'lib/client/index.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'README.md', 'LICENSE']) {
  check(existsSync(join(root, file)), file)
}

console.log('syntax')
check(run(process.execPath, ['--check', join(root, 'lib/index.js')]), 'lib/index.js')
check(run(process.execPath, ['--check', join(root, 'lib/client/index.js')]), 'lib/client/index.js')

console.log('contract test')
check(run(process.execPath, [join(root, 'test/verify.mjs')]), 'test/verify.mjs')

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed.')
}
