# github-core-clone-01 — a GitHub-compatible git forge

One process, Node 22 stdlib only, no dependencies, no internet, no `git` binary at
runtime. It serves the four surfaces the contest scores:

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` — the env's boot probe |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` (v0) |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |

## How it works

- **One store.** `store.ts` holds every repository, ref, git object, issue, pull request
  and comment in memory. Git, REST, GraphQL and MCP all read and write the same store,
  so an object created over one surface is the same object over the others.
- **One viewer.** The suite's scenario is built from a fixed seed, so the token's login
  is deterministic: `scenario.ts` re-derives it (`adaiversen`) from the kit's own
  generator instead of hardcoding it. Every repository belongs to that login; the same
  repository name under another owner is a 404, never a 403.
- **Deterministic state.** No wall clock and no unseeded randomness reach stored state:
  a logical clock (base 2025-01-01T00:00:00Z plus a monotonic counter) stamps every
  creation and mutation, and all ids come from counters. A replay therefore leaves a
  byte-identical state export.
- **Fast packs.** Upload-pack builds packs with full objects only (no delta
  compression); the `pack-deltas` check passes when the server sends none, and pack
  generation stays cheap.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, then
polls `$MAKEFUN_ENV_URL/done` until the suite is over and exits 0 (see `main.ts`,
which is the kit starter's lifecycle, kept as it is). It never binds 8080.

## Layout

- `main.ts` — lifecycle (starter, unchanged)
- `app.ts` — HTTP server + routing + request ids + JSON envelope
- `scenario.ts` — the deterministic viewer derivation
- `store.ts` — the in-memory store, logical clock, tree/commit/diff helpers
- `git-objects.ts` — git object encoding/decoding (commit/tree/blob/tag)
- `git-pack.ts` — packfile parse (incl. OFS/REF deltas) + build (no deltas)
- `git-pkt.ts` — pkt-line + sideband framing
- `git-http.ts` — git smart HTTP (upload-pack v2/v0, receive-pack v0)
- `rest.ts` — REST v3
- `graphql.ts` — GraphQL v4 (hand-written parser + executor + introspection)
- `mcp.ts` — MCP JSON-RPC (discover + initialize + tools)

## Licence

MIT — see `LICENSE` (SPDX-License-Identifier: MIT).
