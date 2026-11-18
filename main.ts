// main.ts — the entrypoint: the process's whole life is the env handshake.
//
// The trial harness (env/src/wire.ts) owns the trial; this file only does what the
// harness asks of an entry: start the forge server on a kernel-chosen port, hand that
// port to the env, and then sit still until the env declares the trial finished.
//
// The handshake, in order:
//   1. MAKEFUN_ENV_URL must name the env's origin. With nothing to register against,
//      there is no trial to run, so the process prints a line to stderr and exits 1.
//   2. Build the server (createApp, from app.ts) and listen(0). Port 0 lets the kernel
//      pick a free port; 8080 is never bound because the env itself listens there.
//   3. POST {port} to $MAKEFUN_ENV_URL/register. The env takes the caller's address
//      plus that port as the entry's base URL and starts dialling it. The first
//      registration wins — a 409 only means some other entry got there first, so it
//      counts as success for this process too.
//   4. GET $MAKEFUN_ENV_URL/done, again and again, until the body reads
//      {"done": true}. The env answers immediately either way, so this is a poll.
//      A failed or timed-out poll just means "not done yet" and is retried.
//   5. Close the server and exit 0. The harness then stops the env, which writes the
//      export the scorer reads.
//
// Nothing else is imported: the server comes from app.ts, fetch and AbortSignal are
// globals, and no model is ever called from here.

import { createApp } from './app.ts';

/** The env's origin, with any trailing slashes removed. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long a single register or done request may run before it is abandoned. */
const FETCH_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause allowed. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

/** Wait `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `attempt` failed tries: doubling from BACKOFF_FIRST_MS, capped. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** What one try of a polled step reports: finished, or try again after a pause. */
type StepResult = 'done' | 'retry';

/**
 * Keep calling `step` until it reports done, pausing longer after each retry.
 * A step that throws a fatal error lets it escape: the driver never swallows it.
 */
async function untilDone(step: () => Promise<StepResult>): Promise<void> {
  let attempt = 0;
  for (;;) {
    if ((await step()) === 'done') return;
    await pause(backoffMs(attempt));
    attempt += 1;
  }
}

/**
 * One registration attempt. 200 means the env took the port; 409 means another
 * entry registered first, which is equally fine. 400 and 405 are contract errors
 * and end the process. Anything else — the env still starting, a dropped
 * connection, an unexpected status — just means "try again".
 */
async function attemptRegister(port: number): Promise<StepResult> {
  let response: Response;
  try {
    response = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return 'retry';
  }
  if (response.status === 200 || response.status === 409) return 'done';
  if (response.status === 400 || response.status === 405) {
    throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
  }
  return 'retry';
}

/** One done-check: done only when the env answers {"done": true}. */
async function attemptDoneCheck(): Promise<StepResult> {
  try {
    const response = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.ok) {
      const payload = (await response.json()) as { done?: unknown };
      if (payload.done === true) return 'done';
    }
  } catch {
    // The env is silent, slow, or still working: not done yet, so poll again.
  }
  return 'retry';
}

/** Bind, register, wait for done: the entire life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await untilDone(() => attemptRegister(bound.port));
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await untilDone(attemptDoneCheck);
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
