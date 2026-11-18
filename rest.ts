// rest.ts — GitHub REST v3 routes for the github-core-clone-01 entry.
//
// The router (server.ts) calls handleRest(req, res, store, expectedToken)
// for paths under /api/v3 and handles everything else itself (/healthz,
// /api/graphql, /mcp, ...). handleRest returns true when it answered the
// request, false when the path is not under /api/v3.
//
// Contract notes (verified against program/env/src/checks-rest.ts, the
// ground truth — see REST-NOTES.md for the per-route shapes):
//   - Auth: Bearer token must equal expectedToken (when it is non-empty).
//     Missing/wrong token -> 401 {"message"}. GET /api/v3/ and /api/v3/meta
//     are public, like api.github.com.
//   - Every reply is application/json with X-GitHub-Request-Id (a
//     deterministic per-request counter, "req-<n>") and X-OAuth-Scopes.
//   - Unknown /api/v3 route -> JSON 404. Malformed JSON body -> 400.
//   - Pagination: ?page (1-based, default 1), ?per_page (default 30,
//     clamped to 1..100); Link header with rel="next"/"last"/"first"/"prev"
//     when there is more than one page, plus X-Total-Count.
//   - The handler reads the request body itself from the req stream:
//     server.ts MUST NOT pre-consume the body for /api/v3 routes.
//   - Merge conflict -> 405 (checks-rest.ts pullsMergeConflict expects
//     405, not 409). Already-merged/closed PR merge -> 405 as well.
//   - Labels: an issue label is accepted when it is registered on the repo
//     via POST /labels OR is one of the scenario's global labels
//     (wire.ts ISSUE_LABELS); anything else -> 422.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createCommit,
  diffLines,
  diffTrees,
  mergeBase,
  parseCommit,
  resolveRef,
  SCENARIO_LABELS,
  storeObject,
  subtreeOid,
  treeAt,
  treeOidOf,
  walkCommits,
  writeTree,
  type Issue,
  type IssueComment,
  type Oid,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

type Json = Record<string, unknown>;

const JSON_TYPE = 'application/json; charset=utf-8';
const SHA40 = /^[0-9a-f]{40}$/i;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Send a JSON body with the headers every REST reply must carry. */
export function json(res: ServerResponse, status: number, obj: unknown, extra: Record<string, string> = {}): void {
  jsonRaw(res, status, `${JSON.stringify(obj)}\n`, extra);
}

/** Send a pre-serialized JSON body with the same headers `json` sends. */
export function jsonRaw(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  });
  res.end(text);
}

/** Send a 204 with no body (DELETE repo). */
function noContent(res: ServerResponse): void {
  res.writeHead(204, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
  });
  res.end();
}

function err(res: ServerResponse, status: number, message: string): void {
  json(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function baseOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Base64 of bytes wrapped at 60 columns, as GitHub's contents API does. */
function wrapBase64(data: Buffer): string {
  const b64 = data.toString('base64');
  const lines = b64.match(/.{1,60}/g) ?? [];
  return lines.join('\n');
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

// ---------------------------------------------------------------------------
// Serializers (snake_case GitHub names plus camelCase mirrors)
// ---------------------------------------------------------------------------

const userJsonCache = new Map<string, Json>();

function userJson(store: Store, login: string): Json {
  // The viewer identity never changes within a process, and every caller
  // passes the viewer's login; memoize the (small, immutable) object instead
  // of rebuilding + re-encoding the node id on every serialization.
  const viewer = store.viewer;
  const key = `${login}:${viewer.id}`;
  const hit = userJsonCache.get(key);
  if (hit !== undefined) return hit;
  const out: Json = {
    login,
    id: viewer.id,
    node_id: `U_${b64url(String(viewer.id))}`,
    avatar_url: '',
    type: 'User',
    site_admin: false,
  };
  userJsonCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Issue GET response cache (the read workload hits the same issue 2,000x)
// ---------------------------------------------------------------------------
//
// Keyed by the issue object itself (WeakMap: a deleted/recreated repo gets
// fresh issue objects, so nothing stale can survive). The signature covers
// every input issueJson reads: repo identity (a rename changes the URLs),
// the request base, all mutable issue fields, the comment count, and each
// label's registered name/color/description (a later POST /labels can change
// a label's rendering). A signature match means the serialized bytes are
// identical; anything else rebuilds. The cached string is sent verbatim via
// jsonRaw — only the per-request X-GitHub-Request-Id header is fresh.
const issueGetCache = new WeakMap<Issue, { sig: string; text: string }>();

function repoJson(store: Store, repo: Repo, req: IncomingMessage): Json {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    databaseId: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    fullName: `${owner}/${repo.name}`,
    owner: userJson(store, owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    defaultBranch: repo.defaultBranch,
    has_issues: true,
    hasIssuesEnabled: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    html_url: `${base}/${owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `${base}/${owner}/${repo.name}.git`,
    git_url: `${base}/${owner}/${repo.name}.git`,
    ssh_url: `git@${base.replace(/^https?:\/\//, '')}:${owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    size: 0,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

function labelJson(store: Store, repo: Repo, name: string): Json {
  const registered = store.getLabel(repo.ownerLogin, repo.name, name);
  return { name, color: registered?.color ?? 'ededed', description: registered?.description ?? '' };
}

function issueJson(store: Store, repo: Repo, issue: Issue, req: IncomingMessage): Json {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  return {
    id: issue.id,
    databaseId: issue.databaseId,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => labelJson(store, repo, label.name)),
    user: userJson(store, issue.userLogin),
    assignees: [],
    assignee: null,
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    comments_url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: IssueComment, req: IncomingMessage): Json {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  return {
    id: comment.id,
    databaseId: comment.id,
    node_id: store.nodeId('C', comment.id),
    body: comment.body,
    user: userJson(store, comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    issue_url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull, req: IncomingMessage): Json {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  return {
    id: pull.id,
    databaseId: pull.databaseId,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.updatedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${owner}:${pull.headRef}`,
      user: userJson(store, owner),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${owner}:${pull.baseRef}`,
      user: userJson(store, owner),
    },
    user: userJson(store, owner),
    assignees: [],
    requested_reviewers: [],
    draft: false,
    locked: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    html_url: `${base}/${owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, repo: Repo, commit: { sha: Oid } & ReturnType<typeof parseCommit>, req: IncomingMessage): Json {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  const author = { name: commit.authorName, email: commit.authorEmail, date: commit.authorDate };
  const committer = { name: commit.committerName, email: commit.committerEmail, date: commit.committerDate };
  return {
    sha: commit.sha,
    node_id: `C_${b64url(commit.sha)}`,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree, url: `${base}/api/v3/repos/${owner}/${repo.name}/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    parents: commit.parents.map((sha) => ({ sha })),
    author: userJson(store, owner),
    committer: userJson(store, owner),
    tree: { sha: commit.tree },
    html_url: `${base}/${owner}/${repo.name}/commit/${commit.sha}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/commits/${commit.sha}`,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(url: URL): PageParams {
  const rawPage = Number(url.searchParams.get('page') ?? '1');
  const rawPerPage = Number(url.searchParams.get('per_page') ?? '30');
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  let perPage = Number.isFinite(rawPerPage) ? Math.trunc(rawPerPage) : 30;
  if (perPage < 1) perPage = 1;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

function pageUrl(req: IncomingMessage, url: URL, page: number, perPage: number): string {
  // Rebuild on the request's real origin: `url` was parsed against a dummy
  // base, so its origin must never leak into a Link header (the client only
  // follows same-origin links).
  const next = new URL(`${baseOf(req)}${url.pathname}`);
  for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
  next.searchParams.set('page', String(page));
  next.searchParams.set('per_page', String(perPage));
  return next.toString();
}

/** Slice items for the page; return the page items plus Link/X-Total-Count headers. */
function paginate<T>(req: IncomingMessage, url: URL, items: T[]): { pageItems: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(url);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = { 'x-total-count': String(total) };
  if (totalPages > 1) {
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`<${pageUrl(req, url, page + 1, perPage)}>; rel="next"`);
      links.push(`<${pageUrl(req, url, totalPages, perPage)}>; rel="last"`);
    }
    if (page > 1) {
      links.push(`<${pageUrl(req, url, 1, perPage)}>; rel="first"`);
      links.push(`<${pageUrl(req, url, page - 1, perPage)}>; rel="prev"`);
    }
    headers.link = links.join(', ');
  }
  return { pageItems, headers };
}

// ---------------------------------------------------------------------------
// Mergeability
// ---------------------------------------------------------------------------

/** Conflict when a file changed on both sides of the merge-base with different results. */
function computeMergeable(store: Store, repo: Repo, headSha: Oid, baseSha: Oid): boolean {
  const mb = mergeBase(repo, headSha, baseSha);
  const mbTree = mb === null ? null : treeOidOf(repo, mb) ?? null;
  const headTree = treeOidOf(repo, headSha);
  const baseTree = treeOidOf(repo, baseSha);
  if (headTree === undefined || baseTree === undefined) return false;
  const headMap = treeAt(repo, headTree);
  const baseMap = treeAt(repo, baseTree);
  const headChanges = new Set(diffTrees(repo, mbTree, headTree).map((entry) => entry.filename));
  for (const entry of diffTrees(repo, mbTree, baseTree)) {
    if (!headChanges.has(entry.filename)) continue;
    if (headMap.get(entry.filename)?.oid !== baseMap.get(entry.filename)?.oid) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle one REST v3 request. Returns true when the request was answered
 * (including the JSON 404 for an unknown /api/v3 route), false when the
 * path is not under /api/v3 and the router should handle it.
 *
 * `expectedToken`: the Bearer value to require; an empty string disables
 * the auth check (dev mode only — the trial always sets MAKEFUN_SHOP_TOKEN).
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  expectedToken: string,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  const segments = decodeSegments(url.pathname);
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);
  const method = (req.method ?? 'GET').toUpperCase();

  // Public routes (like api.github.com): the API root and /meta need no token.
  const isPublic = (method === 'GET' && rest.length === 0) || (method === 'GET' && rest.length === 1 && rest[0] === 'meta');
  if (!isPublic && expectedToken !== '') {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${expectedToken}`) {
      err(res, 401, 'Bad credentials');
      return true;
    }
  }

  // Read + parse the body for methods that carry one. A non-empty body that
  // is not valid JSON is a 400 (protocol check).
  let body: Json = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (!isRecord(parsed)) {
          err(res, 400, 'Problems parsing JSON');
          return true;
        }
        body = parsed;
      } catch {
        err(res, 400, 'Problems parsing JSON');
        return true;
      }
    }
  }

  const base = baseOf(req);
  const viewer = store.viewer;

  // -- API root ---------------------------------------------------------------
  if (method === 'GET' && rest.length === 0) {
    json(res, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/applications`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      user_url: `${base}/api/v3/users/{user}`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      meta: `${base}/api/v3/meta`,
    });
    return true;
  }

  // -- /meta ------------------------------------------------------------------
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    json(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // -- GET /user --------------------------------------------------------------
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    json(res, 200, {
      login: viewer.login,
      id: viewer.id,
      node_id: `U_${b64url(String(viewer.id))}`,
      type: 'User',
      name: viewer.name,
      email: viewer.email,
      avatar_url: '',
      html_url: `${base}/${viewer.login}`,
      url: `${base}/api/v3/user`,
      site_admin: false,
      public_repos: store.listRepos(viewer.login).length,
    });
    return true;
  }

  // -- POST /user/repos + GET /user/repos --------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === undefined || name.trim() === '') {
        err(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
        err(res, 422, `Validation Failed: name ${JSON.stringify(name)} is not a valid repository name`);
        return true;
      }
      if (store.getRepo(viewer.login, name) !== undefined) {
        err(res, 422, `Validation Failed: name already exists on this account`);
        return true;
      }
      const repo = store.createRepo(name, {
        private: asBool(body.private),
        description: asString(body.description),
      });
      json(res, 201, repoJson(store, repo, req));
      return true;
    }
    if (method === 'GET') {
      const items = store.listRepos(viewer.login).map((repo) => repoJson(store, repo, req));
      const { pageItems, headers } = paginate(req, url, items);
      json(res, 200, pageItems, headers);
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  // -- /repos/{owner}/{repo}... ------------------------------------------------
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    // A repository belongs to the login the token names: any other owner is
    // a 404, never a 403.
    if (owner !== viewer.login) {
      err(res, 404, 'Not Found');
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      err(res, 404, 'Not Found');
      return true;
    }
    const tail = rest.slice(3);

    // GET /repos/{o}/{r}
    if (tail.length === 0 && method === 'GET') {
      json(res, 200, repoJson(store, repo, req));
      return true;
    }

    // PATCH /repos/{o}/{r}
    if (tail.length === 0 && method === 'PATCH') {
      const newName = asString(body.name);
      if (newName !== undefined) {
        if (newName.trim() === '' || !/^[A-Za-z0-9._-]+$/.test(newName) || newName.startsWith('.')) {
          err(res, 422, 'Validation Failed: name is not a valid repository name');
          return true;
        }
        if (newName !== repo.name && store.getRepo(owner, newName) !== undefined) {
          err(res, 422, 'Validation Failed: name already exists on this account');
          return true;
        }
      }
      const newBranch = asString(body.default_branch);
      if (newBranch !== undefined && repo.refs.size > 0 && resolveRef(repo, newBranch) === undefined) {
        err(res, 422, `Validation Failed: default branch ${JSON.stringify(newBranch)} does not exist`);
        return true;
      }
      const now = store.tick();
      if (newName !== undefined && newName !== repo.name) {
        // Rename preserving creation order in the map, and move the label registry.
        const rebuilt = new Map<string, Repo>();
        for (const [key, value] of store.repos) {
          if (value === repo) rebuilt.set(`${owner}/${newName}`, value);
          else rebuilt.set(key, value);
        }
        store.repos.clear();
        for (const [key, value] of rebuilt) store.repos.set(key, value);
        const labelMap = store.labels.get(`${owner}/${repo.name}`);
        if (labelMap !== undefined) {
          store.labels.delete(`${owner}/${repo.name}`);
          store.labels.set(`${owner}/${newName}`, labelMap);
        }
        repo.name = newName;
      }
      if (asString(body.description) !== undefined) repo.description = asString(body.description) as string;
      if (asBool(body.private) !== undefined) repo.private = asBool(body.private) as boolean;
      if (newBranch !== undefined) repo.defaultBranch = newBranch;
      repo.updatedAt = now.iso;
      json(res, 200, repoJson(store, repo, req));
      return true;
    }

    // DELETE /repos/{o}/{r} -> 204, gone afterwards
    if (tail.length === 0 && method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      noContent(res);
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const names: string[] = [];
      for (const ref of repo.refs.keys()) {
        if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
      }
      names.sort();
      const items = names.map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`) as string },
        protected: false,
      }));
      const { pageItems, headers } = paginate(req, url, items);
      json(res, 200, pageItems, headers);
      return true;
    }

    // GET /repos/{o}/{r}/commits[?sha=<branch>]
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (tip === undefined) {
        if (repo.refs.size === 0) {
          json(res, 200, []);
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      const items = walkCommits(repo, tip).map((commit) => commitJson(store, repo, commit, req));
      const { pageItems, headers } = paginate(req, url, items);
      json(res, 200, pageItems, headers);
      return true;
    }

    // /git/refs — GET one ref, POST create a ref
    if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          err(res, 404, 'Not Found');
          return true;
        }
        json(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      if (method === 'POST' && tail.length === 2) {
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === undefined || !/^refs\/(heads|tags)\/.+/.test(ref)) {
          err(res, 422, 'Validation Failed: ref must be refs/heads/<name> or refs/tags/<name>');
          return true;
        }
        if (sha === undefined || !SHA40.test(sha)) {
          err(res, 422, 'Validation Failed: sha must be a 40-character commit id');
          return true;
        }
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          err(res, 422, 'Validation Failed: sha does not name a commit in this repository');
          return true;
        }
        if (repo.refs.has(ref)) {
          err(res, 422, 'Validation Failed: reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        json(res, 201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // /labels — POST create, GET list
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'POST') {
        const name = asString(body.name);
        if (name === undefined || name.trim() === '') {
          err(res, 422, 'Validation Failed: name is required');
          return true;
        }
        const color = (asString(body.color) ?? 'ededed').replace(/^#/, '');
        if (!/^[0-9a-fA-F]{6}$/.test(color)) {
          err(res, 422, 'Validation Failed: color must be a 6-digit hex value');
          return true;
        }
        const added = store.addLabel(owner, repoName, {
          name,
          color: color.toLowerCase(),
          description: asString(body.description) ?? '',
        });
        if (!added) {
          err(res, 422, `Validation Failed: label ${JSON.stringify(name)} already exists`);
          return true;
        }
        json(res, 201, {
          name,
          color: color.toLowerCase(),
          description: asString(body.description) ?? '',
          url: `${base}/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}`,
          default: false,
        });
        return true;
      }
      if (method === 'GET') {
        const items = store.getLabels(owner, repoName).map((label) => ({
          name: label.name,
          color: label.color,
          description: label.description,
          url: `${base}/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(label.name)}`,
          default: false,
        }));
        json(res, 200, items);
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }

    // /contents/{path...} — GET file/dir, PUT create/update, DELETE remove
    if (tail.length >= 1 && tail[0] === 'contents') {
      return handleContents(req, res, store, repo, tail.slice(1), method, body, url);
    }

    // /issues...
    if (tail.length >= 1 && tail[0] === 'issues') {
      return handleIssues(req, res, store, repo, tail.slice(1), method, body, url);
    }

    // /pulls...
    if (tail.length >= 1 && tail[0] === 'pulls') {
      return handlePulls(req, res, store, repo, tail.slice(1), method, body, url);
    }

    err(res, 404, 'Not Found');
    return true;
  }

  // Unknown /api/v3 route: JSON 404 (never HTML).
  err(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function contentsFileJson(store: Store, repo: Repo, path: string, blobOid: Oid, data: Buffer, req: IncomingMessage): Json {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  const name = path.split('/').pop() ?? path;
  const encoded = encodeURIComponent(path).replace(/%2F/g, '/');
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: wrapBase64(data),
    sha: blobOid,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${encoded}`,
    html_url: `${base}/${owner}/${repo.name}/blob/${repo.defaultBranch}/${encoded}`,
    git_url: `${base}/api/v3/repos/${owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${encoded}?raw=true`,
  };
}

function contentsDirJson(store: Store, repo: Repo, dirPath: string, refTip: Oid, req: IncomingMessage): Json[] {
  const base = baseOf(req);
  const owner = repo.ownerLogin;
  const flat = treeAt(repo, refTip);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: Oid; size: number }>();
  for (const [path, file] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', oid: file.oid, size: repo.objects.get(file.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        const treeOid = subtreeOid(repo, treeOidOf(repo, refTip) as string, prefix + dir) ?? '';
        children.set(dir, { type: 'dir', oid: treeOid, size: 0 });
      }
    }
  }
  const out: Json[] = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name) as { type: 'file' | 'dir'; oid: Oid; size: number };
    const childPath = prefix + name;
    const encoded = encodeURIComponent(childPath).replace(/%2F/g, '/');
    const entry: Json = {
      type: child.type,
      name,
      path: childPath,
      sha: child.oid,
      url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${encoded}`,
      html_url: `${base}/${owner}/${repo.name}/${child.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${encoded}`,
      git_url: `${base}/api/v3/repos/${owner}/${repo.name}/git/${child.type === 'dir' ? 'trees' : 'blobs'}/${child.oid}`,
    };
    if (child.type === 'file') entry.size = child.size;
    out.push(entry);
  }
  return out;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  pathParts: string[],
  method: string,
  body: Json,
  url: URL,
): Promise<boolean> {
  const path = pathParts.join('/');
  const owner = repo.ownerLogin;
  const base = baseOf(req);
  const viewer = store.viewer;

  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === undefined) {
      err(res, 404, 'Not Found');
      return true;
    }
    const flat = treeAt(repo, tip);
    const file = flat.get(path);
    if (file !== undefined) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      json(res, 200, contentsFileJson(store, repo, path, file.oid, data, req));
      return true;
    }
    // A directory: some path lives under it (or the root listing).
    const prefix = path === '' ? '' : `${path}/`;
    const isDir = path === '' || [...flat.keys()].some((key) => key.startsWith(prefix));
    if (isDir) {
      json(res, 200, contentsDirJson(store, repo, path, tip, req));
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    if (path === '') {
      err(res, 404, 'Not Found');
      return true;
    }
    const message = asString(body.message);
    if (message === undefined || message === '') {
      err(res, 422, 'Validation Failed: message is required');
      return true;
    }
    const contentB64 = asString(body.content);
    if (contentB64 === undefined) {
      err(res, 422, 'Validation Failed: content is required');
      return true;
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const tip = repo.refs.size === 0 ? undefined : resolveRef(repo, branch);
    if (repo.refs.size > 0 && tip === undefined) {
      err(res, 404, 'Not Found');
      return true;
    }
    const flat = tip === undefined ? new Map() : treeAt(repo, tip);
    const existing = flat.get(path);
    const sha = asString(body.sha);
    if (existing !== undefined && sha === undefined) {
      err(res, 409, 'Validation Failed: sha wasn\'t supplied');
      return true;
    }
    if (existing !== undefined && sha !== existing.oid) {
      err(res, 409, 'Validation Failed: sha does not match the current blob');
      return true;
    }
    if (existing === undefined && sha !== undefined) {
      err(res, 422, 'Validation Failed: sha was supplied for a file that does not exist');
      return true;
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = storeObject(repo, 'blob', data);
    const files = new Map<string, { oid: Oid; mode: string }>();
    for (const [filePath, file] of flat) files.set(filePath, { oid: file.oid, mode: file.mode });
    files.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = writeTree(repo, files);
    const now = store.tick();
    const parents = tip === undefined ? [] : [tip];
    const commitOid = createCommit(repo, {
      tree: treeOid,
      parents,
      authorName: viewer.name,
      authorEmail: viewer.email,
      committerName: viewer.name,
      committerEmail: viewer.email,
      epoch: now.epoch,
      message,
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = now.iso;
    const commitBody = {
      sha: commitOid,
      message,
      author: { name: viewer.name, email: viewer.email, date: now.iso },
      committer: { name: viewer.name, email: viewer.email, date: now.iso },
      tree: { sha: treeOid },
      parents: parents.map((parent) => ({ sha: parent })),
    };
    json(res, existing === undefined ? 201 : 200, {
      content: contentsFileJson(store, repo, path, blobOid, data, req),
      commit: commitBody,
    });
    return true;
  }

  if (method === 'DELETE') {
    if (path === '') {
      err(res, 404, 'Not Found');
      return true;
    }
    const message = asString(body.message);
    if (message === undefined || message === '') {
      err(res, 422, 'Validation Failed: message is required');
      return true;
    }
    const branch = asString(body.branch) ?? repo.defaultBranch;
    const tip = resolveRef(repo, branch);
    if (tip === undefined) {
      err(res, 404, 'Not Found');
      return true;
    }
    const flat = treeAt(repo, tip);
    const existing = flat.get(path);
    if (existing === undefined) {
      err(res, 404, 'Not Found');
      return true;
    }
    const sha = asString(body.sha);
    if (sha === undefined || sha !== existing.oid) {
      err(res, 409, 'Validation Failed: sha does not match the current blob');
      return true;
    }
    const files = new Map<string, { oid: Oid; mode: string }>();
    for (const [filePath, file] of flat) {
      if (filePath !== path) files.set(filePath, { oid: file.oid, mode: file.mode });
    }
    const treeOid = writeTree(repo, files);
    const now = store.tick();
    const commitOid = createCommit(repo, {
      tree: treeOid,
      parents: [tip],
      authorName: viewer.name,
      authorEmail: viewer.email,
      committerName: viewer.name,
      committerEmail: viewer.email,
      epoch: now.epoch,
      message,
    });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = now.iso;
    json(res, 200, {
      commit: {
        sha: commitOid,
        message,
        author: { name: viewer.name, email: viewer.email, date: now.iso },
        committer: { name: viewer.name, email: viewer.email, date: now.iso },
        tree: { sha: treeOid },
        parents: [{ sha: tip }],
      },
    });
    return true;
  }

  err(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function parseLabelNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (isRecord(item) && typeof item.name === 'string') out.push(item.name);
    else return null;
  }
  return out;
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  tail: string[],
  method: string,
  body: Json,
  url: URL,
): Promise<boolean> {
  const owner = repo.ownerLogin;

  // POST /issues, GET /issues
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = asString(body.title);
      if (title === undefined || title.trim() === '') {
        err(res, 422, 'Validation Failed: title is required');
        return true;
      }
      const labelNames = body.labels === undefined ? [] : parseLabelNames(body.labels);
      if (labelNames === null) {
        err(res, 422, 'Validation Failed: labels must be an array of label names');
        return true;
      }
      for (const label of labelNames) {
        const known = store.getLabel(owner, repo.name, label) !== undefined || (SCENARIO_LABELS as readonly string[]).includes(label);
        if (!known) {
          err(res, 422, `Validation Failed: label ${JSON.stringify(label)} does not exist`);
          return true;
        }
      }
      const id = store.nextObjectId();
      const now = store.tick();
      const issue: Issue = {
        id,
        databaseId: id,
        nodeId: store.nodeId('I', id),
        number: repo.issueCounter,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        labels: [...new Set(labelNames)].map((name) => ({ name })),
        userLogin: store.viewer.login,
        createdAt: now.iso,
        updatedAt: now.iso,
        comments: [],
      };
      repo.issueCounter += 1;
      repo.issues.push(issue);
      json(res, 201, issueJson(store, repo, issue, req));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        err(res, 422, `Validation Failed: state must be open, closed or all`);
        return true;
      }
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const keyOf = (issue: Issue): string => (sort === 'updated' ? issue.updatedAt : issue.createdAt);
      items = [...items].sort((a, b) => {
        const cmp = keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      const { pageItems, headers } = paginate(req, url, items.map((issue) => issueJson(store, repo, issue, req)));
      json(res, 200, pageItems, headers);
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  // /issues/{n} and /issues/{n}/comments
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) {
    err(res, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.find((item) => item.number === number);
  if (issue === undefined) {
    err(res, 404, 'Not Found');
    return true;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      const sig = JSON.stringify([
        owner,
        repo.name,
        baseOf(req),
        issue.updatedAt,
        issue.state,
        issue.title,
        issue.body,
        issue.comments.length,
        issue.labels.map((label) => {
          const registered = store.getLabel(owner, repo.name, label.name);
          return [label.name, registered?.color ?? 'ededed', registered?.description ?? ''];
        }),
      ]);
      const hit = issueGetCache.get(issue);
      if (hit !== undefined && hit.sig === sig) {
        jsonRaw(res, 200, hit.text);
        return true;
      }
      const text = `${JSON.stringify(issueJson(store, repo, issue, req))}\n`;
      issueGetCache.set(issue, { sig, text });
      jsonRaw(res, 200, text);
      return true;
    }
    if (method === 'PATCH') {
      const state = asString(body.state);
      if (state !== undefined && state !== 'open' && state !== 'closed') {
        err(res, 422, 'Validation Failed: state must be open or closed');
        return true;
      }
      const title = asString(body.title);
      if (title !== undefined && title.trim() === '') {
        err(res, 422, 'Validation Failed: title must not be empty');
        return true;
      }
      const now = store.tick();
      if (state !== undefined) issue.state = state;
      if (title !== undefined) issue.title = title;
      if (asString(body.body) !== undefined) issue.body = asString(body.body) as string;
      issue.updatedAt = now.iso;
      json(res, 200, issueJson(store, repo, issue, req));
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const commentBody = asString(body.body);
      if (commentBody === undefined || commentBody.trim() === '') {
        err(res, 422, 'Validation Failed: body is required');
        return true;
      }
      const id = store.nextObjectId();
      const now = store.tick();
      const comment: IssueComment = {
        id,
        body: commentBody,
        userLogin: store.viewer.login,
        createdAt: now.iso,
      };
      issue.comments.push(comment);
      json(res, 201, commentJson(store, repo, issue, comment, req));
      return true;
    }
    if (method === 'GET') {
      const items = issue.comments.map((comment) => commentJson(store, repo, issue, comment, req));
      const { pageItems, headers } = paginate(req, url, items);
      json(res, 200, pageItems, headers);
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  err(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  tail: string[],
  method: string,
  body: Json,
  url: URL,
): Promise<boolean> {
  const owner = repo.ownerLogin;
  const viewer = store.viewer;

  // POST /pulls, GET /pulls
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = asString(body.title);
      if (title === undefined || title.trim() === '') {
        err(res, 422, 'Validation Failed: title is required');
        return true;
      }
      const head = asString(body.head);
      const base = asString(body.base);
      if (head === undefined || head === '' || base === undefined || base === '') {
        err(res, 422, 'Validation Failed: head and base are required');
        return true;
      }
      const headSha = resolveRef(repo, head);
      const baseSha = resolveRef(repo, base);
      if (headSha === undefined || baseSha === undefined) {
        err(res, 422, 'Validation Failed: head or base branch does not exist');
        return true;
      }
      if (head === base) {
        err(res, 422, 'Validation Failed: head and base must be different branches');
        return true;
      }
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) {
        err(res, 422, 'Validation Failed: a pull request already exists for this head and base');
        return true;
      }
      const id = store.nextObjectId();
      const now = store.tick();
      const pull: Pull = {
        id,
        databaseId: id,
        nodeId: store.nodeId('PR', id),
        number: repo.pullCounter,
        title,
        body: asString(body.body) ?? '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeable: computeMergeable(store, repo, headSha, baseSha),
        mergeCommitSha: null,
        createdAt: now.iso,
        updatedAt: now.iso,
      };
      repo.pullCounter += 1;
      repo.pulls.push(pull);
      json(res, 201, pullJson(store, repo, pull, req));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') {
        err(res, 422, 'Validation Failed: state must be open, closed or all');
        return true;
      }
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const keyOf = (pull: Pull): string => (sort === 'updated' ? pull.updatedAt : pull.createdAt);
      items = [...items].sort((a, b) => {
        const cmp = keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      const { pageItems, headers } = paginate(req, url, items.map((pull) => pullJson(store, repo, pull, req)));
      json(res, 200, pageItems, headers);
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) {
    err(res, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.find((item) => item.number === number);
  if (pull === undefined) {
    err(res, 404, 'Not Found');
    return true;
  }

  // GET /pulls/{n}
  if (tail.length === 1 && method === 'GET') {
    json(res, 200, pullJson(store, repo, pull, req));
    return true;
  }

  // GET /pulls/{n}/files — diff merge-base tree vs head tree
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTree = treeOidOf(repo, pull.headSha);
    const baseTree = treeOidOf(repo, pull.baseSha);
    if (headTree === undefined || baseTree === undefined) {
      json(res, 200, []);
      return true;
    }
    const mb = mergeBase(repo, pull.headSha, pull.baseSha);
    const mbTree = mb === null ? null : treeOidOf(repo, mb) ?? null;
    const headMap = treeAt(repo, headTree);
    const baseMap = mbTree === null ? new Map() : treeAt(repo, mbTree);
    const items = diffTrees(repo, mbTree, headTree).map((entry) => {
      let patch = '';
      const oldData = baseMap.get(entry.filename) === undefined ? Buffer.alloc(0) : repo.objects.get(baseMap.get(entry.filename)?.oid as string)?.data ?? Buffer.alloc(0);
      const newData = headMap.get(entry.filename) === undefined ? Buffer.alloc(0) : repo.objects.get(headMap.get(entry.filename)?.oid as string)?.data ?? Buffer.alloc(0);
      patch = diffLines(oldData, newData).patch;
      return {
        filename: entry.filename,
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        changes: entry.additions + entry.deletions,
        patch,
      };
    });
    json(res, 200, items);
    return true;
  }

  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged || pull.state === 'closed') {
      err(res, 405, pull.merged ? 'Pull request is already merged' : 'Pull request is closed');
      return true;
    }
    const methodName = asString(body.merge_method) ?? 'merge';
    if (methodName !== 'merge' && methodName !== 'squash') {
      err(res, 422, 'Validation Failed: merge_method must be merge or squash');
      return true;
    }
    const baseTip = resolveRef(repo, pull.baseRef);
    if (baseTip === undefined) {
      err(res, 409, 'Validation Failed: base branch does not exist');
      return true;
    }
    if (!computeMergeable(store, repo, pull.headSha, baseTip)) {
      err(res, 405, 'Merge conflict');
      return true;
    }
    const headTree = treeOidOf(repo, pull.headSha);
    if (headTree === undefined) {
      err(res, 409, 'Validation Failed: head commit is missing');
      return true;
    }
    const now = store.tick();
    const parents = methodName === 'squash' ? [baseTip] : [baseTip, pull.headSha];
    const message = methodName === 'squash' ? pull.title : `Merge pull request #${pull.number} from ${owner}/${pull.headRef}`;
    const mergeSha = createCommit(repo, {
      tree: headTree,
      parents,
      authorName: viewer.name,
      authorEmail: viewer.email,
      committerName: viewer.name,
      committerEmail: viewer.email,
      epoch: now.epoch,
      message,
    });
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = baseTip;
    pull.updatedAt = now.iso;
    repo.updatedAt = now.iso;
    json(res, 200, { merged: true, sha: mergeSha, merge_commit_sha: mergeSha, message });
    return true;
  }

  err(res, 404, 'Not Found');
  return true;
}
