# nardo

Local-first memory system for AI agents. 100% verbatim recall, zero API dependency, privacy by architecture.

**Core features:**
- Verbatim storage of all content (no summarization, no lossy compression)
- Local-first architecture with zero cloud dependency
- Incremental append-only persistence
- Semantic and keyword search with hybrid ranking
- Temporal knowledge graphs with time-aware relationships
- Background mining pipeline with entity detection
- Token-efficient MCP transport: pointer mode, token-budgeted wake-up, content-addressed L1 cache

## Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Runtime** | Bun | Native TypeScript, built-in test runner, `bun:sqlite` |
| **Language** | TypeScript | Type safety, first-class MCP SDK support |
| **Vector Store** | hnswlib-node | HNSW cosine index (custom SQLite integration) |
| **Embeddings** | @xenova/transformers / ollama | Default: Xenova/all-MiniLM-L6-v2 384-dim (bundled). Recommended upgrade: ollama nomic-embed-text 768-dim |
| **Knowledge Graph** | bun:sqlite | Embedded temporal KG, zero ops |
| **MCP Server** | @modelcontextprotocol/sdk | Claude-native memory interface |
| **CLI** | commander | Command-line interface |

## Installation

### Prerequisites

- Bun >= 1.0.0 ([install](https://bun.sh))
- macOS/Linux: Xcode CLT or build-essential (required by `hnswlib-node` native bindings)
- **Optional upgrade**: [ollama](https://ollama.com) with `nomic-embed-text` for higher-quality 768-dim embeddings:
  ```bash
  ollama pull nomic-embed-text
  ```
  Without ollama, nardo uses the bundled Xenova/all-MiniLM-L6-v2 model (384-dim, ~150MB download on first run, stored in `~/.cache/huggingface/`). This is the default.

### Install from npm (recommended)

```bash
bun add -g nardo
# or
npm install -g nardo

# Verify
nardo --version
```

### Install from git

```bash
bun add -g github:lesliesrussell/nardo
# or
npm install -g github:lesliesrussell/nardo
```

### Install from source (contributors)

```bash
git clone https://github.com/lesliesrussell/nardo.git
cd nardo
bun install
bun link

# Verify
nardo status
```

> **Uninstall**: `bun remove -g nardo` or `npm uninstall -g nardo`.

## Quick Start

### 1. Mine a Project

Index a codebase or text project into the palace:

```bash
nardo mine ~/my_project --wing my_project
```

Options:
- `--palace <path>`: Override palace location. Default is `.nardo/palace` in the current git repo. nardo requires a git repository.
- `--wing <name>`: Category name (defaults to project name)
- `--limit <n>`: Mine only first N files
- `--dry-run`: Preview without writing
- `--no-gitignore`: Ignore .gitignore patterns

Create a `.nardoignore` file in the project root to exclude files from mining (same syntax as `.gitignore`, takes precedence over `.gitignore`).

### 2. Search the Palace

Semantic search across all mined content:

```bash
nardo search "why did we switch databases"
```

Options:
- `--wing <name>`: Limit to specific category
- `--room <name>`: Limit to specific subcategory
- `--limit <n>`: Max results (default 5)

### 3. Connect Claude Code to nardo

**One-time global setup** (run once after installing nardo):

```bash
nardo install-hooks    # installs wake-up hook + registers nardo as global MCP server
```

**Per-project setup** (run once in each repo you want nardo active):

```bash
nardo setup            # injects wake-up hook into this project's .claude/settings.json
```

Then restart Claude Code. nardo tools (`nardo_search`, `nardo_add_drawer`, `nardo_kg_query`, etc.) will be available in every session, and L0+L1 wake-up context loads automatically on start.

> **How it works:** `install-hooks` registers nardo globally via `claude mcp add --scope user`. `setup` runs `claude mcp add --scope local` to register nardo in that project's entry in `~/.claude.json` — needed because Claude Code's per-project entry overrides the global `mcpServers` when it exists.
>
> **Why not just `settings.json`?** Claude Code reads MCP servers from `~/.claude.json`, not `settings.json`. The `mcpServers` key in `settings.json` is silently ignored.

**Manual alternative:**

```bash
# Register MCP server globally:
claude mcp add --scope user nardo $(which nardo) -- mcp --serve

# Install the session-start hook:
nardo install-hooks
```

## CLI Reference

| Command | Purpose | Example |
|---------|---------|---------|
| `mine <path>` | Index files, conversations, or stdin (-) | `nardo mine ~/project --wing mywork` |
| `mine-beads` | Ingest beads issues into palace | `nardo mine-beads --watch` |
| `mine-url <url>` | Fetch webpage and mine into palace | `nardo mine-url https://docs.example.com` |
| `mine-git [repo]` | Mine git commit history | `nardo mine-git . --with-diffs` |
| `search <query>` | Semantic + keyword hybrid search | `nardo search "authentication logic"` |
| `status` | Show palace statistics | `nardo status` |
| `palace-stats` | Detailed storage health report | `nardo palace-stats` |
| `compact` | Rebuild HNSW, remove tombstones | `nardo compact` |
| `export` | Export all drawers to JSONL | `nardo export > backup.jsonl` |
| `import` | Import drawers from JSONL | `nardo import backup.jsonl` |
| `init <path>` | Initialize project metadata and default config | `nardo init .` |
| `wake-up` | Load memory layers (L0-L3) | `nardo wake-up` |
| `dashboard start` | Start the web dashboard as a background daemon | `nardo dashboard start` |
| `dashboard start --foreground` | Start dashboard in foreground (Ctrl+C to stop) | `nardo dashboard start --foreground --port 8080` |
| `dashboard stop` | Stop the running dashboard daemon | `nardo dashboard stop` |
| `install-hooks` | One-time global hook + MCP setup | `nardo install-hooks` |
| `install-mcp` | Register nardo as global MCP server | `nardo install-mcp` |
| `setup` | Per-project setup (injects hook + local MCP) | `nardo setup` |
| `mcp --serve` | Start MCP server (stdio) | `nardo mcp --serve` |
| `repair` | Interactive palace repair | `nardo repair` |
| `dedup` | Remove near-duplicate drawers | `nardo dedup --threshold 0.15` |
| `forget` | Delete drawers by filter | `nardo forget --source-file myfile.txt --dry-run` |
| `add-drawer` | Manual drawer insertion | `nardo add-drawer --wing w --room r` |
| `diary` | Add timestamped diary entry | `nardo diary "Shipped v2"` |
| `watch` | Watch directory for changes | `nardo watch ~/project` |
| `split` | Split large drawers | `nardo split` |
| `migrate` | Schema migration utility | `nardo migrate` |
| `reembed` | Re-embed all drawers with the current model, rebuilding HNSW indexes | `nardo reembed` |

### Mining from stdin

Pipe any text directly into the palace:

```bash
# Pipe any text directly into the palace
echo "Meeting notes: decided to use HNSW" | nardo mine - --wing meetings
cat report.txt | nardo mine - --wing research --room reports
```

## MCP Tools Reference

The MCP server exposes these tools for Claude Code and other MCP clients:

### Read Tools

| Tool | Description |
|------|-------------|
| `nardo_status` | Show palace statistics (drawer count, wings, rooms) |
| `nardo_list_wings` | List all wings in the palace |
| `nardo_list_rooms` | List rooms, optionally filtered by wing |
| `nardo_search` | Semantic + keyword hybrid search with MMR, query expansion, federation. Supports `mode='pointer'` for metadata-only results (no text body). |
| `nardo_summarize` | Prose summary with source citations from top passages |
| `nardo_search_batch` | Parallel multi-query search with deduplication merge |
| `nardo_suggest_room` | Suggest best room for a text snippet within a wing |
| `nardo_get_taxonomy` | Retrieve wing/room hierarchy |

### Write Tools

| Tool | Description |
|------|-------------|
| `nardo_add_drawer` | Insert new content into a wing/room |
| `nardo_delete_drawer` | Remove a drawer by ID |

### Knowledge Graph Tools

| Tool | Description |
|------|-------------|
| `nardo_kg_query` | Query temporal triples (relationships) |
| `nardo_kg_add` | Add entity or triple to knowledge graph |
| `nardo_kg_invalidate` | Mark triple as invalid (soft delete) |

### Maintenance Tools

| Tool | Description |
|------|-------------|
| `nardo_reconnect` | Reconnect to palace after connection loss |
| `nardo_check_duplicate` | Check whether content is a near-duplicate of an existing drawer before adding |

## Token Efficiency

nardo is designed to keep prompt payloads small without sacrificing verbatim recall. Three mechanisms work together:

### 1. Pointer mode for MCP search

`nardo_search` accepts a `mode` parameter:

| Mode | What's returned | When to use |
|------|----------------|-------------|
| `full` (default) | Complete results including text body | When you need to read the content |
| `pointer` | Metadata only: `id`, `wing`, `room`, `source_file`, `similarity`, `importance`, `filed_at` | Exploratory queries — scan what exists before deciding what to expand |

Pointer mode is most valuable in multi-step workflows. An agent can run a broad `pointer` search, pick the two or three most relevant results by metadata, then call `nardo_search` again on those specific IDs (or use `nardo_summarize`) to retrieve only what it needs. This avoids loading hundreds of tokens of drawer text for results the agent would have discarded anyway.

```json
{ "tool": "nardo_search", "query": "auth middleware", "mode": "pointer" }
```

### 2. Token-budgeted L1 wake-up

L1 adds items until the token budget is exhausted, then stops — it never cuts mid-item. This produces a stable, predictable output size instead of a character-sliced fragment. The default is 800 tokens, tunable per session:

```bash
nardo wake-up --token-budget 400   # tighter budget for short sessions
nardo wake-up --token-budget 1600  # more context for deep work
```

Token estimation uses the standard `ceil(chars / 4)` approximation, which is accurate enough for budget enforcement without requiring a tokenizer dependency.

### 3. Content-addressed L1 cache

L1 output is cached at `.nardo/palace/l1_cache.json`. The cache key is a SHA-256 hash over the sorted top-N drawer fingerprints (`source_file:chunk_index:importance`). When the underlying drawers haven't changed, every `nardo wake-up` call returns byte-identical output.

This matters because Claude's API applies a ~90% token discount to repeated prompt prefixes via prompt caching. A stable L1 output at the start of every session context means nardo's wake-up cost approaches zero on subsequent turns once the prefix is cached. The cache write is fire-and-forget; a write failure falls back to regenerating cleanly.

### How the three work together

A typical efficient workflow:
1. Session starts → `nardo wake-up` emits L0 + token-budgeted L1 (cache hit → same text → Claude API prompt cache hit)
2. Agent needs to find relevant memory → `nardo_search mode='pointer'` → scan metadata, ~10× fewer tokens than full results
3. Agent selects 1-2 relevant drawers → `nardo_search` with `room=` filter on those specific entries → full text only for what's needed
4. Deep recall needed → `nardo_summarize` or direct search — verbatim content always available, never degraded

## Architecture

### Palace Hierarchy

nardo organizes content in four levels:

```
WING (Category, e.g., "my_project", "personal_notes")
  └── ROOM (Subcategory, e.g., "architecture", "bugs")
        └── DRAWER (Chunk of verbatim content, 50-100k chars)
              └── TEXT (Verbatim content, immutable)
```

**WING**: Project or topic category (128 char max, alphanumeric + spaces/dots/hyphens).

**ROOM**: Subcategory within a wing. Auto-detected from directory structure. `src/search/` → room `search`, `tests/` → room `tests`. No configuration required.

**DRAWER**: Immutable chunk identified by content hash. Metadata per drawer:
- `wing`, `room`: Hierarchy
- `source_file`: Original file path
- `source_mtime`: File modification time (for re-mining detection)
- `chunk_index`: Position in source
- `filed_at`: ISO timestamp
- `importance`: Weight (0.0-1.0+)
- `ingest_mode`: How ingested (`project`, `convo`, `diary`, `registry`)

### Storage

```
.nardo/
├── palace/
│   ├── palace.sqlite3        # Drawers + closets + FTS5 index
│   ├── drawers.hnsw          # HNSW vector index for drawers
│   ├── closets.hnsw          # HNSW vector index for closets
│   └── kg.db                 # Temporal knowledge graph
└── wal/
    └── write_log.jsonl
```

### Closets and Knowledge Graph

**Closets**: Compressed topic/entity indices pointing to drawers. Live in a separate HNSW index for fast ranking signals.

**Knowledge Graph**: SQLite schema with three tables:
- **entities**: Canonical names (people, projects, concepts)
- **triples**: Temporal relationships (subject → predicate → object) with valid_from/valid_to dates
- **attributes**: Entity attributes (gender, birthday, etc.)

Example triple:
```sql
INSERT INTO triples 
  (subject, predicate, object, valid_from, valid_to)
VALUES 
  ('alice', 'leads', 'project_x', '2024-01-01', NULL);
```

### Memory Wake-up Stack (Layers L0-L3)

**Layer 0**: Identity (~100 tokens). User-written identity in `.nardo/identity.txt` at the repo root.

**Layer 1**: Essential Story (token-budgeted, default 800 tokens). Top 15 most-important drawers, grouped by room. Items are added whole — no mid-item cuts when the budget is reached. Output is content-addressed cached at `.nardo/palace/l1_cache.json`; unchanged drawers produce identical text across calls, enabling Claude API prompt caching at session boundaries.

**Layer 2**: On-Demand Retrieval (~500 tokens per call). Fetch drawers from a specific wing/room.

**Layer 3**: Deep Search (unlimited). Semantic search with optional wing/room filter.

Load via CLI:
```bash
nardo wake-up
```

Options:
- `--wing <name>`: Filter L1 context to specific wing
- `--palace <path>`: Override palace location
- `--token-budget <n>`: Max tokens for L1 output (default 800)

### Hybrid Search Scoring

The search system combines multiple ranking signals with **query-adaptive weights**:

| Query type | Detection | Vector | BM25 | Importance |
|---|---|---|---|---|
| Keyword | ≤3 words, camelCase/snake_case, or quoted phrase | 35% | 55% | 10% |
| Semantic | ≥6 words or question words (how/why/what/…) | 65% | 25% | 10% |
| Default | everything else | 55% | 35% | 10% |

**Closet boost**: When a file-level summary (closet) matches the query, drawers from that file receive a rank-based boost scaled by closet match quality: `RANK_BOOSTS[rank] × (1 − closet_distance)`.

**Retrieval tracking**: Every drawer that appears in search results has its `retrieval_count` incremented automatically. Context window inclusion is the usage signal — it influences the agent regardless of explicit action.

**Usage-protected importance decay**: Importance decays with age, but retrieval history counteracts that decay:
```
effective_age    = days_old / (1 + retrieval_count × retrieval_weight)
decayed_importance = importance × 1 / (1 + effective_age / halflife)
```
Defaults: `halflife=90` days, `retrieval_weight=0.3`. A drawer retrieved 10 times decays ~4× slower. Never-retrieved drawers follow the normal schedule. Set `decay_halflife=0` to disable.

**MMR Reranking**: Control diversity with `mmr_lambda` parameter (0.0–1.0, default 0.7):
- 1.0 = pure relevance
- 0.7 = balanced (default)
- 0.0 = pure diversity

**Query expansion**: Terse queries are automatically expanded with synonyms before embedding. E.g. `auth` embeds as `auth authentication login jwt session token oauth`. BM25 still uses the original query for precision. Disable with `expand: false`.

**Cross-wing federation**: Set `federated: true` to search all wings regardless of the `wing` filter. Each result is tagged with its origin wing. Useful for "search everything I know about X" queries.

## Hook Setup

nardo integrates with Claude Code hooks to load memory context at the start of each session.

### SessionStart Hook

**File**: `~/.claude/hooks/nardo_wakeup.sh`

**Trigger**: When a Claude Code session starts

**What it does**: Reads the current git repo, finds the palace, and calls `nardo wake-up` to load L0+L1 memory context into the session.

Install automatically with:
```bash
nardo install-hooks
```

### PreCompact Hook

**File**: `~/.claude/hooks/mempal_precompact_hook.sh`

**Trigger**: Before Claude Code state compression

**Purpose**: Save session state to a drawer before compaction to preserve context.

## Configuration

Location: `.nardo/config.json` in the repo root (optional — most settings have sensible defaults).

```json
{
  "palace_path": "/absolute/path/when-you-want-an-explicit-override",
  "collection_name": "nardo_drawers",
  "topic_wings": [
    "emotions",
    "consciousness",
    "memory",
    "technical",
    "identity",
    "family",
    "creative"
  ],
  "embedding": {
    "provider": "xenova",
    "model": "nomic-embed-text",
    "ollama_url": "http://localhost:11434"
  },
  "hooks": {
    "silent_save": true,
    "desktop_toast": false
  }
}
```

### Config Properties

| Property | Type | Default | Notes |
|----------|------|---------|-------|
| `palace_path` | string | `repo-local .nardo/palace (requires git repo)` | Optional explicit override |
| `collection_name` | string | `nardo_drawers` | Main collection name |
| `topic_wings` | array | 7 defaults | Default wing categories |
| `embedding.provider` | string | `xenova` | `xenova` (default, bundled) or `ollama` (recommended upgrade) |
| `embedding.model` | string | `nomic-embed-text` | Model name for ollama |
| `embedding.ollama_url` | string | `http://localhost:11434` | ollama server URL |
| `hooks.silent_save` | bool | `true` | Save directly or call MCP |
| `hooks.desktop_toast` | bool | `false` | Show desktop notifications |

### Environment Variables

Override palace path via environment:
```bash
export NARDO_PALACE_PATH=/custom/path
nardo status
```

This is the main escape hatch when you want a shared or global palace.
Without `NARDO_PALACE_PATH`, nardo uses `.nardo/palace` in the current git repo. Running outside a git repo is an error.

## Deduplication

Remove near-duplicate drawers with:

```bash
nardo dedup --threshold 0.15
```

Algorithm:
1. Group drawers by source_file
2. Score pairwise similarity within each group (cosine distance < threshold)
3. Keep longest drawer from each duplicate cluster
4. Delete marked duplicates

Threshold default: 0.15 (configurable, lower = stricter dedup).

## Export & Import

Back up or migrate the palace:

```bash
nardo export > backup.jsonl           # Export all drawers
nardo export --wing git > git.jsonl   # Export one wing
nardo import backup.jsonl             # Restore into current palace
nardo import backup.jsonl --palace /path/to/other/palace  # Restore elsewhere
```

Format: JSONL with base64-encoded Float32Array embeddings. SHA-256 deduplication on import prevents duplicates.

## Repair

Recover from corruption or missing metadata:

```bash
nardo repair
```

Interactive mode prompts for:
- Verify drawer integrity
- Rebuild indices
- Clean up invalid pointers
- Restore from backup

## Development

### Run Tests

```bash
bun test
```

### Run CLI in Dev Mode

```bash
nardo <command>
```

### Run Entry Point

`bun run dev` runs `src/index.ts` directly. There is no separate typecheck script — TypeScript type errors surface via the LSP or at runtime under Bun.

### Build

No build step required. Bun executes TypeScript directly.

### Project Structure

```
src/
├── cli/                    # Command-line interface
│   ├── commands/           # Individual command implementations
│   └── index.ts            # Commander setup
├── mcp/                    # MCP server
│   ├── tools/              # Tool implementations (read, write, kg, maintenance)
│   └── server.ts           # MCP server entry
├── palace/                 # Core palace client
│   ├── client.ts           # Palace connection
│   ├── drawers.ts          # Drawer operations
│   └── repair.ts           # Repair utilities
├── mining/                 # Content ingestion pipeline
│   ├── file-miner.ts       # File mining
│   ├── convo-miner.ts      # Conversation mining
│   ├── chunker.ts          # Text chunking
│   └── room-detector.ts    # Room/topic detection
├── search/                 # Search engine
│   ├── hybrid.ts           # BM25 + vector hybrid search
│   ├── mmr.ts              # MMR reranking
│   ├── expander.ts         # Query expansion (synonym map)
│   ├── bm25.ts             # Keyword ranking
│   ├── dedup.ts            # Deduplication
│   └── sanitizer.ts        # Query cleaning
├── embeddings/             # Vector embeddings
│   └── pipeline.ts         # @xenova/transformers wrapper
├── entity/                 # Entity detection & registry
│   ├── detector.ts         # NER pipeline
│   ├── registry.ts         # Entity canonicalization
│   └── wikipedia.ts        # Entity disambiguation
├── kg/                     # Knowledge graph
│   ├── graph.ts            # Triple CRUD
│   └── ddl.ts              # Schema and migrations
├── wakeup/                 # Memory layers
│   ├── l0.ts               # Identity layer
│   ├── l1.ts               # Essential story
│   ├── l2.ts               # On-demand retrieval
│   └── l3.ts               # Deep search
├── config.ts               # Configuration loader
├── wal.ts                  # Write-ahead log
└── index.ts                # Main entry
```

## Integrations

### pi-coding-agent

A nardo extension for [pi-coding-agent](https://github.com/badlogic/pi-mono) is included at `integrations/pi/nardo.ts`.

**What it does:**
- Loads nardo wake-up context (L0+L1 memory) at session start
- Auto-searches nardo before each agent turn and injects relevant context
- Adds slash commands: `/nardo:search`, `/nardo:add`, `/nardo:status`, `/nardo:wake`, `/nardo:help`

**Install:**
```bash
cp integrations/pi/nardo.ts ~/.pi/agent/extensions/nardo.ts
```

Or install the whole nardo package into pi:
```bash
pi install /path/to/nardo
```

## Limitations and Future Work

- **Single-region**: Palace is single-machine. Multi-region sync planned.
- **Entity resolution**: Basic duplicate detection; full reconciliation pending.
- **Access control**: No built-in RLS; privacy enforced via file permissions.

## License

MIT
