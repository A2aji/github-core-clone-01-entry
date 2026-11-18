// mcp.ts — Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 streamable HTTP.
//
// Speaks both protocol eras the suite accepts:
//   modern 2026-07-28: `server/discover` answers identity, capabilities and
//     supportedVersions in one request; no handshake, no session.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// Notifications get no reply (HTTP 202, empty body). `ping` answers {}.
//
// Auth: Bearer token must equal expectedToken (or, when expectedToken is
// '', any non-empty Bearer — the entry's own isAuthenticated convention
// in app.ts), checked BEFORE any JSON-RPC handling; missing/wrong -> 401.
// A non-JSON body -> HTTP 400 with JSON-RPC -32700. Unknown tool ->
// JSON-RPC -32602 (never HTTP 500). Missing required arguments and tool
// failures (unknown repo, ...) -> a result with isError:true, never a
// JSON-RPC error. The request `id` is echoed exactly, so concurrent calls
// keep their own ids. `tools/list` returns one frozen array, byte-identical
// on every call. Tools act on the same store as REST/GraphQL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Issue,
  type Pull,
  type Repo,
  type Store,
  createCommit,
  resolveRef,
  treeOidOf,
} from './store.ts';

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  expectedToken: string,
): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/mcp' && path !== '/mcp/') return false;
  if (req.method === 'DELETE') {
    // Legacy session teardown; this server issues no sessions, so nothing to drop.
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!isAuthed(req, expectedToken)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  // A JSON-RPC notification (no id) gets no reply.
  if (!('id' in body)) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const id: unknown = body.id ?? null;
  const method = body.method;
  if (typeof method !== 'string' || method === '') {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: missing method' } });
    return true;
  }
  const params = isRecord(body.params) ? body.params : {};
  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
          supportedVersions: SUPPORTED_VERSIONS,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      });
      return true;
    }
    case 'ping': {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
      return true;
    }
    case 'tools/list': {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === '') {
        sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: missing tool name' } });
        return true;
      }
      if (!TOOL_NAMES.has(name)) {
        sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return true;
      }
      const outcome = callTool(store, name, args);
      sendJson(res, 200, { jsonrpc: '2.0', id, result: outcome });
      return true;
    }
    default: {
      if (method.startsWith('notifications/')) {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
        return true;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      return true;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  }
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 10 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? (match[1] as string) : '';
}

/** The entry's convention (app.ts isAuthenticated): an empty expected token accepts any non-empty Bearer. */
function isAuthed(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return bearerToken(req) !== '';
  return bearerToken(req) === expectedToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Server identity and the six tools (built once, returned verbatim)
// ---------------------------------------------------------------------------

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });

const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25']);

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'Name of the repository to create.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'Title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'Body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all; default open).',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed or all.', enum: ['open', 'closed', 'all'] }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'Title of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'Name of the head branch.' }),
        base: Object.freeze({ type: 'string', description: 'Name of the base branch.' }),
        body: Object.freeze({ type: 'string', description: 'Body of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'Login of the repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'Name of the repository.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'Number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((tool) => String(tool.name)));

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(name: string): ToolResult {
  return errResult(`missing required argument: ${name}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  try {
    switch (name) {
      case 'create_repo':
        return toolCreateRepo(store, args);
      case 'get_repo':
        return toolGetRepo(store, args);
      case 'create_issue':
        return toolCreateIssue(store, args);
      case 'list_issues':
        return toolListIssues(store, args);
      case 'create_pull_request':
        return toolCreatePullRequest(store, args);
      case 'merge_pull_request':
        return toolMergePullRequest(store, args);
      default:
        return errResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
}

// --- argument normalization: canonical names plus the documented aliases --

function pickStr(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = str(args[key]);
    if (value !== '') return value;
  }
  return '';
}

function pickOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = pickStr(args, ['owner', 'owner_login', 'org', 'organization', 'user_login', 'login', 'owner_name']);
  let repo = pickStr(args, ['repo', 'repository', 'repo_name', 'repository_name']);
  const full = pickStr(args, ['full_name', 'repo_full_name', 'repository_full_name']);
  if ((owner === '' || repo === '') && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === '' && o !== undefined && o !== '') owner = o;
    if (repo === '' && r !== undefined && r !== '') repo = r;
  }
  return { owner, repo };
}

function pickInt(args: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function requireOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | ToolResult {
  const { owner, repo } = pickOwnerRepo(args);
  if (owner === '') return missingArg('owner');
  if (repo === '') return missingArg('repo');
  return { owner, repo };
}

function loadRepo(store: Store, owner: string, repo: string): Repo | ToolResult {
  const found = store.getRepo(owner, repo);
  if (found === undefined || found.ownerLogin !== owner) return errResult(`repository not found: ${owner}/${repo}`);
  return found;
}

// --- views: REST-shaped objects, so MCP and REST agree on ids ------------

function repoView(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: store.viewer.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.ownerLogin}/${repo.name}`,
  };
}

function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.databaseId,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.userLogin },
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.ownerLogin}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.databaseId,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.ownerLogin}/${repo.name}/pull/${pull.number}`,
  };
}

// --- the six tools ---------------------------------------------------------

function toolCreateRepo(store: Store, args: Record<string, unknown>): ToolResult {
  const name = pickStr(args, ['name', 'repo', 'repository', 'repo_name', 'repository_name']);
  if (name === '') return missingArg('name');
  const description = pickStr(args, ['description', 'about', 'summary', 'body']);
  const isPrivate = args.private === true || args.is_private === true;
  const repo = store.createRepo(name, { private: isPrivate, description });
  return okResult(repoView(store, repo));
}

function toolGetRepo(store: Store, args: Record<string, unknown>): ToolResult {
  const located = requireOwnerRepo(args);
  if ('content' in located) return located;
  const repo = loadRepo(store, located.owner, located.repo);
  if ('content' in repo) return repo;
  return okResult(repoView(store, repo));
}

function toolCreateIssue(store: Store, args: Record<string, unknown>): ToolResult {
  const located = requireOwnerRepo(args);
  if ('content' in located) return located;
  const title = pickStr(args, ['title', 'issue_title', 'subject']);
  if (title === '') return missingArg('title');
  const repo = loadRepo(store, located.owner, located.repo);
  if ('content' in repo) return repo;
  const body = pickStr(args, ['body', 'issue_body', 'description', 'content', 'text']);
  const issue = createIssueInStore(store, repo, title, body);
  return okResult(issueView(issue, repo));
}

function toolListIssues(store: Store, args: Record<string, unknown>): ToolResult {
  const located = requireOwnerRepo(args);
  if ('content' in located) return located;
  const repo = loadRepo(store, located.owner, located.repo);
  if ('content' in repo) return repo;
  const state = pickStr(args, ['state', 'status']).toLowerCase() || 'open';
  let issues = repo.issues;
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') return errResult(`invalid state: ${state}`);
  return okResult(issues.map((issue) => issueView(issue, repo)));
}

function toolCreatePullRequest(store: Store, args: Record<string, unknown>): ToolResult {
  const located = requireOwnerRepo(args);
  if ('content' in located) return located;
  const title = pickStr(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === '') return missingArg('title');
  const head = pickStr(args, ['head', 'head_ref', 'head_branch', 'pr_head', 'source', 'source_branch', 'from', 'from_branch']);
  if (head === '') return missingArg('head');
  const base = pickStr(args, ['base', 'base_ref', 'base_branch', 'pr_base', 'target', 'target_branch', 'into', 'into_branch']);
  if (base === '') return missingArg('base');
  const repo = loadRepo(store, located.owner, located.repo);
  if ('content' in repo) return repo;
  const headSha = resolveRef(repo, head);
  if (headSha === undefined) return errResult(`head ref not found: ${head}`);
  const baseSha = resolveRef(repo, base);
  if (baseSha === undefined) return errResult(`base ref not found: ${base}`);
  const body = pickStr(args, ['body', 'description', 'content', 'text']);
  const pull = createPullInStore(store, repo, base, head, title, body, headSha, baseSha);
  return okResult(pullView(pull, repo));
}

function toolMergePullRequest(store: Store, args: Record<string, unknown>): ToolResult {
  const located = requireOwnerRepo(args);
  if ('content' in located) return located;
  const pullNumber = pickInt(args, ['pull_number', 'pull_request_number', 'pr_number', 'number']);
  if (pullNumber === null) return missingArg('pull_number');
  const repo = loadRepo(store, located.owner, located.repo);
  if ('content' in repo) return repo;
  const pull = repo.pulls.find((entry) => entry.number === pullNumber);
  if (pull === undefined) return errResult(`pull request not found: #${pullNumber}`);
  if (!pull.merged) squashMerge(store, repo, pull);
  return okResult({ merged: true, number: pull.number, state: pull.state, merge_commit_sha: pull.mergeCommitSha, ...pullView(pull, repo) });
}

// ---------------------------------------------------------------------------
// Store mutation helpers (same shapes as graphql.ts writes; the parent may
// deduplicate — see GRAPHQL-MCP-NOTES.md)
// ---------------------------------------------------------------------------

function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
  const now = store.tick();
  const id = store.nextObjectId();
  const number = repo.issueCounter;
  repo.issueCounter += 1;
  const issue: Issue = {
    id,
    databaseId: id,
    nodeId: store.nodeId('I', id),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    userLogin: store.viewer.login,
    createdAt: now.iso,
    updatedAt: now.iso,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

function createPullInStore(
  store: Store,
  repo: Repo,
  baseRef: string,
  headRef: string,
  title: string,
  body: string,
  headSha: string,
  baseSha: string,
): Pull {
  const now = store.tick();
  const id = store.nextObjectId();
  const number = repo.pullCounter;
  repo.pullCounter += 1;
  const pull: Pull = {
    id,
    databaseId: id,
    nodeId: store.nodeId('PR', id),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headSha,
    baseSha,
    mergeable: true,
    mergeCommitSha: null,
    createdAt: now.iso,
    updatedAt: now.iso,
  };
  repo.pulls.push(pull);
  return pull;
}

/**
 * Squash merge: one commit whose tree is the head tree and whose parent is
 * the current base tip, then the base ref moves to it and the PR closes.
 * Identity and timestamp come from the store's logical clock.
 */
function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const now = store.tick();
  const baseTip = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const headTree = treeOidOf(repo, pull.headSha);
  if (headTree === undefined) throw new Error(`head commit ${pull.headSha} has no tree`);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const sha = createCommit(repo, {
    tree: headTree,
    parents: [baseTip],
    authorName: store.viewer.name,
    authorEmail: store.viewer.email,
    committerName: store.viewer.name,
    committerEmail: store.viewer.email,
    epoch: now.epoch,
    message,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.updatedAt = now.iso;
  return sha;
}
