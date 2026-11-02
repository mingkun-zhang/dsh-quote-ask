#!/usr/bin/env node
/**
 * Replace the YOUR_GITHUB_USERNAME placeholders after creating the repository.
 *
 * Usage:
 *   node scripts/set-repo-owner.mjs <github-username> [repository-name]
 *
 * The optional repository name defaults to "dsh-quote-ask". The plugin package
 * name itself stays "dsh-quote-ask"; only the GitHub URLs are changed.
 *
 * This changes package.json, README.md and README.en.md only. It does not talk
 * to GitHub or push anything.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const owner = process.argv[2]
const repoName = process.argv[3] || 'dsh-quote-ask'
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/

if (!owner || !ownerPattern.test(owner)) {
  console.error('Usage: node scripts/set-repo-owner.mjs <github-username> [repository-name]')
  console.error('GitHub usernames contain only letters, digits and hyphens (max 39 chars).')
  process.exit(1)
}
if (!repoPattern.test(repoName)) {
  console.error('Repository names may contain letters, digits, dots, underscores and hyphens.')
  process.exit(1)
}

const replacements = [
  ['YOUR_GITHUB_USERNAME/dsh-quote-ask', `${owner}/${repoName}`],
  ['github.com/YOUR_GITHUB_USERNAME/dsh-quote-ask', `github.com/${owner}/${repoName}`],
  ['YOUR_GITHUB_USERNAME', owner],
]

const files = ['package.json', 'README.md', 'README.en.md']
let changed = 0
for (const file of files) {
  const path = join(process.cwd(), file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`)
    process.exit(1)
  }
  let next = text
  for (const [from, to] of replacements) next = next.split(from).join(to)
  if (next !== text) {
    writeFileSync(path, next, 'utf8')
    changed += 1
    console.log(`updated ${file}`)
  } else {
    console.log(`no placeholder in ${file}`)
  }
}

console.log(changed === 0 ? 'Nothing to change.' : `Done. Repository set to ${owner}/${repoName}.`)
console.log(`Next: git remote add origin https://github.com/${owner}/${repoName}.git`)
