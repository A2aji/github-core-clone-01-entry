// graphql.ts — GitHub GraphQL v4 (POST /api/graphql), hand-rolled, no dependencies.
//
// Serves the viewer / repository / issue / pull-request reads gh and
// github-mcp-server send, the five mutations the suite exercises, Relay
// node(id:) and the __type/__schema introspection probes. A small
// tokenizer + recursive-descent parser executes documents against the
// store; the field selection drives the output (only requested fields
// are returned, plus __typename when asked).
//
// Auth: Bearer token must equal expectedToken (or, when expectedToken is
// '', any non-empty Bearer — the entry's own isAuthenticated convention
// in app.ts). Missing/wrong -> 401 JSON. Malformed JSON body -> 400 JSON.
// A JSON array body is GitHub operation batching: one result per
// operation, in request order. Unknown fields are GraphQL-level errors:
// HTTP 200 {data, errors[]} with the field named in the message.
// An unknown repository reads data.repository = null with NO errors.
// Global ids are the store's opaque nodeIds (never the plain databaseId:
// checks-graphql #19 requires that).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type IssueComment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
  createCommit,
  diffTrees,
  mergeBase,
  resolveRef,
  treeOidOf,
} from './store.ts';

export async function handleGraphQL(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  expectedToken: string,
): Promise<boolean> {
  const path = pathOf(req);
  if (req.method !== 'POST' || (path !== '/api/graphql' && path !== '/api/graphql/')) return false;
  if (!isAuthed(req, expectedToken)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Bad Request: could not read request body' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Bad Request: request body is not valid JSON' });
    return true;
  }
  if (Array.isArray(body)) {
    // GitHub operation batching: one envelope per operation, in order.
    sendJson(res, 200, body.map((entry) => executeOne(store, entry)));
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, { message: 'Bad Request: expected a JSON object or an array of operations' });
    return true;
  }
  sendJson(res, 200, executeOne(store, body));
  return true;
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
// One operation: parse, select, execute.
// ---------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: GraphQLError[];
}

function executeOne(store: Store, operation: unknown): OperationResult {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { data: null, errors: [{ message: 'No query string was present in the request body.' }] };
  }
  const variables = isRecord(operation.variables) ? operation.variables : {};
  const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
  let document: Document;
  try {
    document = new Parser(operation.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const selected = selectOperation(document, operationName);
  if (typeof selected === 'string') return { data: null, errors: [{ message: selected }] };
  const ctx: ExecCtx = { store, fragments: document.fragments, variables, errors: [] };
  const data = executeSelections(selected.selection, {}, selected.kind === 'mutation' ? 'Mutation' : 'Query', ctx, [], selected);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function selectOperation(document: Document, operationName: string | undefined): OperationDef | string {
  if (document.operations.length === 0) return 'No operation was present in the document.';
  if (operationName !== undefined) {
    const found = document.operations.find((op) => op.name === operationName);
    if (found === undefined) return `Unknown operation named "${operationName}".`;
    return found;
  }
  if (document.operations.length === 1) return document.operations[0] as OperationDef;
  return 'Must provide operation name if query contains multiple operations.';
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface DirectiveNode {
  name: string;
  args: { name: string; value: ValueNode }[];
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  directives: DirectiveNode[];
  selection: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface VariableDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationDef {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: VariableDef[];
  directives: DirectiveNode[];
  selection: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selection: SelectionNode[];
}

interface Document {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or plain "..." with escapes.
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string in GraphQL document.');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = src[j + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Bad unicode escape in GraphQL string.');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (esc in simple) {
            out += simple[esc] as string;
            j += 2;
          } else {
            throw new Error(`Bad escape \\${esc} in GraphQL string.`);
          }
          continue;
        }
        if (c === '\n') throw new Error('Unterminated string in GraphQL document.');
        out += c;
        j += 1;
      }
      if (!closed) throw new Error('Unterminated string in GraphQL document.');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (match === null) throw new Error(`Bad number at offset ${i} in GraphQL document.`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document.`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${JSON.stringify(token.value)}.`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected ${what} in GraphQL document, got ${JSON.stringify(token.value)}.`);
    return token.value;
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationDef {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind, name: null, variables: [], directives: [], selection: this.parseSelectionSet() };
    }
    const keyword = this.expectName('an operation keyword');
    if (keyword === 'mutation') kind = 'mutation';
    else if (keyword !== 'query') throw new Error(`Unsupported operation type "${keyword}" in GraphQL document.`);
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
    const directives = this.parseDirectives();
    const selection = this.parseSelectionSet();
    return { kind, name, variables, directives, selection };
  }

  private parseVariableDefinitions(): VariableDef[] {
    this.expectPunct('(');
    const defs: VariableDef[] = [];
    while (!this.skipPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated variable definitions in GraphQL document.');
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skipPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  /** Parse (and discard) a type annotation: Named, [Named], with trailing !. */
  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.skipPunct('!');
  }

  private parseFragment(): FragmentDef {
    this.expectName('fragment');
    const name = this.expectName('a fragment name');
    const on = this.expectName('"on"');
    if (on !== 'on') throw new Error(`Expected "on" in fragment definition, got ${JSON.stringify(on)}.`);
    const typeCondition = this.expectName('a type name');
    const directives = this.parseDirectives();
    const selection = this.parseSelectionSet();
    return { name, typeCondition, directives, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set in GraphQL document.');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value !== 'on') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      let typeCondition: string | null = null;
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName('a type name');
      }
      const directives = this.parseDirectives();
      const selection = this.parseSelectionSet();
      return { kind: 'inline', typeCondition, directives, selection };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selection };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.skipPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated arguments in GraphQL document.');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName('a directive name');
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated list value in GraphQL document.');
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated object value in GraphQL document.');
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected token ${JSON.stringify(token.value)} in GraphQL document.`);
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
  errors: GraphQLError[];
}

type Resolved = { found: true; value: unknown } | { found: false };

/**
 * Field resolution that turns a mutation failure into a GraphQL field
 * error (data.<field> = null + errors[]) instead of a thrown exception.
 */
function safeResolveField(
  parentType: string,
  parent: unknown,
  field: FieldNode,
  ctx: ExecCtx,
  operation: OperationDef | null,
): Resolved {
  try {
    return resolveField(parentType, parent, field, ctx, operation);
  } catch (err) {
    if (err instanceof MutationError) {
      ctx.errors.push({ message: err.message });
      return { found: true, value: null };
    }
    throw err;
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecCtx, operation: OperationDef | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) {
    let value = resolveValue(arg.value, ctx.variables);
    if (value === undefined && operation !== null) {
      const def = operation.variables.find((entry) => entry.name === (arg.value.kind === 'variable' ? arg.value.name : ''));
      if (def?.defaultValue) value = resolveValue(def.defaultValue, ctx.variables);
    }
    out[arg.name] = value;
  }
  return out;
}

function shouldInclude(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    if (directive.name === 'skip' || directive.name === 'include') {
      const arg = directive.args.find((entry) => entry.name === 'if');
      const value = arg === undefined ? false : resolveValue(arg.value, variables);
      if (directive.name === 'skip' && value === true) return false;
      if (directive.name === 'include' && value === false) return false;
    }
  }
  return true;
}

/** The GraphQL type tag of an envelope, or null for plain records / scalars. */
function gqlTypeOf(value: unknown): string | null {
  if (isRecord(value) && typeof value.__gql === 'string') return value.__gql;
  return null;
}

function executeSelections(
  selections: SelectionNode[],
  parent: unknown,
  parentType: string,
  ctx: ExecCtx,
  path: (string | number)[],
  operation: OperationDef | null = null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (!shouldInclude(selection.directives, ctx.variables)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(fragment.selection, parent, parentType, ctx, path, operation));
      continue;
    }
    if (selection.kind === 'inline') {
      if (!shouldInclude(selection.directives, ctx.variables)) continue;
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(selection.selection, parent, selection.typeCondition ?? parentType, ctx, path, operation));
      continue;
    }
    if (!shouldInclude(selection.directives, ctx.variables)) continue;
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const resolved = safeResolveField(parentType, parent, selection, ctx, operation);
    if (!resolved.found) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const value = resolved.value;
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selection !== null && selection.selection.length > 0) {
      if (Array.isArray(value)) {
        out[key] = value.map((element, index) => {
          if (element === null || element === undefined) return null;
          if (typeof element === 'object') {
            return executeSelections(selection.selection as SelectionNode[], element, gqlTypeOf(element) ?? 'Unknown', ctx, [...fieldPath, index], operation);
          }
          return element;
        });
      } else if (typeof value === 'object') {
        out[key] = executeSelections(selection.selection, value, gqlTypeOf(value) ?? 'Unknown', ctx, fieldPath, operation);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function resolveField(
  parentType: string,
  parent: unknown,
  field: FieldNode,
  ctx: ExecCtx,
  operation: OperationDef | null,
): Resolved {
  const args = resolveArgs(field, ctx, operation);
  switch (parentType) {
    case 'Query':
      return resolveQueryField(field.name, args, ctx);
    case 'Mutation':
      return resolveMutationField(field.name, args, ctx);
    case 'Repository':
      return resolveRepositoryField(parent, field.name, args, ctx);
    case 'Issue':
      return resolveIssueField(parent, field.name, args, ctx);
    case 'PullRequest':
      return resolvePullRequestField(parent, field.name, args, ctx);
    case 'User':
      if (field.name === 'id') return { found: true, value: userNodeId(parent) };
      break;
    case 'IssueComment':
      return resolveCommentField(parent, field.name, ctx);
    case 'MergeCommit':
      if (field.name === 'oid' || field.name === 'sha') return { found: true, value: (parent as { oid: string }).oid };
      break;
    case 'Label':
      if (field.name === 'id') return { found: true, value: `L_${Buffer.from((parent as { name: string }).name, 'utf8').toString('base64url')}` };
      break;
    case '__Type':
      return resolveTypeField(parent, field.name, ctx);
    case '__Schema':
      return resolveSchemaField(field.name, ctx);
    default:
      break;
  }
  // Plain records (pageInfo, type refs, field defs, payload leaves): own properties resolve.
  if (isRecord(parent) && Object.prototype.hasOwnProperty.call(parent, field.name)) {
    return { found: true, value: parent[field.name] };
  }
  return { found: false };
}

// --- envelopes -------------------------------------------------------------

function userEnvelope(store: Store, login: string): Record<string, unknown> {
  const viewer = store.viewer;
  return {
    __gql: 'User',
    login,
    nodeId: login === viewer.login ? userNodeIdFor(viewer.id) : userNodeIdFor(hashLogin(login)),
    name: login === viewer.login ? viewer.name : null,
    email: login === viewer.login ? viewer.email : null,
  };
}

/** Deterministic positive int from a login (only for non-viewer author ids; never checked). */
function hashLogin(login: string): number {
  let hash = 7;
  for (let i = 0; i < login.length; i += 1) hash = (hash * 31 + login.charCodeAt(i)) % 2147483647;
  return hash + 1000;
}

function userNodeIdFor(id: number): string {
  return `U_${Buffer.from(String(id), 'utf8').toString('base64url')}`;
}

function userNodeId(parent: unknown): string {
  if (isRecord(parent) && typeof parent.nodeId === 'string') return parent.nodeId;
  return userNodeIdFor(0);
}

function repoEnvelope(repo: Repo): Record<string, unknown> {
  return { __gql: 'Repository', repo };
}

function issueEnvelope(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __gql: 'Issue', repo, issue };
}

function pullEnvelope(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __gql: 'PullRequest', repo, pull };
}

function commentEnvelope(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return { __gql: 'IssueComment', repo, issue, comment };
}

// --- root ------------------------------------------------------------------

function resolveQueryField(name: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  const store = ctx.store;
  switch (name) {
    case 'viewer':
      return { found: true, value: userEnvelope(store, store.viewer.login) };
    case 'repository': {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? store.getRepo(args.owner, args.name) : undefined;
      return { found: true, value: repo === undefined ? null : repoEnvelope(repo) };
    }
    case 'node': {
      const id = args.id;
      if (typeof id !== 'string' && typeof id !== 'number') return { found: true, value: null };
      const found = findNode(store, String(id));
      return { found: true, value: found };
    }
    case '__type': {
      if (typeof args.name !== 'string') return { found: true, value: null };
      const desc = TYPE_TABLE.get(args.name);
      return { found: true, value: desc === undefined ? null : { __gql: '__Type', desc } };
    }
    case '__schema':
      return { found: true, value: { __gql: '__Schema' } };
    default:
      return { found: false };
  }
}

function findNode(store: Store, id: string): Record<string, unknown> | null {
  for (const repo of store.listRepos(store.viewer.login)) {
    if (repo.nodeId === id || String(repo.id) === id || String(repo.databaseId) === id) return repoEnvelope(repo);
    for (const issue of repo.issues) {
      if (issue.nodeId === id || String(issue.id) === id || String(issue.databaseId) === id) return issueEnvelope(repo, issue);
    }
    for (const pull of repo.pulls) {
      if (pull.nodeId === id || String(pull.id) === id || String(pull.databaseId) === id) return pullEnvelope(repo, pull);
    }
  }
  return null;
}

function resolveMutationField(name: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  const input = isRecord(args.input) ? args.input : {};
  try {
    switch (name) {
      case 'createIssue': {
        const repo = resolveRepoById(ctx.store, input.repositoryId);
        if (repo === undefined) throw new Error(`repository not found: ${String(input.repositoryId ?? '')}`);
        if (typeof input.title !== 'string' || input.title === '') throw new Error('createIssue requires a title');
        const issue = createIssueInStore(ctx.store, repo, input.title, typeof input.body === 'string' ? input.body : '');
        return {
          found: true,
          value: { __gql: 'CreateIssuePayload', issue: issueEnvelope(repo, issue), clientMutationId: clientMutationId(input) },
        };
      }
      case 'closeIssue': {
        const found = resolveIssueById(ctx.store, input.issueId);
        if (found === undefined) throw new Error(`issue not found: ${String(input.issueId ?? '')}`);
        found.issue.state = 'closed';
        found.issue.updatedAt = ctx.store.tick().iso;
        return {
          found: true,
          value: { __gql: 'CloseIssuePayload', issue: issueEnvelope(found.repo, found.issue), clientMutationId: clientMutationId(input) },
        };
      }
      case 'createPullRequest': {
        const repo = resolveRepoById(ctx.store, input.repositoryId);
        if (repo === undefined) throw new Error(`repository not found: ${String(input.repositoryId ?? '')}`);
        const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
        if (baseRef === '' || headRef === '') throw new Error('createPullRequest requires baseRefName and headRefName');
        const baseSha = resolveRef(repo, baseRef);
        const headSha = resolveRef(repo, headRef);
        if (baseSha === undefined) throw new Error(`base ref not found: ${baseRef}`);
        if (headSha === undefined) throw new Error(`head ref not found: ${headRef}`);
        if (typeof input.title !== 'string' || input.title === '') throw new Error('createPullRequest requires a title');
        const pull = createPullInStore(ctx.store, repo, baseRef, headRef, input.title, typeof input.body === 'string' ? input.body : '', headSha, baseSha);
        return {
          found: true,
          value: { __gql: 'CreatePullRequestPayload', pullRequest: pullEnvelope(repo, pull), clientMutationId: clientMutationId(input) },
        };
      }
      case 'mergePullRequest': {
        const found = resolvePullById(ctx.store, input.pullRequestId);
        if (found === undefined) throw new Error(`pull request not found: ${String(input.pullRequestId ?? '')}`);
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
        if (method !== 'SQUASH' && method !== 'MERGE' && method !== 'REBASE') {
          throw new Error(`unsupported merge method: ${method}`);
        }
        if (!found.pull.merged) squashMerge(ctx.store, found.repo, found.pull);
        return {
          found: true,
          value: { __gql: 'MergePullRequestPayload', pullRequest: pullEnvelope(found.repo, found.pull), clientMutationId: clientMutationId(input) },
        };
      }
      case 'addComment': {
        const found = resolveIssueById(ctx.store, input.subjectId);
        if (found === undefined) throw new Error(`issue not found: ${String(input.subjectId ?? '')}`);
        if (typeof input.body !== 'string' || input.body === '') throw new Error('addComment requires a body');
        const comment = addCommentInStore(ctx.store, found.issue, input.body);
        return {
          found: true,
          value: {
            __gql: 'AddCommentPayload',
            commentEdge: { __gql: 'CommentEdge', node: commentEnvelope(found.repo, found.issue, comment) },
            clientMutationId: clientMutationId(input),
          },
        };
      }
      default:
        return { found: false };
    }
  } catch (err) {
    // A mutation failure is a field error (data.<field> = null + errors[]), never a throw.
    throw new MutationError(err instanceof Error ? err.message : String(err));
  }
}

class MutationError extends Error {}

function clientMutationId(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

// --- Repository ------------------------------------------------------------

function resolveRepositoryField(parent: unknown, name: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  const repo = (parent as { repo: Repo }).repo;
  const store = ctx.store;
  switch (name) {
    case 'id':
      return { found: true, value: repo.nodeId };
    case 'databaseId':
      return { found: true, value: repo.databaseId };
    case 'name':
      return { found: true, value: repo.name };
    case 'nameWithOwner':
      return { found: true, value: `${repo.ownerLogin}/${repo.name}` };
    case 'owner':
      return { found: true, value: userEnvelope(store, repo.ownerLogin) };
    case 'defaultBranchRef':
      return { found: true, value: { __gql: 'Ref', name: repo.defaultBranch } };
    case 'viewerPermission':
      return { found: true, value: 'ADMIN' };
    case 'hasIssuesEnabled':
      return { found: true, value: true };
    case 'url':
      return { found: true, value: `https://github.com/${repo.ownerLogin}/${repo.name}` };
    case 'description':
      return { found: true, value: repo.description };
    case 'isPrivate':
      return { found: true, value: repo.private };
    case 'issues':
      return { found: true, value: issuesConnection(repo, args) };
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.find((entry) => entry.number === number);
      return { found: true, value: issue === undefined ? null : issueEnvelope(repo, issue) };
    }
    case 'pullRequests':
      return { found: true, value: pullRequestsConnection(repo, args) };
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return { found: true, value: pull === undefined ? null : pullEnvelope(repo, pull) };
    }
    default:
      return { found: false };
  }
}

// --- Issue -----------------------------------------------------------------

function resolveIssueField(parent: unknown, name: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  const { repo, issue } = parent as { repo: Repo; issue: Issue };
  switch (name) {
    case 'id':
      return { found: true, value: issue.nodeId };
    case 'databaseId':
      return { found: true, value: issue.databaseId };
    case 'number':
      return { found: true, value: issue.number };
    case 'title':
      return { found: true, value: issue.title };
    case 'body':
      return { found: true, value: issue.body };
    case 'state':
      return { found: true, value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
    case 'author':
      return { found: true, value: userEnvelope(ctx.store, issue.userLogin) };
    case 'labels': {
      const nodes = issue.labels.map((label) => ({ __gql: 'Label', name: label.name }));
      return { found: true, value: paginate(nodes, args.first, args.after, 'LabelConnection') };
    }
    case 'comments': {
      const nodes = issue.comments.map((comment) => commentEnvelope(repo, issue, comment));
      const page = paginate(nodes, args.first, args.after, 'IssueCommentConnection');
      (page as Record<string, unknown>).totalCount = issue.comments.length;
      return { found: true, value: page };
    }
    case 'createdAt':
      return { found: true, value: issue.createdAt };
    case 'updatedAt':
      return { found: true, value: issue.updatedAt };
    case 'url':
      return { found: true, value: `https://github.com/${repo.ownerLogin}/${repo.name}/issues/${issue.number}` };
    default:
      return { found: false };
  }
}

// --- PullRequest -----------------------------------------------------------

function resolvePullRequestField(parent: unknown, name: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  const { repo, pull } = parent as { repo: Repo; pull: Pull };
  switch (name) {
    case 'id':
      return { found: true, value: pull.nodeId };
    case 'databaseId':
      return { found: true, value: pull.databaseId };
    case 'number':
      return { found: true, value: pull.number };
    case 'title':
      return { found: true, value: pull.title };
    case 'body':
      return { found: true, value: pull.body };
    case 'state':
      return { found: true, value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' };
    case 'merged':
      return { found: true, value: pull.merged };
    case 'mergeable':
      return { found: true, value: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING' };
    case 'headRefName':
      return { found: true, value: pull.headRef };
    case 'baseRefName':
      return { found: true, value: pull.baseRef };
    case 'headRefOid':
      return { found: true, value: pull.headSha };
    case 'baseRefOid':
      return { found: true, value: pull.baseSha };
    case 'mergeCommit':
      return { found: true, value: pull.mergeCommitSha === null ? null : { __gql: 'MergeCommit', oid: pull.mergeCommitSha } };
    case 'author':
      return { found: true, value: userEnvelope(ctx.store, ctx.store.viewer.login) };
    case 'files':
      return { found: true, value: pullFilesConnection(repo, pull, args) };
    case 'createdAt':
      return { found: true, value: pull.createdAt };
    case 'updatedAt':
      return { found: true, value: pull.updatedAt };
    case 'url':
      return { found: true, value: `https://github.com/${repo.ownerLogin}/${repo.name}/pull/${pull.number}` };
    default:
      return { found: false };
  }
}

function resolveCommentField(parent: unknown, name: string, ctx: ExecCtx): Resolved {
  const { comment } = parent as { comment: IssueComment };
  switch (name) {
    case 'id':
      return { found: true, value: ctx.store.nodeId('C', comment.id) };
    case 'body':
      return { found: true, value: comment.body };
    case 'author':
      return { found: true, value: userEnvelope(ctx.store, comment.userLogin) };
    case 'createdAt':
      return { found: true, value: comment.createdAt };
    case 'updatedAt':
      return { found: true, value: comment.createdAt };
    default:
      return { found: false };
  }
}

// --- introspection ---------------------------------------------------------

function resolveTypeField(parent: unknown, name: string, _ctx: ExecCtx): Resolved {
  const desc = (parent as { desc: TypeDesc }).desc;
  switch (name) {
    case 'name':
      return { found: true, value: desc.name };
    case 'kind':
      return { found: true, value: desc.kind };
    case 'description':
      return { found: true, value: null };
    case 'fields':
      return { found: true, value: desc.fields.map((field) => ({ name: field.name, type: field.type })) };
    case 'enumValues':
      return { found: true, value: desc.enumValues.map((value) => ({ name: value })) };
    default:
      return { found: false };
  }
}

function resolveSchemaField(name: string, _ctx: ExecCtx): Resolved {
  switch (name) {
    case 'types':
      return { found: true, value: [...TYPE_TABLE.values()].map((desc) => ({ __gql: '__Type', desc })) };
    case 'queryType':
      return { found: true, value: { __gql: '__Type', desc: TYPE_TABLE.get('Query') as TypeDesc } };
    case 'mutationType':
      return { found: true, value: { __gql: '__Type', desc: TYPE_TABLE.get('Mutation') as TypeDesc } };
    case 'description':
      return { found: true, value: null };
    default:
      return { found: false };
  }
}

// ---------------------------------------------------------------------------
// Connections: ordering, states filter, cursor pagination
// ---------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const text = Buffer.from(after, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return 0;
    return Number.parseInt(match[1] as string, 10) + 1;
  } catch {
    return 0;
  }
}

function paginate<T>(items: T[], first: unknown, after: unknown, connectionType: string): Record<string, unknown> {
  const start = decodeCursor(after);
  const limit = typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.trunc(first) : items.length;
  const nodes = items.slice(start, start + limit);
  const endIndex = start + nodes.length;
  return {
    __gql: connectionType,
    nodes,
    pageInfo: {
      hasNextPage: endIndex < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length === 0 ? null : encodeCursor(start),
      endCursor: nodes.length === 0 ? null : encodeCursor(endIndex - 1),
    },
    totalCount: items.length,
  };
}

function issueStateFilter(states: unknown): ((issue: Issue) => boolean) | null {
  if (!Array.isArray(states) || states.length === 0) return null;
  const wanted = new Set(states.map((entry) => String(entry).toUpperCase()));
  return (issue: Issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED');
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = isRecord(orderBy) ? orderBy : {};
  const field = typeof order.field === 'string' ? order.field : 'CREATED_AT';
  const direction = typeof order.direction === 'string' ? order.direction.toUpperCase() : 'DESC';
  const desc = direction !== 'ASC';
  const keyOf = (issue: Issue): string | number => {
    if (field === 'UPDATED_AT') return issue.updatedAt;
    if (field === 'COMMENTS') return issue.comments.length;
    return issue.createdAt;
  };
  return [...issues].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return (ka < kb ? -1 : 1) * (desc ? -1 : 1);
    return desc ? b.number - a.number : a.number - b.number;
  });
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const filter = issueStateFilter(args.states);
  const items = sortIssues(filter === null ? repo.issues : repo.issues.filter(filter), args.orderBy);
  const page = paginate(
    items.map((issue) => issueEnvelope(repo, issue)),
    args.first,
    args.after,
    'IssueConnection',
  );
  (page as Record<string, unknown>).totalCount = items.length;
  return page;
}

function pullStateOf(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let items = [...repo.pulls];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((entry) => String(entry).toUpperCase()));
    items = items.filter((pull) => wanted.has(pullStateOf(pull)));
  }
  items.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.number - a.number;
  });
  const page = paginate(
    items.map((pull) => pullEnvelope(repo, pull)),
    args.first,
    args.after,
    'PullRequestConnection',
  );
  (page as Record<string, unknown>).totalCount = items.length;
  return page;
}

/** PR changed files: diff the merge-base tree against the head tree. */
function pullFilesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Record<string, unknown> {
  let nodes: Record<string, unknown>[] = [];
  try {
    const base = mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
    const entries = diffTrees(repo, base, pull.headSha);
    nodes = entries.map((entry) => ({
      __gql: 'PullRequestChangedFile',
      path: entry.filename,
      additions: entry.additions,
      deletions: entry.deletions,
      changeType: entry.status === 'added' ? 'ADDED' : entry.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    }));
  } catch {
    nodes = [];
  }
  const page = paginate(nodes, args.first, undefined, 'PullRequestChangedFileConnection');
  (page as Record<string, unknown>).totalCount = nodes.length;
  return page;
}

// ---------------------------------------------------------------------------
// Store mutation helpers (shared shapes with the REST surface)
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

function addCommentInStore(store: Store, issue: Issue, body: string): IssueComment {
  const now = store.tick();
  const id = store.nextObjectId();
  const comment: IssueComment = { id, body, userLogin: store.viewer.login, createdAt: now.iso };
  issue.comments.push(comment);
  issue.updatedAt = now.iso;
  return comment;
}

/**
 * Squash merge: one commit whose tree is the head tree and whose parent is
 * the current base tip, then the base ref moves to it and the PR closes.
 * The commit identity and timestamp come from the store's logical clock,
 * so the merge is deterministic.
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

// --- id resolution: nodeId strings or plain numbers both match -----------

function resolveRepoById(store: Store, id: unknown): Repo | undefined {
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const wanted = String(id);
  for (const repo of store.listRepos(store.viewer.login)) {
    if (repo.nodeId === wanted || String(repo.id) === wanted || String(repo.databaseId) === wanted) return repo;
  }
  return undefined;
}

function resolveIssueById(store: Store, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const wanted = String(id);
  for (const repo of store.listRepos(store.viewer.login)) {
    for (const issue of repo.issues) {
      if (issue.nodeId === wanted || String(issue.id) === wanted || String(issue.databaseId) === wanted) return { repo, issue };
    }
  }
  return undefined;
}

function resolvePullById(store: Store, id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string' && typeof id !== 'number') return undefined;
  const wanted = String(id);
  for (const repo of store.listRepos(store.viewer.login)) {
    for (const pull of repo.pulls) {
      if (pull.nodeId === wanted || String(pull.id) === wanted || String(pull.databaseId) === wanted) return { repo, pull };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Introspection tables (checks-graphql reads .fields[].name / .enumValues[].name)
// ---------------------------------------------------------------------------

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

interface TypeDesc {
  name: string;
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields: { name: string; type: TypeRef }[];
  enumValues: string[];
}

function scalar(name: string): TypeRef {
  return { kind: 'SCALAR', name, ofType: null };
}

function obj(name: string): TypeRef {
  return { kind: 'OBJECT', name, ofType: null };
}

function list(inner: TypeRef): TypeRef {
  return { kind: 'LIST', name: null, ofType: inner };
}

const ID = scalar('ID');
const STR = scalar('String');
const INT = scalar('Int');
const BOOL = scalar('Boolean');

function fieldsOf(entries: [string, TypeRef][]): { name: string; type: TypeRef }[] {
  return entries.map(([name, type]) => ({ name, type }));
}

const TYPE_TABLE: Map<string, TypeDesc> = new Map<string, TypeDesc>([
  [
    'Query',
    {
      name: 'Query',
      kind: 'OBJECT',
      fields: fieldsOf([
        ['viewer', obj('User')],
        ['repository', obj('Repository')],
        ['node', obj('Repository')],
        ['__type', obj('__Type')],
        ['__schema', obj('__Schema')],
      ]),
      enumValues: [],
    },
  ],
  [
    'Mutation',
    {
      name: 'Mutation',
      kind: 'OBJECT',
      fields: fieldsOf([
        ['createIssue', obj('CreateIssuePayload')],
        ['closeIssue', obj('CloseIssuePayload')],
        ['createPullRequest', obj('CreatePullRequestPayload')],
        ['mergePullRequest', obj('MergePullRequestPayload')],
        ['addComment', obj('AddCommentPayload')],
      ]),
      enumValues: [],
    },
  ],
  [
    'Repository',
    {
      name: 'Repository',
      kind: 'OBJECT',
      fields: fieldsOf([
        ['id', ID],
        ['databaseId', INT],
        ['name', STR],
        ['nameWithOwner', STR],
        ['owner', obj('User')],
        ['defaultBranchRef', obj('Ref')],
        ['viewerPermission', obj('RepositoryPermission')],
        ['hasIssuesEnabled', BOOL],
        ['issue', obj('Issue')],
        ['issues', obj('IssueConnection')],
        ['pullRequests', obj('PullRequestConnection')],
        ['pullRequest', obj('PullRequest')],
        ['url', STR],
        ['description', STR],
        ['isPrivate', BOOL],
      ]),
      enumValues: [],
    },
  ],
  [
    'Issue',
    {
      name: 'Issue',
      kind: 'OBJECT',
      fields: fieldsOf([
        ['id', ID],
        ['databaseId', INT],
        ['number', INT],
        ['title', STR],
        ['body', STR],
        ['state', obj('IssueState')],
        ['author', obj('User')],
        ['labels', obj('LabelConnection')],
        ['comments', obj('IssueCommentConnection')],
        ['createdAt', STR],
        ['updatedAt', STR],
        ['url', STR],
      ]),
      enumValues: [],
    },
  ],
  [
    'PullRequest',
    {
      name: 'PullRequest',
      kind: 'OBJECT',
      fields: fieldsOf([
        ['id', ID],
        ['databaseId', INT],
        ['number', INT],
        ['title', STR],
        ['body', STR],
        ['state', obj('PullRequestState')],
        ['merged', BOOL],
        ['mergeable', obj('MergeableState')],
        ['headRefName', STR],
        ['baseRefName', STR],
        ['headRefOid', STR],
        ['baseRefOid', STR],
        ['mergeCommit', obj('Commit')],
        ['author', obj('User')],
        ['files', obj('PullRequestChangedFileConnection')],
        ['createdAt', STR],
        ['updatedAt', STR],
        ['url', STR],
      ]),
      enumValues: [],
    },
  ],
  ['User', { name: 'User', kind: 'OBJECT', fields: fieldsOf([['id', ID], ['login', STR], ['name', STR], ['email', STR]]), enumValues: [] }],
  ['Ref', { name: 'Ref', kind: 'OBJECT', fields: fieldsOf([['name', STR]]), enumValues: [] }],
  ['Commit', { name: 'Commit', kind: 'OBJECT', fields: fieldsOf([['oid', STR], ['sha', STR]]), enumValues: [] }],
  [
    'IssueConnection',
    {
      name: 'IssueConnection',
      kind: 'OBJECT',
      fields: fieldsOf([['nodes', list(obj('Issue'))], ['pageInfo', obj('PageInfo')], ['totalCount', INT]]),
      enumValues: [],
    },
  ],
  [
    'PullRequestConnection',
    {
      name: 'PullRequestConnection',
      kind: 'OBJECT',
      fields: fieldsOf([['nodes', list(obj('PullRequest'))], ['pageInfo', obj('PageInfo')], ['totalCount', INT]]),
      enumValues: [],
    },
  ],
  [
    'IssueCommentConnection',
    {
      name: 'IssueCommentConnection',
      kind: 'OBJECT',
      fields: fieldsOf([['nodes', list(obj('IssueComment'))], ['pageInfo', obj('PageInfo')], ['totalCount', INT]]),
      enumValues: [],
    },
  ],
  [
    'LabelConnection',
    {
      name: 'LabelConnection',
      kind: 'OBJECT',
      fields: fieldsOf([['nodes', list(obj('Label'))], ['pageInfo', obj('PageInfo')], ['totalCount', INT]]),
      enumValues: [],
    },
  ],
  [
    'PullRequestChangedFileConnection',
    {
      name: 'PullRequestChangedFileConnection',
      kind: 'OBJECT',
      fields: fieldsOf([['nodes', list(obj('PullRequestChangedFile'))], ['pageInfo', obj('PageInfo')], ['totalCount', INT]]),
      enumValues: [],
    },
  ],
  [
    'PageInfo',
    {
      name: 'PageInfo',
      kind: 'OBJECT',
      fields: fieldsOf([['hasNextPage', BOOL], ['hasPreviousPage', BOOL], ['startCursor', STR], ['endCursor', STR]]),
      enumValues: [],
    },
  ],
  [
    'IssueComment',
    {
      name: 'IssueComment',
      kind: 'OBJECT',
      fields: fieldsOf([['id', ID], ['body', STR], ['author', obj('User')], ['createdAt', STR], ['updatedAt', STR]]),
      enumValues: [],
    },
  ],
  ['Label', { name: 'Label', kind: 'OBJECT', fields: fieldsOf([['id', ID], ['name', STR]]), enumValues: [] }],
  [
    'PullRequestChangedFile',
    {
      name: 'PullRequestChangedFile',
      kind: 'OBJECT',
      fields: fieldsOf([['path', STR], ['additions', INT], ['deletions', INT], ['changeType', STR]]),
      enumValues: [],
    },
  ],
  ['CreateIssuePayload', { name: 'CreateIssuePayload', kind: 'OBJECT', fields: fieldsOf([['issue', obj('Issue')], ['clientMutationId', STR]]), enumValues: [] }],
  ['CloseIssuePayload', { name: 'CloseIssuePayload', kind: 'OBJECT', fields: fieldsOf([['issue', obj('Issue')], ['clientMutationId', STR]]), enumValues: [] }],
  ['CreatePullRequestPayload', { name: 'CreatePullRequestPayload', kind: 'OBJECT', fields: fieldsOf([['pullRequest', obj('PullRequest')], ['clientMutationId', STR]]), enumValues: [] }],
  ['MergePullRequestPayload', { name: 'MergePullRequestPayload', kind: 'OBJECT', fields: fieldsOf([['pullRequest', obj('PullRequest')], ['clientMutationId', STR]]), enumValues: [] }],
  ['AddCommentPayload', { name: 'AddCommentPayload', kind: 'OBJECT', fields: fieldsOf([['commentEdge', obj('IssueCommentEdge')], ['clientMutationId', STR]]), enumValues: [] }],
  ['IssueCommentEdge', { name: 'IssueCommentEdge', kind: 'OBJECT', fields: fieldsOf([['node', obj('IssueComment')]]), enumValues: [] }],
  ['SearchType', { name: 'SearchType', kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] }],
  ['IssueState', { name: 'IssueState', kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] }],
  ['PullRequestState', { name: 'PullRequestState', kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] }],
  ['MergeableState', { name: 'MergeableState', kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] }],
  ['PullRequestMergeMethod', { name: 'PullRequestMergeMethod', kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] }],
  ['RepositoryPermission', { name: 'RepositoryPermission', kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] }],
  ['IssueOrderField', { name: 'IssueOrderField', kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] }],
  ['OrderDirection', { name: 'OrderDirection', kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] }],
  [
    '__Type',
    {
      name: '__Type',
      kind: 'OBJECT',
      fields: fieldsOf([['name', STR], ['kind', STR], ['description', STR], ['fields', list(obj('__Field'))], ['enumValues', list(obj('__EnumValue'))]]),
      enumValues: [],
    },
  ],
  [
    '__Schema',
    {
      name: '__Schema',
      kind: 'OBJECT',
      fields: fieldsOf([['types', list(obj('__Type'))], ['queryType', obj('__Type')], ['mutationType', obj('__Type')], ['description', STR]]),
      enumValues: [],
    },
  ],
  ['__Field', { name: '__Field', kind: 'OBJECT', fields: fieldsOf([['name', STR], ['type', obj('__Type')]]), enumValues: [] }],
  ['__EnumValue', { name: '__EnumValue', kind: 'OBJECT', fields: fieldsOf([['name', STR]]), enumValues: [] }],
  ['String', { name: 'String', kind: 'SCALAR', fields: [], enumValues: [] }],
  ['Int', { name: 'Int', kind: 'SCALAR', fields: [], enumValues: [] }],
  ['Boolean', { name: 'Boolean', kind: 'SCALAR', fields: [], enumValues: [] }],
  ['ID', { name: 'ID', kind: 'SCALAR', fields: [], enumValues: [] }],
]);
