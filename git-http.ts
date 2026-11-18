// git-http.ts — git smart HTTP: upload-pack (protocol v2 + v0) and receive-pack (v0).
//
// Wiring (see app.ts): the router calls
//   handleGit(req, res, store, token): Promise<boolean>
// with the Node request/response, the shared store and the expected bearer
// token ('' when unset). It returns true when the path is a git route.
// The pure core is routeGitRequest(), which takes method/path/query/headers/
// body and returns { status, headers, body } — the smoke tests drive that
// directly without a socket.
//
// Store contract (store.ts is written by another agent in parallel; until it
// lands these LOCAL structural types are the contract — a Store that
// satisfies them works unchanged. If store.ts's Repo shape differs, the
// parent only has to adapt these three interfaces):
//   interface GitObject { type: 'commit'|'tree'|'blob'|'tag'; data: Buffer }
//   interface Repo { id, name, ownerLogin, defaultBranch, refs: Map<string,string>,
//                    objects: Map<string, GitObject> }
//   interface Store { getRepo(owner, name): Repo | undefined;
//                     tick(): { iso: string; epoch: number };
//                     viewer: { id, login, name, email } }
//
// Routes (all require the Bearer token; owner must be the viewer login):
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack   (v2 if Git-Protocol: version=2, else v0)
//   GET  /:owner/:repo.git/info/refs?service=git-receive-pack  (v0)
//   POST /:owner/:repo.git/git-upload-pack                     (v2 ls-refs/fetch, or v0 fetch)
//   POST /:owner/:repo.git/git-receive-pack                    (v0 push, report-status + side-band-64k)
// Missing repo -> 404 JSON; wrong/missing token -> 401 JSON; malformed
// pkt-lines -> 400 JSON (the server stays up; nothing is mutated).
//
// Protocol notes (matched against kit program/env/src/git-client.ts):
// - v2 advertisement: `# service=git-upload-pack` + flush, then `version 2`
//   + `agent`, `ls-refs=unborn`, `fetch=shallow wait-for-done filter`,
//   `object-format=sha1`, then flush.
// - v0 advertisement: `# service=...` + flush, then `<oid> HEAD\0<caps>` (or
//   `<zero> capabilities^{}\0<caps>` for an empty repo), ref lines, peeled
//   `<oid> <ref>^{}` lines for annotated tags, then flush.
// - v2 fetch answers sections `acknowledgments` (ACKs or NAK + `ready`,
//   only when the client sent haves — a client that sent none expects the
//   packfile section next), `shallow-info` (`shallow`/`unshallow` lines),
//   `packfile` (sideband band 1, chunked to <=65515 data bytes a packet;
//   an empty pack when nothing is new). Sections are separated by DELIM
//   (0001) packets and the response ends with a single FLUSH (0000): a flush
//   between sections ends the whole response for real git, which then dies
//   with "expected packfile to be sent after 'ready'". The kit client treats
//   delim and flush alike as a section reset.
// - v0 fetch answers `NAK`, shallow/unshallow lines, then sideband band-1
//   pack packets, then flush.
// - receive-pack answers the report-status stream (`unpack ok`, `ok <ref>` /
//   `ng <ref> <reason>`) inside sideband band 1, then a bare flush. A
//   non-fast-forward update is refused per ref with reason `non-fast-forward`
//   and the ref does not move; fast-forward refs in the same push still apply.
// - Shallow: `deepen N` is the TOTAL depth from each want (the kit client's
//   `deepen 2`); with a `deepen-relative` line (real git's --deepen) N is
//   ADDITIONAL depth past the client's sent shallow boundary. The boundary is
//   the set of commits at distance N-1 with parents; `unshallow` names old
//   boundaries that are now interior. A `have` that is itself a shallow
//   boundary excludes only that commit + its tree (the client does not hold
//   its ancestors); any other `have` excludes its full reachable closure.
// - Determinism: no clock, no randomness in any state path. Pack object
//   order is sorted by oid.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { isObjectId, parseCommit, parseTag, parseTree, ZERO_OID } from './git-objects.ts';
import type { GitObjectType, TreeEntry } from './git-objects.ts';
import { buildPack, parsePack } from './git-pack.ts';
import {
  encodeAdvertisementLine,
  encodeDelim,
  encodeFlush,
  encodePktLine,
  encodePktLines,
  encodeSidebandStream,
  parsePktLines,
} from './git-pkt.ts';

// ---------------------------------------------------------------------------
// store contract (local; see the header comment)
// ---------------------------------------------------------------------------

/** A git object in the store: its type and its exact bytes (no loose header). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** A repository in the store. */
export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly ownerLogin: string;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
}

/** The store surface git-http needs. */
export interface Store {
  getRepo(owner: string, name: string): Repo | undefined;
  tick(): { iso: string; epoch: number };
  viewer: { id: number; login: string; name: string; email: string };
}

/** What routeGitRequest needs besides the store. */
export interface GitContext {
  /** The expected bearer token; '' means "any non-empty Bearer" (app.ts's rule). */
  readonly token: string;
}

/** A complete HTTP answer from the pure core. */
export interface GitResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const AGENT = 'github-core-clone/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const JSON_TYPE = 'application/json; charset=utf-8';
/** Largest request body accepted on a git POST (packs in the suite are far smaller). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const GIT_PATH_RE = /^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

// ---------------------------------------------------------------------------
// parsed-object caches (this file only)
// ---------------------------------------------------------------------------
//
// Objects are content-addressed and immutable, so a parsed view keyed by oid
// is valid forever; eviction only costs a re-parse. This matters on hot
// walks: isFastForward re-walks the whole chain on every push, and
// collectReachableObjects re-parses every commit/tree on every full fetch.

const PARSE_CACHE_MAX = 8192;
const commitParseCache = new Map<string, { tree: string; parents: readonly string[] }>();
const treeParseCache = new Map<string, readonly TreeEntry[]>();

function parseCacheSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= PARSE_CACHE_MAX) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** { tree, parents } of a commit object, parsed at most once per oid. */
function cachedCommit(
  objects: Map<string, GitObject>,
  oid: string,
): { tree: string; parents: readonly string[] } | null {
  const hit = commitParseCache.get(oid);
  if (hit !== undefined) return hit;
  const object = objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const view = { tree: parsed.tree, parents: parsed.parents };
  parseCacheSet(commitParseCache, oid, view);
  return view;
}

/** Entries of a tree object, parsed at most once per oid. */
function cachedTree(objects: Map<string, GitObject>, oid: string): readonly TreeEntry[] | null {
  const hit = treeParseCache.get(oid);
  if (hit !== undefined) return hit;
  const object = objects.get(oid);
  if (!object || object.type !== 'tree') return null;
  const entries = parseTree(object.data);
  parseCacheSet(treeParseCache, oid, entries);
  return entries;
}

// ---------------------------------------------------------------------------
// fetch-response cache (the pack cache)
// ---------------------------------------------------------------------------
//
// Keyed by everything that can change the response bytes: the protocol
// version, the repo identity, the repo's full ref set + object count, and
// every fetch parameter. Any mutation that changes reachable objects moves a
// ref (push, contents PUT/DELETE, merge, git/refs POST) or changes the
// object count (objects are only ever added; a delete/recreate restarts from
// empty refs), so a stale entry cannot survive a mutation that matters — and
// a key miss simply rebuilds. The stored Buffer is returned verbatim and is
// never mutated after construction, so a hit is byte-identical to a fresh
// build. Capped FIFO (oldest evicted first).

const FETCH_CACHE_MAX = 32;
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(
  repo: Repo,
  protocol: 'v0' | 'v2',
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
  deepenRelative: boolean,
): string {
  return JSON.stringify([
    protocol,
    repo.ownerLogin,
    repo.name,
    sortedRefs(repo),
    repo.objects.size,
    [...wants].sort(),
    [...haves].sort(),
    [...shallowBoundaries].sort(),
    depth ?? null,
    deepenRelative,
  ]);
}

function fetchCacheSet(key: string, body: Buffer): Buffer {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value as string | undefined;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, body);
  return body;
}

function jsonResponse(status: number, body: unknown): GitResponse {
  const text = `${JSON.stringify(body)}\n`;
  return { status, headers: { 'content-type': JSON_TYPE }, body: Buffer.from(text, 'utf8') };
}

function gitResponse(status: number, contentType: string, body: Buffer): GitResponse {
  return { status, headers: { 'content-type': contentType }, body };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree ->
 * entries (gitlinks skipped), tag -> its target, blob -> nothing. Missing
 * objects are skipped (the store is only ever filled with whole packs, so a
 * missing object means a corrupt store, and a fetch must still answer).
 */
export function collectReachableObjects(objects: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = cachedCommit(objects, oid);
      if (commit !== null) {
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of cachedTree(objects, oid) ?? []) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** The tree closure of one commit (the commit + its tree, recursively; no parents). */
function commitTreeClosure(objects: Map<string, GitObject>, commitOid: string): Set<string> {
  const out = new Set<string>();
  const commit = objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return out;
  out.add(commitOid);
  const parsed = cachedCommit(objects, commitOid);
  if (parsed === null) return out;
  const queue: string[] = [parsed.tree];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of cachedTree(objects, oid) ?? []) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return out;
}

/** Follow annotated tags to the final target oid (a commit, tree or blob). */
function resolveThroughTags(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
}

/** True when `ancestor` is `descendant` or one of its commit ancestors. */
export function isFastForward(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  const target = resolveThroughTags(objects, descendant);
  const base = resolveThroughTags(objects, ancestor);
  if (target === base) return true;
  const seen = new Set<string>();
  const queue: string[] = [target];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === base) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of cachedCommit(objects, oid)?.parents ?? []) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The peeled (target) oid of an annotated tag ref, or null for a lightweight tag. */
function peeledOid(repo: Repo, refOid: string): string | null {
  const object = repo.objects.get(refOid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

function uploadPackCapsV0(repo: Repo): string {
  // multi_ack_detailed (not just multi_ack): real git over smart HTTP runs
  // stateless RPC and refuses a v0 server without it ("the option
  // '--stateless-rpc' requires 'multi_ack_detailed'").
  return `multi_ack multi_ack_detailed thin-pack side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
}

function receivePackCapsV0(repo: Repo): string {
  return `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
}

/** A v0 ref advertisement body for `service`. */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = encodePktLine(`# service=${service}\n`);
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : receivePackCapsV0(repo);
  const parts: Buffer[] = [serviceLine, encodeFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodeAdvertisementLine(ZERO_OID, 'capabilities^{}', caps));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    parts.push(encodeAdvertisementLine(headOid, 'HEAD', caps));
    for (const [name, oid] of refs) {
      parts.push(encodeAdvertisementLine(oid, name));
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) parts.push(encodeAdvertisementLine(peeled, `${name}^{}`));
    }
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

/** A v2 capability advertisement body (upload-pack only). */
function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    encodeFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done filter\n'),
    encodePktLine('object-format=sha1\n'),
    encodeFlush(),
  ];
  return Buffer.concat(parts);
}

/** The v2 advertisement never varies: build it once, reuse it verbatim. */
const ADVERTISEMENT_V2 = advertisementV2();

// ---------------------------------------------------------------------------
// fetch computation (shared by v2 and v0)
// ---------------------------------------------------------------------------

interface FetchParams {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  /** The client's current shallow boundaries (sent as `shallow <oid>` lines). */
  readonly shallowBoundaries: readonly string[];
  /** Total depth from each want; undefined is a full fetch. */
  readonly depth?: number;
  /** v2 `deepen-relative`: `depth` is ADDITIONAL depth past the old boundary. */
  readonly deepenRelative?: boolean;
}

interface FetchPlan {
  /** Objects to send, sorted by oid for a deterministic pack. */
  readonly toSend: Array<{ type: GitObjectType; data: Buffer }>;
  /** The new shallow boundary commits (depth fetches only). */
  readonly shallow: string[];
  /** Old boundaries that are now interior. */
  readonly unshallow: string[];
  /** The wants the server could acknowledge (known commits). */
  readonly acks: string[];
}

function planFetch(repo: Repo, params: FetchParams): FetchPlan {
  const objects = repo.objects;
  const boundarySet = new Set(params.shallowBoundaries);
  const acks = params.haves.filter((have) => {
    const object = objects.get(have);
    return object !== undefined && object.type === 'commit';
  });

  // Resolve the effective depth. `deepen-relative` (real git's --deepen) means
  // `depth` is ADDITIONAL depth past the client's current boundary: the old
  // depth is 1 + the distance from a want to its nearest sent shallow
  // boundary. Without it, `depth` is already the total depth (the kit
  // client's `deepen N`). With no boundary on a want's ancestry, fall back
  // to the given depth as-is.
  let depth = params.depth;
  if (depth !== undefined && params.deepenRelative === true && boundarySet.size > 0) {
    let oldDepth = 0;
    for (const want of params.wants) {
      const root = resolveThroughTags(objects, want);
      const seen = new Set<string>();
      const queue: Array<[string, number]> = [[root, 0]];
      while (queue.length) {
        const [oid, dist] = queue.shift() as [string, number];
        if (boundarySet.has(oid)) {
          oldDepth = Math.max(oldDepth, dist + 1);
          break;
        }
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of cachedCommit(objects, oid)?.parents ?? []) queue.push([parent, dist + 1]);
      }
    }
    if (oldDepth > 0) depth = oldDepth + depth;
  }

  // The wanted closure, and the set of wanted commits (for shallow bookkeeping).
  let wantedObjects: Set<string>;
  let wantedCommits: Set<string>;
  let newBoundary = new Set<string>();
  if (depth === undefined) {
    wantedObjects = collectReachableObjects(objects, params.wants);
    wantedCommits = new Set([...wantedObjects].filter((oid) => objects.get(oid)?.type === 'commit'));
  } else {
    // Normalise wants through tags; a tag want contributes its tag object and
    // its target commit as the depth-0 root.
    const roots: string[] = [];
    const extraObjects = new Set<string>();
    for (const want of params.wants) {
      const object = objects.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        extraObjects.add(want);
        roots.push(resolveThroughTags(objects, want));
      } else if (object.type === 'commit') {
        roots.push(want);
      } else {
        extraObjects.add(want);
      }
    }
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const root of roots) {
      if (!distance.has(root)) {
        distance.set(root, 0);
        queue.push(root);
      }
    }
    wantedCommits = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      const dist = distance.get(oid) as number;
      if (dist >= depth) continue;
      wantedCommits.add(oid);
      const object = objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of cachedCommit(objects, oid)?.parents ?? []) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push(parent);
        }
      }
    }
    for (const oid of wantedCommits) {
      if ((distance.get(oid) as number) === depth - 1) {
        const object = objects.get(oid);
        if (object && object.type === 'commit' && (cachedCommit(objects, oid)?.parents.length ?? 0) > 0) {
          newBoundary.add(oid);
        }
      }
    }
    wantedObjects = new Set<string>(extraObjects);
    for (const oid of wantedCommits) {
      for (const member of commitTreeClosure(objects, oid)) wantedObjects.add(member);
    }
  }

  // The exclusion set: what the client already holds. A have that is itself a
  // shallow boundary excludes only that commit + its tree; any other have
  // excludes its full reachable closure.
  const held = new Set<string>();
  for (const have of params.haves) {
    if (!objects.has(have)) continue;
    if (boundarySet.has(have)) {
      const target = resolveThroughTags(objects, have);
      if (have !== target) held.add(have);
      for (const member of commitTreeClosure(objects, target)) held.add(member);
    } else {
      for (const member of collectReachableObjects(objects, [have])) held.add(member);
    }
  }

  const toSend: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const oid of [...wantedObjects].sort()) {
    if (held.has(oid)) continue;
    const object = objects.get(oid);
    if (object) toSend.push({ type: object.type, data: object.data });
  }

  const unshallow = [...boundarySet].filter((oid) => wantedCommits.has(oid) && !newBoundary.has(oid)).sort();
  return { toSend, shallow: [...newBoundary].sort(), unshallow, acks };
}

// ---------------------------------------------------------------------------
// v2 handlers
// ---------------------------------------------------------------------------

/** v2 ls-refs: `<oid> <ref>` lines (+ `symref-target:` / `peeled:` attributes). */
function handleLsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headOid} HEAD\n`);
    } else {
      lines.push(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : 'unborn HEAD\n');
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v2 fetch: acknowledgments + shallow-info + packfile sections. */
function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  let deepenRelative = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / done / agent / object-format: accepted, no effect.
  }
  // Identical fetch, identical bytes: serve the cached response (see the
  // fetch-cache note above the key builder) without re-planning or rebuilding.
  const cacheKey = fetchCacheKey(repo, 'v2', wants, haves, shallowBoundaries, depth, deepenRelative);
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, { wants, haves, shallowBoundaries, depth, deepenRelative });
  // Always a packfile section (an empty pack when nothing is new): real git
  // expects the section after the acknowledgments, and the kit client reads
  // an empty pack as zero objects.
  const pack = buildPack(plan.toSend);

  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves: real
  // git, which sent none, goes straight to expecting the packfile section.
  if (haves.length) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(encodePktLine('ready\n'));
    parts.push(encodeDelim());
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodeDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  for (const packet of encodeSidebandStream(1, pack)) parts.push(packet);
  parts.push(encodeFlush());
  return fetchCacheSet(cacheKey, Buffer.concat(parts));
}

/** Parse a v2 upload-pack request body into { command, args } (throws on malformed). */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const first = parsePktLines(body);
  const headerLines = first.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
  if (first.rest.length < 4 || first.rest.subarray(0, 4).toString('ascii') !== '0001') {
    throw new Error('v2 request has no delim after the command');
  }
  const second = parsePktLines(first.rest.subarray(4));
  const args = second.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
  const commandLine = headerLines.find((line) => line.startsWith('command='));
  if (!commandLine) throw new Error('v2 request names no command');
  return { command: commandLine.slice('command='.length), args };
}

// ---------------------------------------------------------------------------
// v0 fetch handler
// ---------------------------------------------------------------------------

/** v0 fetch: NAK, shallow/unshallow lines, then sideband band-1 pack packets. */
function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const first = parsePktLines(body);
  const wantLines = first.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));
  let rest = first.rest;
  if (rest.length >= 4 && rest.subarray(0, 4).toString('ascii') === '0000') rest = rest.subarray(4);
  const second = parsePktLines(rest);
  const haveLines = second.lines.map((line) => line.toString('utf8').replace(/\n$/, ''));

  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | undefined;
  for (const line of [...wantLines, ...haveLines]) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
    // deepen-since / deepen-not / done: accepted, no effect.
  }
  if (!wants.length) throw new Error('v0 fetch names no want');
  const cacheKey = fetchCacheKey(repo, 'v0', wants, haves, shallowBoundaries, depth, false);
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, { wants, haves, shallowBoundaries, depth });
  // Always a (possibly empty) pack: real git reads the sideband pack after
  // NAK, and the kit client reads an empty pack as zero objects.
  const pack = buildPack(plan.toSend);

  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of encodeSidebandStream(1, pack)) parts.push(packet);
  parts.push(encodeFlush());
  return fetchCacheSet(cacheKey, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// receive-pack handler
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

interface PushDecision {
  readonly command: PushCommand;
  readonly ok: boolean;
  readonly reason: string;
}

/** Parse a receive-pack body into commands + pack bytes (throws on malformed). */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const parsed = parsePktLines(body);
  if (parsed.lines.length === 0) throw new Error('receive-pack names no commands');
  const commands: PushCommand[] = [];
  for (const raw of parsed.lines) {
    const text = raw.toString('utf8');
    const nul = text.indexOf('\u0000');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  let pack = Buffer.alloc(0);
  const rest = parsed.rest;
  if (rest.length >= 4 && rest.subarray(0, 4).toString('ascii') === '0000') {
    pack = rest.subarray(4);
  } else if (rest.length > 0) {
    throw new Error('receive-pack has bytes after the commands that are not a flush + pack');
  }
  return { commands, pack };
}

/** Decide every command against the pre-push refs; apply the ok ones. */
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePack(body);

  // Unpack first: a corrupt pack refuses every ref and stores nothing.
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const objects = parsePack(pack);
      for (const [oid, object] of objects) repo.objects.set(oid, { type: object.type, data: object.data });
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const decisions: PushDecision[] = [];
  if (unpackError !== null) {
    for (const command of commands) decisions.push({ command, ok: false, reason: 'unpack failed' });
  } else {
    const current = new Map(repo.refs);
    for (const command of commands) {
      const cur = current.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        decisions.push({ command, ok: false, reason: 'invalid command' });
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (cur !== undefined) decisions.push({ command, ok: false, reason: 'already exists' });
        else if (!repo.objects.has(command.newOid)) decisions.push({ command, ok: false, reason: 'object not found' });
        else decisions.push({ command, ok: true, reason: '' });
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (cur === undefined) decisions.push({ command, ok: false, reason: 'ref does not exist' });
        else if (cur !== command.oldOid) decisions.push({ command, ok: false, reason: 'old value does not match' });
        else decisions.push({ command, ok: true, reason: '' });
      } else {
        // Update.
        if (cur === undefined) decisions.push({ command, ok: false, reason: 'ref does not exist' });
        else if (cur !== command.oldOid) decisions.push({ command, ok: false, reason: 'old value does not match' });
        else if (!repo.objects.has(command.newOid)) decisions.push({ command, ok: false, reason: 'object not found' });
        else if (command.newOid === command.oldOid) decisions.push({ command, ok: true, reason: '' });
        else if (command.ref.startsWith('refs/tags/')) decisions.push({ command, ok: true, reason: '' });
        else if (isFastForward(repo.objects, command.oldOid, command.newOid)) decisions.push({ command, ok: true, reason: '' });
        else decisions.push({ command, ok: false, reason: 'non-fast-forward' });
      }
    }
    for (const decision of decisions) {
      if (!decision.ok) continue;
      if (decision.command.newOid === ZERO_OID) repo.refs.delete(decision.command.ref);
      else repo.refs.set(decision.command.ref, decision.command.newOid);
    }
  }

  // Report-status stream inside sideband band 1, then a bare flush.
  const reportLines: Array<string | 'flush'> = [
    unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n',
  ];
  for (const decision of decisions) {
    reportLines.push(
      decision.ok ? `ok ${decision.command.ref}\n` : `ng ${decision.command.ref} ${decision.reason}\n`,
    );
  }
  reportLines.push('flush');
  const reportStream = encodePktLines(reportLines);
  const parts: Buffer[] = [...encodeSidebandStream(1, reportStream), encodeFlush()];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// pure core: route one git request
// ---------------------------------------------------------------------------

/**
 * Route one git request without a socket. `pathname` is the URL path (no
 * query); `query` the parsed query string; `headers` the lower-cased request
 * headers; `body` the raw request body. Returns the full HTTP answer.
 */
export async function routeGitRequest(
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Readonly<Record<string, string | undefined>>,
  body: Buffer,
  store: Store,
  ctx: GitContext,
): Promise<GitResponse> {
  // Auth first: a missing/wrong Bearer token is 401, whatever the path.
  const authorization = headers.authorization ?? '';
  const bearer = /^Bearer\s+(.+)$/.exec(authorization)?.[1] ?? '';
  if (ctx.token === '') {
    if (bearer === '') return jsonResponse(401, { message: 'Unauthorized' });
  } else if (bearer !== ctx.token) {
    return jsonResponse(401, { message: 'Unauthorized' });
  }

  const segments = pathname.split('/').filter((part) => part !== '');
  if (segments.length < 2) return jsonResponse(404, { message: 'Not Found' });
  const owner = decodeURIComponent(segments[0] as string);
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return jsonResponse(404, { message: 'Not Found' });
  const repoName = decodeURIComponent(repoSegment.slice(0, -'.git'.length));
  const rest = segments.slice(2).join('/');

  // The repository belongs to the token's login: any other owner is 404, never 403.
  if (owner !== VIEWER.login) return jsonResponse(404, { message: 'Not Found' });
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });

  if (method === 'GET' && rest === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const isV2 = (headers['git-protocol'] ?? '') === 'version=2';
      return gitResponse(200, UPLOAD_AD, isV2 ? ADVERTISEMENT_V2 : advertisementV0(repo, 'git-upload-pack'));
    }
    if (service === 'git-receive-pack') {
      return gitResponse(200, RECEIVE_AD, advertisementV0(repo, 'git-receive-pack'));
    }
    return jsonResponse(404, { message: 'Not Found' });
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    try {
      const isV2 = (headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') return gitResponse(200, UPLOAD_RESULT, handleLsRefsV2(repo, args));
        if (command === 'fetch') return gitResponse(200, UPLOAD_RESULT, handleFetchV2(repo, args));
        return jsonResponse(400, { message: `unsupported command ${command}` });
      }
      return gitResponse(200, UPLOAD_RESULT, handleFetchV0(repo, body));
    } catch (err) {
      return jsonResponse(400, { message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    try {
      return gitResponse(200, RECEIVE_RESULT, handleReceivePack(repo, body));
    } catch (err) {
      return jsonResponse(400, { message: err instanceof Error ? err.message : String(err) });
    }
  }

  return jsonResponse(404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// Node adapter: the signature app.ts calls
// ---------------------------------------------------------------------------

/** Read a request body, capped (throws when it is larger). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Handle one git smart-HTTP request. Returns true when the path is a git
 * route (the response is written); false otherwise, so the router can fall
 * through to its own 404. Never throws for an expected error — a malformed
 * request is answered 400/401/404 and the server keeps serving.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  token: string,
): Promise<boolean> {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    return false;
  }
  if (!GIT_PATH_RE.test(pathname)) return false;

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const answer = await routeGitRequest(req.method ?? 'GET', pathname, query, headers, body, store, { token });
    if (!res.headersSent) {
      res.writeHead(answer.status, { ...answer.headers, 'content-length': answer.body.length });
    }
    res.end(answer.body);
  } catch (err) {
    process.stderr.write(`[git-http] ${req.method} ${pathname}: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      const body = Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8');
      res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': body.length });
      res.end(body);
    } else if (!res.writableEnded) {
      res.end();
    }
  }
  return true;
}
