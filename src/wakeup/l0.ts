// L0 identity loader
import { readFileSync } from 'fs'
import { join } from 'path'
import { findRepoRoot } from '../config.js'

export async function loadL0(identity_path?: string): Promise<string | null> {
  let filePath = identity_path
  if (!filePath) {
    const repoRoot = findRepoRoot()
    if (!repoRoot) return null
    filePath = join(repoRoot, '.nardo', 'identity.txt')
  }
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}
