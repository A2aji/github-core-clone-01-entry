// git-objects.ts — git object ids and object encoding/decoding (commit/tree/blob/tag).
// SHA-1 ids exactly as git computes them: SHA-1 over `<type> <size>\0` + content.
// No I/O, no clock, no randomness.
//
// Exported API:
//   GitObjectType, ZERO_OID, isObjectId(oid),
//   hashObject(type, data): string,
//   encodeObject(type, data): Buffer        // loose-object bytes: `<type> <len>\0` + data
//   parseCommit(buf): CommitView { tree, parents, author, committer, message, extraHeaders }
//   parseTree(buf): TreeEntry[]             // [{ mode, name, oid }], stored order
//   parseTag(buf): TagView { object, type, tag, tagger, message }
//   buildCommit({ tree, parents?, author?, committer?, message, timestamp?, timezone? }): Buffer
//   buildTree(entries): Buffer              // entries sorted git-style
//   buildTag({ object, type, tag, tagger?, message, timestamp?, timezone? }): Buffer
//
// Identity strings are `Name <email>`; a timestamp is Unix seconds (default
// 2025-01-01T00:00:00Z) and the timezone defaults to `+0000`, so builds are
// deterministic. The server never builds commits itself — these helpers exist
// for tests and for the store's commit/tree construction.

import { createHash } from 'node:crypto';

/** The four object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** The all-zero object id: an unborn branch's old/new value in a receive-pack command. */
export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id (the only id form accepted). */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** The loose-object header `<type> <size>\0` that prefixes the bytes a SHA-1 is computed over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** The full loose-object bytes (header + content), as `git cat-file` would hash them. */
export function encodeObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `160000`, ...). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Any headers before the blank line that are not modelled (`gpgsig`, `encoding`, ...). */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object; refuses a malformed header layout. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('commit has a bad parent id');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** The default identity a built commit/tag carries when the caller names none. */
export const DEFAULT_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
/** The default timestamp for a built commit/tag: 2025-01-01T00:00:00Z (deterministic). */
export const DEFAULT_TIMESTAMP = 1_735_689_600;

/** Fields for a deterministic commit object. */
export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  /** Identity `Name <email>`; defaults to DEFAULT_IDENTITY. */
  readonly author?: string;
  readonly committer?: string;
  readonly message: string;
  /** Unix seconds; defaults to DEFAULT_TIMESTAMP. Never Date.now(). */
  readonly timestamp?: number;
  /** `+0000` by default, so two runs produce the same bytes. */
  readonly timezone?: string;
}

/** Build a commit object's bytes. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const timestamp = fields.timestamp ?? DEFAULT_TIMESTAMP;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Fields for a deterministic annotated tag object. */
export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  /** Identity `Name <email>`; defaults to DEFAULT_IDENTITY. */
  readonly tagger?: string;
  /** Unix seconds; defaults to DEFAULT_TIMESTAMP. Never Date.now(). */
  readonly timestamp?: number;
  /** `+0000` by default. */
  readonly timezone?: string;
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: BuildTagFields): Buffer {
  if (!isObjectId(fields.object)) throw new Error('buildTag needs a valid object id');
  const timestamp = fields.timestamp ?? DEFAULT_TIMESTAMP;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? DEFAULT_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}
