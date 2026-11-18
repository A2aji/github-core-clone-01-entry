// app.ts — the forge's HTTP server: routing, auth plumbing, JSON envelope, request ids.
//
// main.ts (the env lifecycle) imports createApp() from here and nothing else.
// Routing: /healthz (no auth) | /api/v3/* (REST) | POST /api/graphql | POST /mcp |
// /<owner>/<repo>.git/{info/refs, git-upload-pack, git-receive-pack} (git smart HTTP).
// Everything else: 404 {"message":"Not Found"}.
//
// Conventions the handlers rely on:
// - Every response carries a non-empty X-GitHub-Request-Id (a per-process counter).
// - Content-Type defaults to application/json; git handlers override it with their own.
// - Handlers read the request body themselves from the req stream (git needs raw bytes;
//   REST/GraphQL/MCP parse JSON and answer 400 on malformed bodies).
// - Handlers do their own auth against `expectedToken` (the MAKEFUN_SHOP_TOKEN env value);
//   a missing/wrong Bearer token is a 401 JSON. /healthz takes no token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The bearer token the suite presents; '' when unset (local runs set it explicitly). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Answer one request with a JSON body. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  }
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read the whole request body as a Buffer, capped at MAX_BODY_BYTES. */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
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

/** Parse a JSON body; returns null (and the caller answers 400) when it is not JSON. */
export function parseJsonBody(raw: Buffer): unknown | undefined {
  const text = raw.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The Authorization: Bearer <token> on a request, or '' when absent. */
export function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] as string : '';
}

/** Whether the request carries the expected bearer token. */
export function isAuthenticated(req: IncomingMessage, token: string): boolean {
  if (token === '') return bearerToken(req) !== '';
  return bearerToken(req) === token;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store(VIEWER);
  const token = expectedToken();
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    requestCounter += 1;
    res.setHeader('x-github-request-id', `req-${requestCounter}`);
    // Default JSON content type; git handlers override it with their own.
    res.setHeader('content-type', JSON_TYPE);

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: 200 with the token's scopes.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const handled = await handleRest(req, res, store, token);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          const handled = await handleGraphQL(req, res, store, token);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // MCP over streamable HTTP.
        if (method === 'POST' && path === '/mcp') {
          const handled = await handleMcp(req, res, store, token);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // git smart HTTP: /<owner>/<repo>.git/{info/refs, git-upload-pack, git-receive-pack}.
        if (/^\/[^/]+\/[^/]+\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(path)) {
          const handled = await handleGit(req, res, store, token);
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler's trouble is never a crash: answer JSON 500 and keep serving.
        process.stderr.write(`[entry] handler error on ${method} ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else if (!res.writableEnded) res.end();
      }
    })();
  });
}
