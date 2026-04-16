export interface WakeupPayload {
  palace_path: string
  wing?: string
  l0: string | null
  l1?: string
}

export function renderWakeupText(payload: WakeupPayload, quiet = false): string {
  const lines: string[] = []
  const l0 = payload.l0?.trim() || '(no identity.txt found at .nardo/identity.txt in repo root)'

  if (quiet) {
    lines.push(l0)
    return lines.join('\n')
  }

  const l1 = payload.l1?.trim() || '(no drawers yet)'
  const SEP = '=================================================='
  lines.push('Wake-up text:')
  lines.push(SEP)
  lines.push('L0 — IDENTITY')
  lines.push(l0)
  lines.push('')
  lines.push('L1 — ESSENTIAL STORY')
  lines.push(l1)
  lines.push(SEP)
  return lines.join('\n')
}
