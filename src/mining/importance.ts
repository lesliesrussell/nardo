// Importance auto-scorer — computes a 0.1–1.0 importance score from text content.
//
// Why: importance was previously hardcoded to 0.5/1.0, meaning L1 wake-up could not
// distinguish signal from noise. This module scores four content-based signals so that
// drawers rich in named entities, decisions, and structure surface first in L1.
//
// Signals (all computable at mine-time, no KG or embeddings needed):
//   1. Entity density   — named entities per 100 chars (weight 0.35)
//   2. Length           — sweet spot 200-800 chars (weight 0.30)
//   3. Decision verbs   — action/insight words indicating knowledge (weight 0.25)
//   4. Structure        — headers, code blocks, numbered lists (weight 0.10)

import { detectEntities } from '../entity/detector.js'

// Words that signal a drawer contains a decision, discovery, or lesson learned
const DECISION_RE = /\b(decided|chose|switched|fixed|implemented|discovered|learned|realized|concluded|designed|solved|resolved|identified|found|understood|recognized|replaced|migrated|refactored)\b/gi

function entityDensityScore(text: string): number {
  const len = text.length
  if (len < 20) return 0

  const entities = detectEntities(text)
  // Sum total occurrences of all detected entities
  const totalOccurrences = entities.reduce((sum, e) => sum + e.occurrences, 0)
  // Normalize: 3 entity-occurrences per 100 chars → score 1.0
  const density = totalOccurrences / Math.max(len / 100, 1)
  return Math.min(density / 3, 1.0)
}

function lengthScore(len: number): number {
  if (len < 100)       return 0.2
  if (len < 200)       return 0.5
  if (len < 800)       return 1.0
  if (len < 2000)      return 0.8
  return 0.65
}

function decisionScore(text: string): number {
  const hits = (text.match(DECISION_RE) ?? []).length
  // Each decision verb adds 0.25; cap at 1.0
  return Math.min(hits * 0.25, 1.0)
}

function structureScore(text: string): number {
  const hasHeader       = /^#{1,3}\s/m.test(text) ? 0.5 : 0
  const hasCode         = /```/.test(text) ? 0.3 : 0
  const hasNumberedList = /^\s*\d+\.\s/m.test(text) ? 0.2 : 0
  return Math.min(hasHeader + hasCode + hasNumberedList, 1.0)
}

/**
 * Compute an importance score in [0.1, 1.0] from the drawer's text content.
 *
 * Used by the file miner at index-time so that L1 wake-up surfaces genuinely
 * important drawers without manual tuning.
 */
export function computeImportance(text: string): number {
  const len = text.trim().length
  if (len < 20) return 0.1

  const score =
    0.35 * entityDensityScore(text) +
    0.30 * lengthScore(len) +
    0.25 * decisionScore(text) +
    0.10 * structureScore(text)

  return Math.max(0.1, Math.min(1.0, score))
}
