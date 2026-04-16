import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

export interface EntityRecord {
  type: 'person' | 'project' | 'concept' | 'place' | 'unknown'
  confidence: number
  source: 'onboarding' | 'learned' | 'researched'
  properties?: Record<string, unknown>
}

const SOURCE_PRECEDENCE: Record<EntityRecord['source'], number> = {
  onboarding: 3,
  learned: 2,
  researched: 1,
}

export class EntityRegistry {
  private path: string
  private data: Map<string, EntityRecord> = new Map()

  constructor(registry_path: string) {
    this.path = registry_path
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, EntityRecord>
      this.data = new Map(Object.entries(parsed))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Create missing file
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(this.path, '{}', 'utf-8')
        this.data = new Map()
      } else {
        throw err
      }
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const obj: Record<string, EntityRecord> = {}
    for (const [name, record] of this.data) {
      obj[name] = record
    }
    await writeFile(this.path, JSON.stringify(obj, null, 2), 'utf-8')
  }

  get(name: string): EntityRecord | null {
    return this.data.get(name.toLowerCase()) ?? null
  }

  set(name: string, record: EntityRecord): void {
    this.data.set(name.toLowerCase(), record)
  }

  list(): Array<{ name: string } & EntityRecord> {
    return Array.from(this.data.entries()).map(([name, record]) => ({
      name,
      ...record,
    }))
  }

  merge(name: string, record: EntityRecord): void {
    const key = name.toLowerCase()
    const existing = this.data.get(key)
    if (!existing) {
      this.data.set(key, record)
      return
    }
    if (SOURCE_PRECEDENCE[existing.source] >= SOURCE_PRECEDENCE[record.source]) {
      // Keep existing — higher or equal precedence
      return
    }
    this.data.set(key, record)
  }
}
