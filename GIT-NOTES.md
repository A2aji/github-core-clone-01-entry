# GIT-NOTES.md — git core module (github-core-clone-01)

## Files written (all in `~/workspace/makefun/github-core-clone-01-entry/`)

| File | What it is |
| --- | --- |
| `scenario.ts` | Deterministic viewer derivation ported from kit `wire.ts` |
| `git-objects.ts` | SHA-1 object ids; commit/tree/blob/tag encode/decode |
| `git-pack.ts` | Packfile parse (v2/v3, OFS/REF deltas) + build (no deltas) |
| `git-pkt.ts` | pkt-line + sideband framing |
| `git-http.ts` | Git smart HTTP: upload-pack v2+v0, receive-pack v0 |

## Exported APIs

- `scenario.ts` — `SCENARIO_SEED`, `SCENARIO_SEED_HEX`, `SCENARIO_USERS`, `U64_MASK`,
  `fnv1a64`, `mix64`, `scenarioSeedFor`, `scenarioRng`, `Rng`
  (`nextU64/nextU32/nextInt/fraction/chance/pick/shuffle/bytes/hex/words/clone`),
  `FIRST_NAMES`, `LAST_NAMES`, `REPO_ADJECTIVES`, `REPO_NOUNS`, `generateUsers`,
  `VIEWER` (= users[0], asserted `adaiversen`), `TEAMMATE` (`quinnkeller`),
  `STRANGER` (`olgabauer`), `ORG` (`faint-meadow-org`). All four asserted at import.
- `git-objects.ts` — `GitObjectType`, `ZERO_OID`, `isObjectId`, `hashObject`,
  `encodeObject` (loose bytes), `parseCommit`, `parseTree`, `parseTag`,
  `buildCommit`, `buildTree` (git-sorted), `buildTag`, `DEFAULT_IDENTITY`,
  `DEFAULT_TIMESTAMP` (2025-01-01T00:00:00Z).
- `git-pack.ts` — `parsePack(buf): Map<oid, {type, data}>` (throws on corrupt:
  bad magic/version, size mismatch, stray bytes, bad trailer, delta cycle,
  missing delta base), `buildPack(objects)` (array or Map, full objects,
  deflate level 6, SHA-1 trailer), `verifyPackChecksum`, `packChecksum`,
  `applyDelta`.
- `git-pkt.ts` — `PKT_LINE_MAX` (65520), `PKT_LINE_MAX_PAYLOAD`, `encodePktLine`,
  `encodeFlush`, `encodeDelim`, `encodeResponseEnd`, `encodePktLines`,
  `encodeSideband(band, data)`, `encodeSidebandStream`, `SIDEBAND_MAX_DATA`,
  `encodeAdvertisementLine(oid, refname, caps?)`, `parsePktLines`
  (decodes data packets until the first flush/delim/response-end; `rest`
  starts at that control packet, so callers read section by section),
  `decodePktLines`.
- `git-http.ts` — `handleGit(req, res, store, token): Promise<boolean>` (the
  signature `app.ts` calls), `routeGitRequest(method, pathname, query,
  headers, body, store, ctx): Promise<{status, headers, body}>` (pure core,
  used by the smoke tests), `collectReachableObjects`, `isFastForward`,
  plus the local `Store`/`Repo`/`GitObject`/`GitContext`/`GitResponse` types.

## Store contract note

`store.ts` did not exist when this module was written, so `git-http.ts`
defines the minimal `Store`/`Repo`/`GitObject` types locally (see its header
comment): `getRepo(owner, name)`, `tick()`, `viewer`, and repos with
`refs: Map<string,string>` + `objects: Map<string, GitObject>`. `store.ts`
has since landed; the real-app harness below proves the shapes are
compatible at runtime. If the parent later wants a single source of truth,
these three interfaces can be replaced with `import type { Store } from
'./store.ts'` — no logic change needed.

## Test results

All tests run 2026-11-18 (WIB), Node 22, stdlib only.

1. **Typecheck** — `npm run check` (all 12 entry files): PASS.
2. **Pack unit tests** (`/tmp/git-smoke/pack-test.ts`): **14/14 PASS** —
   own round-trip (blob/tree/commit/tag), empty pack, corrupt-trailer and
   garbage rejection, and parsing a REAL `git repack -adf` delta pack:
   all `rev-list --objects` present and byte-identical to `git cat-file`.
3. **Kit-client harness** (`/tmp/git-smoke/harness.ts`, the grader's own
   `git-client.ts` driving the handlers, mirroring all 30 `checks-git.ts`
   flows + auth + v0): **34/34 PASS** — first against a fake store, then
   again against the REAL entry app (`app.ts` + `store.ts` + real REST repo
   creation).
4. **Real `git` CLI** (git 2.43) against the server: **PASS** — empty clone,
   first push, full clone (byte-identical files), incremental fetch, shallow
   `--depth 1`, `fetch --deepen=1`, annotated tag push + clone, v0 clone,
   v0 fetch, non-fast-forward push rejected with remote ref unchanged,
   branch create/delete.
5. **Full kit grader run** (env `server.mjs` + entry `main.ts`, port 18081):
   **120/120 passed, working=1** — git **30/30**, every other group also
   30/30-equivalent (graphql 20/20, issues 15/15, pulls 20/20, repos 15/15,
   mcp 15/15, protocol 5/5). Perf 131/200 (push 45, clone 28, read 34,
   write 24; p50 518,673 µs). Conformance took 2,117 ms.
   (First attempt collided with another env already on port 18080 and died
   with EADDRINUSE / "no entry registered"; re-ran cleanly on 18081.)

## Deviations / decisions worth knowing

- **v2 fetch framing** (found by testing against real `git`, not just the
  kit client): the acknowledgments section is sent ONLY when the client sent
  haves (a client that sent none expects the packfile section next); v2
  response sections are separated by **DELIM (0001)**, not FLUSH — a flush
  after `ready` ends the whole response for real git
  (`fatal: expected packfile to be sent after 'ready'`); the response ends
  with a single FLUSH. The kit client treats delim and flush alike, so it
  accepts both. A packfile section is ALWAYS sent (an empty pack when
  nothing is new); the kit client reads it as zero objects.
- **v0 caps** include `multi_ack_detailed` as well as `multi_ack`: real git
  over smart HTTP uses stateless RPC and refuses a v0 server without it.
- **`deepen` semantics**: the kit client sends absolute total depth
  (`deepen 2`); real git's `--deepen` sends `deepen N` + `deepen-relative`
  (additional depth past the sent shallow boundary). Both are honoured.
- **`parsePack` rejects thin packs**: a REF_DELTA base must be inside the
  pack. The kit client's `writePack` never emits deltas, so pushes are
  never thin; this is a deliberate strictness, not a gap.
- **Push validation**: all commands are decided against a pre-push snapshot
  (fast-forward via commit ancestry; tag-ref updates allowed after the
  old-value check; create/delete check existence + old value), then the ok
  ones are applied; refused refs keep the repo consistent and still get
  `unpack ok` + one `ng <ref> <reason>` line each (`non-fast-forward`
  exactly for FF refusals).
- **Auth** mirrors `app.ts`: token `''` means any non-empty Bearer; otherwise
  exact match. Wrong owner is 404, never 403. Missing repo is 404 JSON on
  both services. Malformed pkt-lines are 400 JSON; the server stays up.
- No `Date.now()` / `Math.random()` anywhere in state paths; pack object
  order is sorted by oid (deterministic).

## Open questions

- None blocking. Residual risk: none observed in the git group — the real
  grader passes 30/30. If the suite ever drives the server with a client
  that sends `filter` or `deepen-since`/`deepen-not` with real effect, those
  arguments are currently accepted and ignored (full objects sent), which
  is protocol-valid but not filtered.
