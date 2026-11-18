# PERF-NOTES — github-core-clone-01 performance work (18 Nov 2026)

## Baseline (pre-change, fresh server, local grader `sdk/run.ts --perf`)

Re-measured on this box just before the changes (parent's earlier baseline was
140/200; this box re-measured 153/200 — the numbers move with machine load):

| workload | p50 (ms) | pts | rounds (ms) |
|----------|----------|-----|-------------|
| push     | 521.3    | 46  | 521 / 468 / 619 |
| clone    | 175.0    | 33  | 175 / 251 / 138 |
| read     | 1660.5   | 34  | 1660 / 1966 / 1329 |
| write    | 155.0    | 40  | 165 / 155 / 154 |
| **total** | —       | **153** | conformance 120/120, MCP 15/15 |

T_ref: push 1640.82, clone 266.941, read 2759.715, write 348.965 ms.
Points per workload: `round(clamp(25 − 12.5·log2(p50/T_ref), 0, 50))`.

## What changed

### 1. `git-pack.ts` — deflated-object cache (`#2` in the task)
- `buildPack` now caches `deflateSync` output per object oid (`deflateCache`,
  cap 10,000 entries, FIFO eviction of the oldest). Objects are immutable, so
  the same oid always deflates to the same bytes; the cache key is the oid
  itself (SHA-1 over `<type> <size>\0` + data, via `hashObject`).

### 2. `git-http.ts` — fetch-response (pack) cache, parsed-object caches, static v2 ad
- **Fetch-response cache** (`fetchCache`, cap 32 entries, FIFO): `handleFetchV2`
  and `handleFetchV0` return the previously built response Buffer verbatim on
  a hit. Key = JSON of `[protocol, owner, repo, sorted refs, objects.size,
  sorted wants, sorted haves, sorted shallow boundaries, depth,
  deepenRelative]`. Invalidation is by construction: any mutation that can
  change reachable objects moves a ref (receive-pack push, contents
  PUT/DELETE, merge, git/refs POST) or changes the object count (objects are
  only ever added; delete/recreate restarts from empty refs), so the key
  changes; a miss simply rebuilds. The stored Buffer is never mutated after
  construction, so a hit is byte-identical to a fresh build. The cache is
  consulted *before* `planFetch`, so a hit skips planning, packing, and
  sideband encoding entirely.
- **Parsed commit/tree caches** (`commitParseCache`, `treeParseCache`, cap
  8,192 each, FIFO): `{tree, parents}` per commit oid and entries per tree
  oid, used by `collectReachableObjects`, `commitTreeClosure`,
  `isFastForward`, and the depth/`deepen-relative` walks in `planFetch`.
  Content-addressed oids make these valid forever; eviction only costs a
  re-parse. This is what helps push: `isFastForward` used to re-parse every
  ancestor commit on every push (chain walk grows with the repo).
- **Static v2 advertisement**: `ADVERTISEMENT_V2` is built once at module
  load instead of per `info/refs` request (bytes are constant).

### 3. `rest.ts` — issue GET response cache (`#3` in the task)
- `json()` now delegates to a new `jsonRaw(res, status, text)` that sends a
  pre-serialized body with the same headers (including a fresh
  `X-GitHub-Request-Id` per request — only the header is fresh, the body is
  the cached string).
- `issueGetCache` (`WeakMap<Issue, {sig, text}>`): GET
  `/repos/{o}/{r}/issues/{n}` reuses the serialized body when the signature
  matches. The signature covers everything `issueJson` reads: repo
  owner/name (a rename changes the URLs), request base, `updatedAt`, `state`,
  `title`, `body`, comment count, and each label's registered
  name/color/description (a later POST /labels can change a label's
  rendering). Any mutation (PATCH issue, new comment, label registration,
  repo rename) changes the signature, so the next GET rebuilds. WeakMap
  keying means a deleted/recreated repo gets fresh issue objects and can
  never read a stale entry.
- `userJson` is memoized per `login:id` (the viewer identity is fixed per
  process; every caller passes the viewer's login). The returned object is
  only ever serialized, never mutated.

Files touched: `git-http.ts`, `git-pack.ts`, `rest.ts` (+ this file).
Not touched: `main.ts`, `app.ts`, `store.ts`, `scenario.ts`, `graphql.ts`,
`mcp.ts`, `git-objects.ts`, `git-pkt.ts`.
Pre-change sha256 (recorded before editing, re-verified unchanged):
`git-http.ts 268a78bb…`, `git-pack.ts 54dfe59e…`, `rest.ts 1247e07d…`.

## Verification — cache correctness (21/21 checks)

`/tmp/perf18081/cache-test.ts` (kit GitClient + raw fetch against a fresh
entry) — all PASS:
- `buildPack` twice on the same objects → byte-identical.
- Depth-1 clones ×2 and full clones ×2 → byte-identical pack bytes; checksums OK.
- After pushing a new tip: clone pack differs from the stale one, parses, and
  contains the new tip; full clone grows 6 → 9 objects.
- Issue GET ×2 → byte-identical body, but different `X-GitHub-Request-Id`.
- After PATCH: new title served, then cached again. After a comment:
  `"comments":1`. After POST /labels `bug` color `ff0000`: new color served.
  After repo rename: issue URLs use the new name.

## Verification — full grader, two fresh servers (both 120/120, MCP 15/15)

| workload | baseline p50 / pts | run 1 p50 / pts | run 2 p50 / pts |
|----------|--------------------|-----------------|-----------------|
| push     | 521.3 / 46 | 460.5 / 48 | 500.8 / 46 |
| clone    | 175.0 / 33 | 146.3 / 36 | 229.2 / 28 |
| read     | 1660.5 / 34 | 1449.1 / 37 | 1430.2 / 37 |
| write    | 155.0 / 40 | 203.3 / 35 | 168.0 / 38 |
| **total** | **153** | **156** | **149** |

- Run 1: fresh server port 34495, `points_total` 156, conformance 120/120.
- Run 2: fresh server port 37743, `points_total` 149, conformance 120/120.
- (A first attempt at run 2 scored 54 because another worker's headless-Chrome
  screenshot job was eating ~70% CPU mid-run — load avg ~2.0 on this 1.5-CPU
  box. That run was discarded; conformance was still 120/120.)

## Honest assessment

Real, repeatable gains: **push ~+2 pts** (parse cache on the fast-forward
walk) and **read ~+3 pts** (issue GET cache). **Clone and write are inside
the noise**: clone round times swing 112–268 ms run to run, and the median
of 3 rounds moves ±30% with machine load; write moved 155 → 168–203 ms
even though nothing on the write path changed except strictly-less-work
helpers (`userJson` memo, `json`→`jsonRaw`), so that is load noise too.

Why the pack cache did not move clone much: a depth-1 pack is 3 tiny objects
(commit + tree + 512 B blob) — building it was never the bottleneck. A clone
is 3 sequential HTTP requests (advertisement + ls-refs + fetch) × 50
concurrent, and much of the measured time is client-side (the grader's own
pkt-line decoding + SHA-1 verification) sharing this box's 1.5 CPUs with the
entry. Server-side caching cannot remove client CPU or the round-trip floor.

**We are at the practical Node floor on this box.** The 160+/200 target is
not reliably reachable with server-side caching alone: the two clean runs
land at 149–156 against a 153 baseline, i.e. no reliable total gain, and the
clone median is too noisy to bank. Further ideas and why they were not taken:
- Per-issue version counter instead of the signature string on GET: would
  save ~10 µs of the ~700 µs per read request (~1–2%) but needs bumps from
  label-registration and repo-rename paths too — more stale-cache surface for
  a negligible gain.
- Caching ls-refs responses: the response is 2–3 short lines; the saving is
  below the noise floor.
- Touching `parsePack` (push path) or `store.tick` (write path) is off-limits
  (`git-pack.ts` parse side / `store.ts`) and the remaining cost there is
  client round-trips, not server work.
- Anything that changes response bytes, status codes, headers, or the store's
  logical clock / id counters was out of scope and not attempted.

Nothing was tried and reverted: every optimization above shipped and stayed,
because conformance stayed 120/120 in all three grading runs.
