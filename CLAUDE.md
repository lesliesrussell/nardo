# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
bun test          # run full test suite (142 tests)
bun run dev       # type check
```

## Nardo + Beads: Mandatory In-Session Usage

This project uses nardo as its own memory system. **You must use both tools continuously throughout every session — not just at the start or end.**

### Nardo MCP — Required Usage

**Before starting any task:**
```
nardo_search("<what you're about to work on>", wing="nardo")
```

**When you discover something non-obvious** (a bug, a design decision, a gotcha, an architectural insight):
```
nardo_add_drawer(text="<discovery>", wing="nardo", room="<area>")
```

**When you establish a relationship between concepts** (X depends on Y, X replaced Y, X caused bug in Y):
```
nardo_kg_add(type="triple", subject="X", predicate="depends-on", object="Y")
```

**When search results look weak** (similarity < 0.52 triggers `room_hint`):
```
nardo_suggest_room(query="<your query>", wing="nardo")
# then re-search with room= set
```

**Rules:**
- ALWAYS search nardo before starting a task — not after
- ADD drawers for every significant discovery, fix, or design decision
- USE `nardo_list_rooms` to orient yourself when starting in an unfamiliar area
- If nardo gives a `room_hint`, follow it before concluding results are empty

### Beads — Required Usage

- Create a bead BEFORE writing code, not after
- Close beads immediately when work is complete — not in a batch at the end
- Use `bd remember` for any insight that should survive across sessions
- `bd ready` at the start of every session to pick up where you left off
