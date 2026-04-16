// Importance auto-scorer — computes a 0.1–1.0 importance score from text content.
//
// Why: importance was previously hardcoded to 0.5/1.0, meaning L1 wake-up could not
// distinguish signal from noise. This module scores four content-based signals so that
// drawers rich in named entities, decisions, and structure surface first in L1.
//
// Two scoring paths:
//   Prose path (markdown, notes, decisions):
//     entity density · length · decision verbs · structure
//   Code path (source files detected by content patterns):
//     export density · symbol density · length · code structure

import { detectEntities } from '../entity/detector.js'

// Words that signal a drawer contains a decision, discovery, or lesson learned
const DECISION_RE = /\b(decided|chose|switched|fixed|implemented|discovered|learned|realized|concluded|designed|solved|resolved|identified|found|understood|recognized|replaced|migrated|refactored)\b/gi

// Heuristic: content looks like source code if it has import/export/function/class declarations
// but is NOT a markdown document (markdown with code fences goes through the prose path)
function isSourceCode(text: string): boolean {
  if (/^#{1,3}\s/m.test(text)) return false  // markdown headers → prose path
  return /(?:^|\n)(?:export|import|function|class|const|interface|type|enum|async)\s+\w/m.test(text)
}

function entityDensityScore(text: string): number {
  const len = text.length
  if (len < 20) return 0

  const entities = detectEntities(text)
  const totalOccurrences = entities.reduce((sum, e) => sum + e.occurrences, 0)
  const density = totalOccurrences / Math.max(len / 100, 1)
  return Math.min(density / 3, 1.0)
}

function lengthScore(len: number): number {
  if (len < 100)  return 0.2
  if (len < 200)  return 0.5
  if (len < 800)  return 1.0
  if (len < 2000) return 0.8
  return 0.65
}

function decisionScore(text: string): number {
  const hits = (text.match(DECISION_RE) ?? []).length
  return Math.min(hits * 0.25, 1.0)
}

function structureScore(text: string): number {
  const hasHeader       = /^#{1,3}\s/m.test(text) ? 0.5 : 0
  const hasCode         = /```/.test(text) ? 0.3 : 0
  const hasNumberedList = /^\s*\d+\.\s/m.test(text) ? 0.2 : 0
  return Math.min(hasHeader + hasCode + hasNumberedList, 1.0)
}

/**
 * Score source code chunks by how much substance they define.
 * - Each exported symbol: +0.25 (exports are the public API surface)
 * - Each function/method definition: +0.10 (implementation density)
 * - Each class/interface definition: +0.20 (structural complexity)
 * - JSDoc/block comments: +0.15 (documented = intentional)
 * Capped at 1.0.
 */
function codeSignalScore(text: string): number {
  const exports   = (text.match(/\bexport\s+(?:async\s+)?(?:function|class|const|interface|type|enum|default)\b/g) ?? []).length
  const functions = (text.match(/\b(?:function\s+\w|=>\s*\{|async\s+function\s+\w)\b/g) ?? []).length
  const classes   = (text.match(/\b(?:class|interface)\s+\w/g) ?? []).length
  const jsdoc     = /\/\*\*[\s\S]*?\*\//.test(text) ? 1 : 0

  return Math.min(exports * 0.25 + Math.min(functions, 5) * 0.10 + classes * 0.20 + jsdoc * 0.15, 1.0)
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

  if (isSourceCode(text)) {
    // Code path: weight symbol density and length; ignore prose-only signals
    const score =
      0.40 * codeSignalScore(text) +
      0.30 * lengthScore(len) +
      0.20 * decisionScore(text) +   // still rewards commented decisions
      0.10 * entityDensityScore(text)
    return Math.max(0.1, Math.min(1.0, score))
  }

  // Prose path (notes, decisions, markdown)
  const score =
    0.35 * entityDensityScore(text) +
    0.30 * lengthScore(len) +
    0.25 * decisionScore(text) +
    0.10 * structureScore(text)

  return Math.max(0.1, Math.min(1.0, score))
}
