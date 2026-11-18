// store.ts — THE store for the github-core-clone-01 entry.
//
// Single source of truth for repos, git objects, issues and pull requests.
// The git / GraphQL / MCP modules import from here; the interface below is
// the contract — do not rename or drop exports.
//
// Determinism: no Date.now(), no Math.random(), no crypto randomness anywhere
// in state paths. All timestamps come from a logical clock: base
// 2025-01-01T00:00:00Z plus a monotonic counter in seconds; every mutation
// ticks it once. Git object ids are SHA-1 content hashes (deterministic).
//
// Git object encoding is real git encoding (commit/tree/blob as git writes
// them), so objects created here are valid for the git smart-HTTP layer.
// Commit/tree parsing is implemented HERE (minimal, git-correct); there was
// no git-objects.ts when this file was written, so the git agent should reuse
// parseCommit / parseTree / hashObject / storeObject / writeTree /
// createCommit from this module instead of re-implementing them.
//
// Refs: Repo.refs keys are FULL ref names, e.g. 'refs/heads/main'.
// Per-repo label registries live on the Store (Store.labels), keyed by
// 'owner/name', so the Repo interface stays exactly as contracted.

import { createHash } from 'node:crypto';

export type Oid = string;

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  databaseId: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  databaseId: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: Oid;
  baseSha: Oid;
  mergeable: boolean;
  mergeCommitSha: Oid | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  databaseId: number;
  nodeId: string;
  name: string;
  ownerLogin: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  hasIssuesEnabled: true;
  refs: Map<string, Oid>;
  objects: Map<Oid, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  issueCounter: number;
  pullCounter: number;
}

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** One label registered on a repo through POST /labels. */
export interface RepoLabel {
  name: string;
  color: string;
  description: string;
}

/** The scenario's global label set (wire.ts ISSUE_LABELS). */
export const SCENARIO_LABELS: readonly string[] = [
  'bug',
  'enhancement',
  'documentation',
  'question',
  'good first issue',
  'help wanted',
];

/** Logical-clock base: 2025-01-01T00:00:00Z, in epoch seconds. */
export const CLOCK_BASE_EPOCH = 1735689600;

/** The empty tree's oid (git's well-known constant). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A parsed git commit object (no sha; the caller knows it). */
export interface ParsedCommit {
  tree: Oid;
  parents: Oid[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  committerDate: string;
  message: string;
}

export interface ParsedCommitWithSha extends ParsedCommit {
  sha: Oid;
}

/** One entry of a parsed git tree object. */
export interface ParsedTreeEntry {
  mode: string;
  name: string;
  oid: Oid;
  type: 'tree' | 'blob';
}

/** One flat file entry of a flattened tree. */
export interface FlatFile {
  oid: Oid;
  mode: string;
  type: 'tree' | 'blob';
}

export class Store {
  viewer: Viewer;
  repos: Map<string, Repo>;
  /** Per-repo label registries, keyed by 'owner/name'. */
  labels: Map<string, Map<string, RepoLabel>>;

  #clock: number;
  #repoIdCounter: number;
  #entityIdCounter: number;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.repos = new Map();
    this.labels = new Map();
    this.#clock = 0;
    this.#repoIdCounter = 100000;
    this.#entityIdCounter = 100000;
  }

  /** Advance the logical clock one second and return the new timestamp. */
  tick(): { iso: string; epoch: number } {
    const epoch = CLOCK_BASE_EPOCH + this.#clock;
    this.#clock += 1;
    return { iso: new Date(epoch * 1000).toISOString(), epoch };
  }

  /** Next repository id (starts at 100000). */
  nextRepoId(): number {
    const id = this.#repoIdCounter;
    this.#repoIdCounter += 1;
    return id;
  }

  /**
   * Next id for issues, pull requests and comments: ONE global counter
   * starting at 100000, shared across all three kinds.
   */
  nextObjectId(): number {
    const id = this.#entityIdCounter;
    this.#entityIdCounter += 1;
    return id;
  }

  /** Stable node id: kind + '_' + base64url(String(id)). */
  nodeId(kind: 'R' | 'I' | 'PR' | 'C', id: number): string {
    return `${kind}_${Buffer.from(String(id), 'utf8').toString('base64url')}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Repo {
    const id = this.nextRepoId();
    const now = this.tick();
    const repo: Repo = {
      id,
      databaseId: id,
      nodeId: this.nodeId('R', id),
      name,
      ownerLogin: this.viewer.login,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      createdAt: now.iso,
      updatedAt: now.iso,
      hasIssuesEnabled: true,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      issueCounter: 1,
      pullCounter: 1,
    };
    this.repos.set(`${repo.ownerLogin}/${name}`, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    this.labels.delete(`${owner}/${name}`);
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Repos of one owner, in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.ownerLogin === owner) out.push(repo);
    }
    return out;
  }

  // -- per-repo labels -------------------------------------------------------

  getLabels(owner: string, name: string): RepoLabel[] {
    const map = this.labels.get(`${owner}/${name}`);
    return map === undefined ? [] : [...map.values()];
  }

  getLabel(owner: string, name: string, labelName: string): RepoLabel | undefined {
    return this.labels.get(`${owner}/${name}`)?.get(labelName);
  }

  /** Register a label on a repo; false when a label of that name exists. */
  addLabel(owner: string, name: string, label: RepoLabel): boolean {
    const key = `${owner}/${name}`;
    let map = this.labels.get(key);
    if (map === undefined) {
      map = new Map();
      this.labels.set(key, map);
    }
    if (map.has(label.name)) return false;
    map.set(label.name, label);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Git object helpers (content hashes; deterministic, no randomness)
// ---------------------------------------------------------------------------

/** The git object id of `data` as an object of `type` (sha1 of header+data). */
export function hashObject(type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): Oid {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in the repo if absent; return its oid. */
export function storeObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): Oid {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Parse a git tree object into its entries, in stored order. */
export function parseTree(data: Buffer): ParsedTreeEntry[] {
  const entries: ParsedTreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) break;
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, type: mode === '40000' ? 'tree' : 'blob' });
    offset = nul + 21;
  }
  return entries;
}

function parseIdent(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', epoch: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', epoch: Number(match[3]) };
}

/** Parse a git commit object. The message has one trailing newline stripped (git-log behaviour). */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorEpoch: 0,
    authorDate: new Date(0).toISOString(),
    committerName: '',
    committerEmail: '',
    committerEpoch: 0,
    committerDate: new Date(0).toISOString(),
    message,
  };
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) continue; // multi-line header continuation (e.g. gpgsig)
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const ident = parseIdent(line.slice(7));
      out.authorName = ident.name;
      out.authorEmail = ident.email;
      out.authorEpoch = ident.epoch;
      out.authorDate = new Date(ident.epoch * 1000).toISOString();
    } else if (line.startsWith('committer ')) {
      const ident = parseIdent(line.slice(10));
      out.committerName = ident.name;
      out.committerEmail = ident.email;
      out.committerEpoch = ident.epoch;
      out.committerDate = new Date(ident.epoch * 1000).toISOString();
    }
  }
  return out;
}

/** Build and store a commit object; return its oid. Message is stored verbatim. */
export function createCommit(
  repo: Repo,
  opts: {
    tree: Oid;
    parents: Oid[];
    authorName: string;
    authorEmail: string;
    committerName: string;
    committerEmail: string;
    epoch: number;
    message: string;
  },
): Oid {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.authorName} <${opts.authorEmail}> ${opts.epoch} +0000`);
  lines.push(`committer ${opts.committerName} <${opts.committerEmail}> ${opts.epoch} +0000`);
  const text = `${lines.join('\n')}\n\n${opts.message}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/**
 * Build nested tree objects for a flat file map and store them; return the
 * root tree oid. Entries are sorted git-style (directory names sort as if
 * they had a trailing '/').
 */
export function writeTree(repo: Repo, files: Map<string, { oid: Oid; mode: string }>): Oid {
  if (files.size === 0) return storeObject(repo, 'tree', Buffer.alloc(0));
  // Group by first path segment; recurse per directory.
  const dirs = new Map<string, Map<string, { oid: Oid; mode: string }>>();
  const leaves: { mode: string; name: string; oid: Oid; type: 'tree' | 'blob' }[] = [];
  for (const [path, file] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      leaves.push({ mode: file.mode, name: path, oid: file.oid, type: 'blob' });
    } else {
      const dir = path.slice(0, slash);
      const rest = path.slice(slash + 1);
      let sub = dirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(rest, file);
    }
  }
  const entries: { mode: string; name: string; oid: Oid; type: 'tree' | 'blob' }[] = [...leaves];
  for (const [dir, sub] of dirs) {
    entries.push({ mode: '40000', name: dir, oid: writeTree(repo, sub), type: 'tree' });
  }
  entries.sort((a, b) => {
    const an = a.type === 'tree' ? `${a.name}/` : a.name;
    const bn = b.type === 'tree' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

/** The tree oid of a commit object, or undefined when it is not a commit. */
export function treeOidOf(repo: Repo, commitOid: Oid): Oid | undefined {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  const tree = parseCommit(obj.data).tree;
  return tree === '' ? undefined : tree;
}

/**
 * Resolve a branch name ('main'), a full ref ('refs/heads/main') or a commit
 * oid to a commit oid; undefined when nothing matches.
 */
export function resolveRef(repo: Repo, refOrOid: string): Oid | undefined {
  const direct = repo.refs.get(refOrOid);
  if (direct !== undefined) return direct;
  const headed = repo.refs.get(`refs/heads/${refOrOid}`);
  if (headed !== undefined) return headed;
  const obj = repo.objects.get(refOrOid);
  if (obj !== undefined && obj.type === 'commit') return refOrOid;
  return undefined;
}

/** The oid of the tree object at `dirPath` under `treeOid`, or undefined. */
export function subtreeOid(repo: Repo, treeOid: Oid, dirPath: string): Oid | undefined {
  const segments = dirPath.split('/').filter((part) => part !== '');
  let current: Oid | undefined = treeOid;
  for (const segment of segments) {
    if (current === undefined) return undefined;
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((item) => item.name === segment && item.type === 'tree');
    current = entry?.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// History / tree queries shared by REST, GraphQL and git
// ---------------------------------------------------------------------------

/** First-parent walk from `tipOid`; newest commit first. */
export function walkCommits(repo: Repo, tipOid: Oid): ParsedCommitWithSha[] {
  const out: ParsedCommitWithSha[] = [];
  const seen = new Set<Oid>();
  let current: Oid | undefined = tipOid;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    const parsed = parseCommit(obj.data);
    out.push({ ...parsed, sha: current });
    current = parsed.parents[0];
  }
  return out;
}

/**
 * Flatten a tree (given as a commit oid or a tree oid) into path -> file.
 * Directories are descended, never listed.
 */
export function treeAt(repo: Repo, oid: Oid): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const obj = repo.objects.get(oid);
  if (obj === undefined) return out;
  let treeOid = oid;
  if (obj.type === 'commit') {
    const tree = parseCommit(obj.data).tree;
    if (tree === '') return out;
    treeOid = tree;
  } else if (obj.type !== 'tree') {
    return out;
  }
  const descend = (tree: Oid, prefix: string): void => {
    const treeObj = repo.objects.get(tree);
    if (treeObj === undefined || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.type === 'tree') descend(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode, type: 'blob' });
    }
  };
  descend(treeOid, '');
  return out;
}

/** Read a file at a ref (branch name, full ref or commit oid). */
export function readFile(repo: Repo, refOrOid: string, path: string): { oid: Oid; data: Buffer } | undefined {
  const tip = resolveRef(repo, refOrOid);
  if (tip === undefined) return undefined;
  const entry = treeAt(repo, tip).get(path);
  if (entry === undefined) return undefined;
  const obj = repo.objects.get(entry.oid);
  if (obj === undefined || obj.type !== 'blob') return undefined;
  return { oid: entry.oid, data: obj.data };
}

// ---------------------------------------------------------------------------
// Line diff (shared by diffTrees and the PR files endpoint)
// ---------------------------------------------------------------------------

export interface DiffOp {
  kind: ' ' | '+' | '-';
  text: string;
}

export interface LineDiff {
  additions: number;
  deletions: number;
  ops: DiffOp[];
  patch: string;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function multisetDiff(oldLines: string[], newLines: string[]): LineDiff {
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  const newCount = new Map<string, number>();
  for (const line of newLines) newCount.set(line, (newCount.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  const ops: DiffOp[] = [];
  for (const [line, count] of oldCount) {
    const keep = Math.min(count, newCount.get(line) ?? 0);
    for (let i = keep; i < count; i += 1) {
      deletions += 1;
      ops.push({ kind: '-', text: line });
    }
  }
  for (const [line, count] of newCount) {
    const keep = Math.min(count, oldCount.get(line) ?? 0);
    for (let i = keep; i < count; i += 1) {
      additions += 1;
      ops.push({ kind: '+', text: line });
    }
  }
  return { additions, deletions, ops, patch: '' };
}

/** LCS line diff of two blobs; also builds a single-hunk unified patch. */
export function diffLines(oldData: Buffer, newData: Buffer): LineDiff {
  const oldLines = splitLines(oldData);
  const newLines = splitLines(newData);
  const n = oldLines.length;
  const m = newLines.length;
  let result: LineDiff;
  if (n * m > 1000000) {
    result = multisetDiff(oldLines, newLines);
  } else {
    // LCS length table (n+1) x (m+1).
    const table: Uint32Array[] = [];
    for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = table[i] as Uint32Array;
      const next = table[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] = oldLines[i] === newLines[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
      }
    }
    const ops: DiffOp[] = [];
    let additions = 0;
    let deletions = 0;
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldLines[i] === newLines[j]) {
        ops.push({ kind: ' ', text: oldLines[i] as string });
        i += 1;
        j += 1;
      } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
        ops.push({ kind: '-', text: oldLines[i] as string });
        deletions += 1;
        i += 1;
      } else {
        ops.push({ kind: '+', text: newLines[j] as string });
        additions += 1;
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ kind: '-', text: oldLines[i] as string });
      deletions += 1;
      i += 1;
    }
    while (j < m) {
      ops.push({ kind: '+', text: newLines[j] as string });
      additions += 1;
      j += 1;
    }
    result = { additions, deletions, ops, patch: '' };
  }
  const oldStart = n === 0 ? 0 : 1;
  const newStart = m === 0 ? 0 : 1;
  const patchLines = [`@@ -${oldStart},${n} +${newStart},${m} @@`];
  for (const op of result.ops) patchLines.push(`${op.kind}${op.text}`);
  result.patch = patchLines.join('\n');
  return result;
}

export interface TreeDiffEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

/**
 * Diff two trees (commit oids or tree oids; null = empty tree).
 * Line counts come from an LCS diff of the blob bytes.
 */
export function diffTrees(repo: Repo, baseTree: Oid | null, headTree: Oid | null): TreeDiffEntry[] {
  const base = baseTree === null ? new Map<string, FlatFile>() : treeAt(repo, baseTree);
  const head = headTree === null ? new Map<string, FlatFile>() : treeAt(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const filename of [...paths].sort()) {
    const inBase = base.get(filename);
    const inHead = head.get(filename);
    if (inBase === undefined && inHead !== undefined) {
      const headData = repo.objects.get(inHead.oid)?.data ?? Buffer.alloc(0);
      const diff = diffLines(Buffer.alloc(0), headData);
      out.push({ filename, status: 'added', additions: diff.additions, deletions: diff.deletions });
    } else if (inBase !== undefined && inHead === undefined) {
      const baseData = repo.objects.get(inBase.oid)?.data ?? Buffer.alloc(0);
      const diff = diffLines(baseData, Buffer.alloc(0));
      out.push({ filename, status: 'removed', additions: diff.additions, deletions: diff.deletions });
    } else if (inBase !== undefined && inHead !== undefined && inBase.oid !== inHead.oid) {
      const baseData = repo.objects.get(inBase.oid)?.data ?? Buffer.alloc(0);
      const headData = repo.objects.get(inHead.oid)?.data ?? Buffer.alloc(0);
      const diff = diffLines(baseData, headData);
      out.push({ filename, status: 'modified', additions: diff.additions, deletions: diff.deletions });
    }
  }
  return out;
}

/** All ancestors of `tip` (including itself), via parent links. */
function ancestorSet(repo: Repo, tip: Oid): Set<Oid> {
  const out = new Set<Oid>();
  const stack: Oid[] = [tip];
  while (stack.length > 0) {
    const current = stack.pop() as Oid;
    if (out.has(current)) continue;
    out.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return out;
}

/** Ancestors of `tip` in breadth-first order (tip first, parents after). */
function bfsOrder(repo: Repo, tip: Oid): Oid[] {
  const out: Oid[] = [];
  const seen = new Set<Oid>();
  const queue: Oid[] = [tip];
  while (queue.length > 0) {
    const current = queue.shift() as Oid;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

/**
 * Best common ancestor of two commits (git's merge-base): a common ancestor
 * that is not itself an ancestor of any other common ancestor. Candidates
 * are tried closest-to-`b` first, so the result is deterministic.
 */
export function mergeBase(repo: Repo, aOid: Oid, bOid: Oid): Oid | null {
  const ancestorsA = ancestorSet(repo, aOid);
  const common = [...ancestorSet(repo, bOid)].filter((oid) => ancestorsA.has(oid));
  if (common.length === 0) return null;
  for (const candidate of bfsOrder(repo, bOid)) {
    if (!ancestorsA.has(candidate)) continue;
    let dominated = false;
    for (const other of common) {
      if (other !== candidate && isAncestor(repo, candidate, other)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) return candidate;
  }
  return common[0] ?? null;
}

/** Whether `anc` is an ancestor of (or equal to) `desc`. */
export function isAncestor(repo: Repo, anc: Oid, desc: Oid): boolean {
  if (anc === desc) return true;
  const stack: Oid[] = [desc];
  const seen = new Set<Oid>();
  while (stack.length > 0) {
    const current = stack.pop() as Oid;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === anc) return true;
      stack.push(parent);
    }
  }
  return false;
}
