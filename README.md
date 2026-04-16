# nardo

Local-first memory system for AI agents. 100% verbatim recall, zero API dependency, privacy by architecture.

**Core features:**
- Verbatim storage of all content (no summarization, no lossy compression)
- Local-first architecture with zero cloud dependency
- Incremental append-only persistence
- Semantic and keyword search with hybrid ranking
- Temporal knowledge graphs with time-aware relationships
- Background mining pipeline with entity detection

## Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Runtime** | Bun | Native TypeScript, built-in test runner, `bun:sqlite` |
| **Language** | TypeScript | Type safety, first-class MCP SDK support |
| **Vector Store** | hnswlib-node | HNSW cosine index (custom SQLite integration) |
| **Embeddings** | @xenova/transformers | Local ONNX runtime (Xenova/all-MiniLM-L6-v2) |
| **Knowledge Graph** | bun:sqlite | Embedded temporal KG, zero ops |
| **MCP Server** | @modelcontextprotocol/sdk | Claude-native memory interface |
| **CLI** | commander | Command-line interface |

## Installation

### Prerequisites

- Bun >= 1.0.0 ([install](https://bun.sh))
- 2GB+ disk space (for embeddings model cache)
- macOS/Linux: Xcode CLT or build-essential (required by `hnswlib-node` native bindings)

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

On first run, the embedding model downloads to `~/.cache/huggingface/` (~150MB, one-time).

> **Uninstall**: `bun remove -g nardo` or `npm uninstall -g nardo`.

## Quick Start

### 1. Mine a Project

Index a codebase or text project into the palace:

```bash
nardo mine ~/my_project --wing my_project
```

Options:
- `--palace <path>`: Override palace location. Default is `.nardo/palace` in the current git repo, or `~/.nardo/palace` outside a repo.
- `--wing <name>`: Category name (defaults to project name)
- `--limit <n>`: Mine only first N files
- `--dry-run`: Preview without writing
- `--no-gitignore`: Ignore .gitignore patterns

### 2. Search the Palace

Semantic search across all mined content:

```bash
nardo search "why did we switch databases"
```

Options:
- `--wing <name>`: Limit to specific category
- `--room <name>`: Limit to specific subcategory
- `--limit <n>`: Max results (default 10)

### 3. Run the MCP Server

Expose the palace as an MCP server for Claude Code:

```bash
nardo mcp
```

Claude can then use tools like `nardo_search`, `nardo_add_drawer`, and `nardo_kg_query`.

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
| `init <path>` | Initialize a new palace | `nardo init ~/.nardo/custom` |
| `wake-up` | Load memory layers (L0-L3) | `nardo wake-up` |
| `mcp` | Start MCP server | `nardo mcp` |
| `repair` | Interactive palace repair | `nardo repair` |
| `dedup` | Remove near-duplicate drawers | `nardo dedup --threshold 0.15` |
| `forget` | Delete drawers by filter | `nardo forget --source myfile.txt` |
| `add-drawer` | Manual drawer insertion | `nardo add-drawer --wing w --room r` |
| `diary` | Add timestamped diary entry | `nardo diary "Shipped v2"` |
| `watch` | Watch directory for changes | `nardo watch ~/project` |
| `split` | Split large drawers | `nardo split` |
| `migrate` | Schema migration utility | `nardo migrate` |

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
| `nardo_search` | Semantic + keyword hybrid search with MMR, query expansion, federation |
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

**ROOM**: Subcategory within a wing. Detected automatically from folder structure or via `nardo.yaml`.

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
~/.nardo/
├── palace/
│   ├── palace.sqlite3        # Drawers + closets + FTS5 index
│   ├── drawers.hnsw          # HNSW vector index for drawers
│   ├── closets.hnsw          # HNSW vector index for closets
│   └── kg.db                 # Temporal knowledge graph
├── config.json
├── identity.txt
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

**Layer 0**: Identity (~100 tokens). User-written identity in `~/.nardo/identity.txt`.

**Layer 1**: Essential Story (~800 tokens). Top 15 most-important drawers from the palace, grouped by room.

**Layer 2**: On-Demand Retrieval (~500 tokens per call). Fetch drawers from a specific wing/room.

**Layer 3**: Deep Search (unlimited). Semantic search with optional wing/room filter.

Load via CLI:
```bash
nardo wake-up
```

Options:
- `--wing <name>`: Filter L1 context to specific wing
- `--palace <path>`: Override palace location

### Hybrid Search Scoring

The search system combines multiple ranking signals:
- **Vector similarity** (55%): Cosine distance from embeddings
- **Keyword ranking** (35%): BM25 relevance via SQLite FTS5
- **Importance decay** (10%): Recent content scores higher

**MMR Reranking**: Control diversity with `mmr_lambda` parameter (0.0–1.0, default 0.7):
- 1.0 = pure relevance
- 0.7 = balanced (default)
- 0.0 = pure diversity

**Importance decay**: Content scores decay over time. Configure half-life in days (default 90). Set to 0 to disable.

**Query expansion**: Terse queries are automatically expanded with synonyms before embedding. E.g. `auth` embeds as `auth authentication login jwt session token oauth`. BM25 still uses the original query for precision. Disable with `expand: false`.

**Cross-wing federation**: Set `federated: true` to search all wings regardless of the `wing` filter. Each result is tagged with its origin wing. Useful for "search everything I know about X" queries.

## Hook Setup

nardo integrates with Claude Code hooks for background memory saving.

### Stop Hook

**File**: `~/.claude/hooks/mempal_save_hook.sh`

**Trigger**: When user stops typing

**Example**:
```bash
#!/bin/bash
diary_text="$NARDO_DIARY"
bun run /path/to/nardo/src/mcp/server.ts \
  --diary-text "$diary_text" \
  --wing "sessions" \
  --room "$(date +%Y-%m-%d)"
```

### PreCompact Hook

**File**: `~/.claude/hooks/mempal_precompact_hook.sh`

**Trigger**: Before Claude Code state compression

**Purpose**: Save session state to a drawer before compaction to preserve context.

## Configuration

Location: `~/.nardo/config.json`

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
  "hooks": {
    "silent_save": true,
    "desktop_toast": false
  }
}
```

### Config Properties

| Property | Type | Default | Notes |
|----------|------|---------|-------|
| `palace_path` | string | repo-local `.nardo/palace` when inside a git repo, else `~/.nardo/palace` | Optional explicit override |
| `collection_name` | string | `nardo_drawers` | Main collection name |
| `topic_wings` | array | 7 defaults | Default wing categories |
| `hooks.silent_save` | bool | `true` | Save directly or call MCP |
| `hooks.desktop_toast` | bool | `false` | Show desktop notifications |

### Environment Variables

Override palace path via environment:
```bash
export NARDO_PALACE_PATH=/custom/path
nardo status
```

## Deduplication

Remove near-duplicate drawers with:

```bash
nardo dedup --threshold 0.15
```

Algorithm:
1. Group drawers by source_file
2. For groups with 5+ drawers, score similarity (cosine distance < threshold)
3. Keep longest drawer from each group
4. Delete marked duplicates

Threshold default: 0.15 (configurable, lower = stricter dedup).

## Export & Import

Back up or migrate the palace:

```bash
nardo export > backup.jsonl           # Export all drawers
nardo export --wing git > git.jsonl   # Export one wing
nardo import backup.jsonl             # Restore into current palace
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

### Type Check

TypeScript is configured with strict mode. Run:
```bash
bun run dev
```

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
│   ├── ddl.ts              # Schema and migrations
│   └── query.ts            # Graph queries
├── wakeup/                 # Memory layers
│   ├── l0.ts               # Identity layer
│   ├── l1.ts               # Essential story
│   ├── l2.ts               # On-demand retrieval
│   └── l3.ts               # Deep search
├── config.ts               # Configuration loader
├── wal.ts                  # Write-ahead log
└── index.ts                # Main entry
```

## Limitations and Future Work

- **Single-region**: Palace is single-machine. Multi-region sync planned.
- **Entity resolution**: Basic duplicate detection; full reconciliation pending.
- **Access control**: No built-in RLS; privacy enforced via file permissions.

## License

See LICENSE file in repository.

## Contributing

See CONTRIBUTING.md for development guidelines and pull request process.
