// L0 identity loader
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export async function loadL0(identity_path?: string): Promise<string | null> {
  const filePath = identity_path ?? join(homedir(), '.nardo', 'identity.txt')
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}
