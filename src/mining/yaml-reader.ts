import { load } from 'js-yaml'
import { join } from 'path'

export interface NardoYaml {
  wing: string
  rooms: Record<string, { keywords: string[] }>
}

export async function readNardoYaml(dir: string): Promise<NardoYaml | null> {
  const filePath = join(dir, 'nardo.yaml')
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) return null

  const text = await file.text()
  const parsed = load(text)

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('wing' in (parsed as object)) ||
    !('rooms' in (parsed as object))
  ) {
    return null
  }

  return parsed as NardoYaml
}
