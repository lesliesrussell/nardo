/**
 * Query expansion: augment terse queries with related terms before embedding.
 * Improves recall for abbreviated or domain-specific searches.
 *
 * Strategy: tokenize → lookup → append unique synonyms → return enriched string.
 * Expanded string is used for embedding only; BM25 still uses the original query.
 */

// Synonym map: lowercase token → related terms to append
const SYNONYMS: Record<string, string[]> = {
  // Auth
  auth: ['authentication', 'login', 'jwt', 'session', 'token', 'oauth'],
  login: ['auth', 'authentication', 'session', 'credentials'],
  jwt: ['token', 'auth', 'authentication', 'bearer'],
  oauth: ['auth', 'authentication', 'token', 'login'],

  // Database
  db: ['database', 'sql', 'query', 'table', 'schema'],
  database: ['db', 'sql', 'schema', 'table'],
  sql: ['database', 'db', 'query', 'schema'],

  // Search / embedding
  embed: ['embedding', 'vector', 'similarity', 'semantic'],
  embedding: ['embed', 'vector', 'similarity'],
  vec: ['vector', 'embedding', 'similarity'],
  vector: ['embed', 'embedding', 'similarity', 'semantic'],
  search: ['query', 'retrieve', 'find', 'lookup', 'semantic'],
  hnsw: ['index', 'vector', 'embedding', 'similarity'],
  bm25: ['search', 'fulltext', 'fts', 'ranking', 'text'],
  fts: ['fulltext', 'search', 'bm25', 'text'],
  mmr: ['diversity', 'reranking', 'relevance', 'search'],

  // Config
  config: ['configuration', 'settings', 'options', 'env', 'environment'],
  cfg: ['config', 'configuration', 'settings'],
  settings: ['config', 'configuration', 'options'],
  env: ['environment', 'config', 'configuration'],
  options: ['config', 'configuration', 'settings'],

  // API / HTTP
  api: ['endpoint', 'rest', 'http', 'request', 'response'],
  endpoint: ['api', 'rest', 'route', 'http'],
  http: ['api', 'request', 'response', 'endpoint'],
  rest: ['api', 'http', 'endpoint', 'request'],
  mcp: ['server', 'tool', 'protocol', 'api'],

  // Error
  err: ['error', 'exception', 'failure', 'bug'],
  error: ['err', 'exception', 'failure', 'bug', 'crash'],
  bug: ['error', 'issue', 'defect', 'fix'],
  exception: ['error', 'err', 'failure', 'crash'],

  // Functions
  fn: ['function', 'method', 'handler', 'callback'],
  func: ['function', 'method', 'handler'],
  function: ['fn', 'func', 'method', 'handler'],
  method: ['function', 'fn', 'func', 'handler'],
  callback: ['function', 'handler', 'fn'],
  handler: ['function', 'method', 'fn', 'callback'],

  // Message / events
  msg: ['message', 'notification', 'event'],
  message: ['msg', 'notification', 'event'],
  event: ['message', 'notification', 'hook'],
  notification: ['message', 'msg', 'alert', 'event'],

  // Repository / git
  repo: ['repository', 'codebase', 'source', 'git'],
  repository: ['repo', 'codebase', 'git'],
  git: ['repo', 'repository', 'version', 'commit', 'branch'],
  commit: ['git', 'change', 'diff', 'version'],
  branch: ['git', 'version', 'checkout'],

  // Documentation
  doc: ['document', 'documentation', 'readme', 'markdown', 'guide'],
  docs: ['documentation', 'readme', 'guide', 'reference'],
  document: ['doc', 'documentation', 'readme'],
  documentation: ['doc', 'docs', 'readme', 'guide'],
  readme: ['doc', 'docs', 'documentation', 'guide'],

  // Testing
  test: ['testing', 'spec', 'assertion', 'unit', 'integration'],
  spec: ['test', 'testing', 'assertion'],
  assertion: ['test', 'spec', 'expect', 'assert'],

  // UI / Frontend
  ui: ['interface', 'component', 'frontend', 'view', 'render'],
  frontend: ['ui', 'interface', 'component', 'view'],
  component: ['ui', 'frontend', 'view', 'widget'],

  // Cache
  cache: ['caching', 'memory', 'store', 'ttl'],
  caching: ['cache', 'memory', 'store'],
  ttl: ['cache', 'expiry', 'timeout'],

  // Sync
  sync: ['synchronize', 'update', 'refresh', 'merge'],
  merge: ['sync', 'combine', 'join', 'combine'],

  // Import / export
  import: ['load', 'ingest', 'read', 'parse', 'restore'],
  export: ['save', 'output', 'write', 'dump', 'backup'],
  ingest: ['import', 'load', 'mine', 'index', 'parse'],

  // Index
  index: ['indexing', 'search', 'hnsw', 'vector'],

  // Palace / nardo-specific
  drawer: ['chunk', 'document', 'memory', 'note', 'passage'],
  closet: ['topic', 'category', 'group', 'cluster'],
  palace: ['memory', 'store', 'knowledge', 'repository'],
  wing: ['namespace', 'partition', 'section', 'collection'],
  room: ['category', 'topic', 'folder', 'namespace'],
  mine: ['ingest', 'index', 'import', 'crawl', 'extract'],
  decay: ['importance', 'recency', 'age', 'halflife'],
  importance: ['decay', 'recency', 'weight', 'score'],

  // Knowledge graph
  kg: ['knowledge', 'graph', 'entities', 'triples', 'relations'],
  graph: ['kg', 'knowledge', 'entities', 'relations'],
  entity: ['node', 'subject', 'concept', 'thing'],
  triple: ['relation', 'edge', 'fact', 'statement'],

  // CLI
  cli: ['command', 'terminal', 'shell', 'commandline'],
  cmd: ['command', 'cli', 'terminal', 'shell'],
  command: ['cli', 'cmd', 'terminal', 'shell'],
}

export interface ExpandResult {
  /** Enriched query string for embedding (original + synonyms) */
  expanded: string
  /** New terms that were appended (empty if no expansion occurred) */
  added_terms: string[]
}

/**
 * Expand a sanitized query with related terms.
 * Returns the enriched string for embedding + list of added terms.
 * If no synonyms are found, expanded === query and added_terms is empty.
 */
export function expandQuery(query: string): ExpandResult {
  const tokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  const tokenSet = new Set(tokens)
  const added: string[] = []

  for (const token of tokens) {
    const synonyms = SYNONYMS[token]
    if (!synonyms) continue
    for (const syn of synonyms) {
      if (!tokenSet.has(syn)) {
        tokenSet.add(syn)
        added.push(syn)
      }
    }
  }

  return {
    expanded: added.length > 0 ? `${query} ${added.join(' ')}` : query,
    added_terms: added,
  }
}
