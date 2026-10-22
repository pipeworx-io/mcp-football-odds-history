interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Bounded readers — peak memory, not just wall time (fleet #3322) ──────
//
// `parseJson` above does `await res.text()` then `JSON.parse(raw)`, so a
// multi-megabyte upstream body is held TWICE at peak: once as the raw string
// and once as the object graph (which for an array of small objects runs
// several times the byte size). Nothing in `workers/gateway` can see that
// peak — it happens inside the pack, before any gateway code holds a payload —
// which is why the gateway-side payload caps of #3293 and #3320 did not move
// the 503/1102 rate at all.
//
// Measured on the live gateway, 2026-10-19, sha fa5de5c34, direct tools/call:
//   statcan_list_cubes  8,049,566 B   <- one upstream array, no limit argument
//   gnomad_gene BRCA1   2,732,706 B
// Five of those in flight at the quality runner's width is ~40 MB of parse
// peak against a 128 MB isolate; Cloudflare kills the isolate and every
// request in flight returns 503/1102, which is why the victims look random.
//
// `readJsonArrayPrefix` is the fix for the dominant shape: an upstream that
// returns one enormous top-level JSON array with no server-side paging. It
// parses elements off the stream and DISCARDS the consumed bytes, so peak
// retained memory is one element plus one chunk rather than the whole body,
// and it cancels the body as soon as it has what it was asked for.

/** Default ceiling for a single upstream JSON body read into an isolate.
 *  Chosen so the known tail (statcan 8.0 MB, gnomad 2.7 MB) is bounded well
 *  below the point where a handful of concurrent reads exhausts 128 MB. */
const DEFAULT_MAX_JSON_BYTES = 1_500_000;

interface JsonArrayPrefix<T> {
  /** The decoded elements, at most `maxItems` of them. */
  items: T[];
  /** True when the upstream array had more elements than we read. */
  truncated: boolean;
  /** Bytes actually pulled off the socket — the number that bounds memory. */
  bytesRead: number;
  /** `Content-Length` if the upstream declared one, else null. */
  declaredBytes: number | null;
}

/**
 * Read the FIRST `maxItems` elements of a top-level JSON array off a response
 * stream without ever materialising the whole body.
 *
 * Use this instead of `parseJson` when the upstream returns one big array and
 * offers no `limit`/`offset` of its own. Peak retained memory is one element
 * plus the current chunk; the body is cancelled as soon as `maxItems` is
 * reached, so the remaining megabytes are never transferred at all.
 *
 *     const { items, truncated } = await readJsonArrayPrefix<Cube>(
 *       res, 'StatCan WDS', { maxItems: limit + offset });
 *
 * `maxBytes` is a second, independent backstop for a pathological element (a
 * single 50 MB object): hitting it stops the read and sets `truncated`, rather
 * than throwing, because a partial answer plus an explicit truncated flag is
 * more useful to a caller than an error.
 */
async function readJsonArrayPrefix<T>(
  res: Response,
  name: string,
  opts: { maxItems: number; maxBytes?: number },
): Promise<JsonArrayPrefix<T>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const declaredRaw = Number(res.headers.get('content-length'));
  const declaredBytes = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  // No streaming body available (a mock, or an already-buffered response):
  // fall back to the whole-text path so behaviour stays correct, just unbounded.
  if (!res.body) {
    const all = await parseJson<T[]>(res, name);
    if (!Array.isArray(all)) throw new Error(`upstream_down: ${name} returned ${typeof all} where a JSON array was expected.`);
    return {
      items: all.slice(0, opts.maxItems),
      truncated: all.length > opts.maxItems,
      bytesRead: declaredBytes ?? 0,
      declaredBytes,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const items: T[] = [];

  let buf = '';
  let scan = 0;
  let bytesRead = 0;
  let started = false; // consumed the opening '['
  let arrayEnded = false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  let truncated = false;

  const push = (text: string) => {
    const t = text.trim();
    if (!t) return;
    items.push(JSON.parse(t) as T);
  };

  try {
    outer: while (items.length < opts.maxItems && !arrayEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (bytesRead > maxBytes) { truncated = true; break; }

      for (; scan < buf.length; scan++) {
        const ch = buf[scan];

        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }

        if (!started) {
          if (ch === '[') { started = true; continue; }
          if (ch.trim() === '') continue;
          throw new Error(
            `upstream_down: ${name} returned a body that does not begin with a JSON array (saw ${JSON.stringify(ch)}). ` +
              'This reader is only for upstreams that answer with one top-level array.',
          );
        }

        if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = scan; inStr = true; continue; }

        if (ch === '{' || ch === '[') {
          if (depth === 0 && elemStart < 0) elemStart = scan;
          depth++;
          continue;
        }

        if (ch === '}' || ch === ']') {
          if (depth > 0) {
            depth--;
            if (depth === 0 && elemStart >= 0) {
              push(buf.slice(elemStart, scan + 1));
              elemStart = -1;
              if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
            }
            continue;
          }
          // depth 0 and a closing bracket: the end of the top-level array.
          if (elemStart >= 0) { push(buf.slice(elemStart, scan)); elemStart = -1; }
          arrayEnded = true;
          break outer;
        }

        if (ch === ',' && depth === 0) {
          if (elemStart >= 0) {
            push(buf.slice(elemStart, scan));
            elemStart = -1;
            if (items.length >= opts.maxItems) { truncated = true; scan++; break outer; }
          }
          continue;
        }

        // A bare scalar element (number / true / false / null).
        if (depth === 0 && elemStart < 0 && ch.trim() !== '') elemStart = scan;
      }

      // Drop everything already consumed. THIS is what bounds memory: without
      // it `buf` grows to the full body and the reader is streaming in name only.
      if (elemStart >= 0) {
        buf = buf.slice(elemStart);
        scan -= elemStart;
        elemStart = 0;
      } else {
        buf = buf.slice(scan);
        scan = 0;
      }
    }
  } finally {
    // Cancel rather than drain: the point is that the remaining megabytes are
    // never transferred. A cancel on an already-finished body is a no-op.
    await reader.cancel().catch(() => {});
  }

  return { items, truncated, bytesRead, declaredBytes };
}

/**
 * `parseJson`, with a hard ceiling on how many bytes are read.
 *
 * For an upstream whose body is not a single array (so `readJsonArrayPrefix`
 * does not apply) but which can still answer with megabytes. Unlike the array
 * reader this one THROWS when the cap is hit, because a truncated prefix of an
 * arbitrary JSON document is not parseable and there is no partial answer to
 * hand back. A declared `Content-Length` over the cap is refused before a
 * single chunk is read.
 */
async function parseJsonBounded<T>(
  res: Response,
  name: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  const declaredRaw = Number(res.headers.get('content-length'));
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? declaredRaw : null;

  const tooBig = (n: number) =>
    new Error(
      `upstream_down: ${name} answered with ${n.toLocaleString()} bytes, over this pack's ${maxBytes.toLocaleString()}-byte ceiling. ` +
        'The body is not read past the ceiling on purpose — a few concurrent reads of a body that size exhaust the ' +
        'Worker isolate and take every other in-flight request down with them. Narrow the request (a smaller range, ' +
        'a specific id, or a lower limit) and retry.',
    );

  if (declared !== null && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(declared);
  }
  if (!res.body) return parseJson<T>(res, name);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let bytesRead = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) throw tooBig(bytesRead);
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected. ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON. ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}
/**
 * football-odds-history — historical football (soccer) results and odds
 * from sportsbooks, sourced from football-data.co.uk.
 *
 * Proxies football-data.co.uk's per-league, per-season CSV files live (one
 * fetch per call, edge-cached — long TTL for finished seasons, short TTL for
 * the in-progress one). No bulk copy is baked into this repo: every tool
 * call makes a request to football-data.co.uk at serve time
 * (mirror-needs-grant-proxy-does-not, CLAUDE.md) and the site is free, keyless
 * public data (the robots.txt `Disallow` block targets AI-training crawlers
 * specifically, not general fetch — "public data is public data, regardless
 * of robots", CLAUDE.md 2026-09-01).
 *
 * Attribution: the site's notes.txt asks for credit, so every response names
 * football-data.co.uk as the source.
 *
 * hosting-claims-ok: this file proxies football-data.co.uk per request and
 * stores no copy of its own — the comment above states that fact, it does
 * not describe Pipeworx as the holder of the data.
 */


const UA = 'pipeworx-mcp-football-odds-history/1.0 (+https://pipeworx.io)';
const BASE = 'https://www.football-data.co.uk';
const SOURCE = 'football-data.co.uk';

// Finished seasons never change (long edge cache). The in-progress season's
// file is appended to weekly, so it gets a short TTL. 404/error responses get
// a short TTL too, so a transient upstream hiccup self-heals quickly.
const LONG_CACHE = { '200-299': 604800, '400-499': 120, '500-599': 30 }; // 7d
const SHORT_CACHE = { '200-299': 900, '400-499': 120, '500-599': 30 }; // 15m

async function pwFetch(url: string, cacheTtlByStatus: Record<string, number>): Promise<Response> {
  return fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA }, cf: { cacheTtlByStatus } } as RequestInit,
    SOURCE,
  );
}

// ── League catalog ──────────────────────────────────────────────────
// "Main" leagues: one CSV per (league, season) at /mmz4281/<season>/<code>.csv.
// "Extra" leagues: one CSV per country covering ALL seasons at /new/<code>.csv.
// Both lists and every code were confirmed live against football-data.co.uk
// on 2026-10-12 (englandm.php / germanym.php / .../all_new_data.php and each
// country's own page).

interface MainLeague {
  code: string;
  name: string;
  country: string;
  earliest_season: string; // short code, e.g. "9394"
}

const MAIN_LEAGUES: MainLeague[] = [
  { code: 'E0', name: 'Premier League', country: 'England', earliest_season: '9394' },
  { code: 'E1', name: 'Championship', country: 'England', earliest_season: '9394' },
  { code: 'E2', name: 'League One', country: 'England', earliest_season: '9394' },
  { code: 'E3', name: 'League Two', country: 'England', earliest_season: '9394' },
  { code: 'EC', name: 'National League (Conference)', country: 'England', earliest_season: '0506' },
  { code: 'SC0', name: 'Premiership', country: 'Scotland', earliest_season: '9394' },
  { code: 'SC1', name: 'Championship', country: 'Scotland', earliest_season: '9394' },
  { code: 'SC2', name: 'League One', country: 'Scotland', earliest_season: '9394' },
  { code: 'SC3', name: 'League Two', country: 'Scotland', earliest_season: '9394' },
  { code: 'D1', name: 'Bundesliga', country: 'Germany', earliest_season: '9394' },
  { code: 'D2', name: '2. Bundesliga', country: 'Germany', earliest_season: '9394' },
  { code: 'I1', name: 'Serie A', country: 'Italy', earliest_season: '9394' },
  { code: 'I2', name: 'Serie B', country: 'Italy', earliest_season: '9394' },
  { code: 'SP1', name: 'La Liga', country: 'Spain', earliest_season: '9394' },
  { code: 'SP2', name: 'La Liga 2', country: 'Spain', earliest_season: '9394' },
  { code: 'F1', name: 'Ligue 1', country: 'France', earliest_season: '9394' },
  { code: 'F2', name: 'Ligue 2', country: 'France', earliest_season: '9394' },
  { code: 'N1', name: 'Eredivisie', country: 'Netherlands', earliest_season: '9394' },
  { code: 'B1', name: 'Jupiler Pro League', country: 'Belgium', earliest_season: '9394' },
  { code: 'P1', name: 'Primeira Liga', country: 'Portugal', earliest_season: '9394' },
  { code: 'T1', name: 'Süper Lig', country: 'Turkey', earliest_season: '9394' },
  { code: 'G1', name: 'Super League', country: 'Greece', earliest_season: '9394' },
];

interface ExtraLeague {
  code: string;
  name: string;
  country: string;
}

// One file per country, all seasons together — the site calls these the
// "additional" / "new" leagues (16 countries, closing odds only, back to
// 2012/13 for most).
const EXTRA_LEAGUES: ExtraLeague[] = [
  { code: 'ARG', name: 'Liga Profesional', country: 'Argentina' },
  { code: 'AUT', name: 'Bundesliga', country: 'Austria' },
  { code: 'BRA', name: 'Serie A', country: 'Brazil' },
  { code: 'CHN', name: 'Super League', country: 'China' },
  { code: 'DNK', name: 'Superliga', country: 'Denmark' },
  { code: 'FIN', name: 'Veikkausliiga', country: 'Finland' },
  { code: 'IRL', name: 'Premier Division', country: 'Ireland' },
  { code: 'JPN', name: 'J1 League', country: 'Japan' },
  { code: 'MEX', name: 'Liga MX', country: 'Mexico' },
  { code: 'NOR', name: 'Eliteserien', country: 'Norway' },
  { code: 'POL', name: 'Ekstraklasa', country: 'Poland' },
  { code: 'ROU', name: 'Superliga', country: 'Romania' },
  { code: 'RUS', name: 'Premier League', country: 'Russia' },
  { code: 'SWE', name: 'Allsvenskan', country: 'Sweden' },
  { code: 'SWZ', name: 'Super League', country: 'Switzerland' },
  { code: 'USA', name: 'MLS', country: 'USA' },
];

const MAIN_BY_CODE = new Map(MAIN_LEAGUES.map((l) => [l.code, l]));
const EXTRA_BY_CODE = new Map(EXTRA_LEAGUES.map((l) => [l.code, l]));

function validLeagueCodesMessage(): string {
  return (
    `Valid main-league codes (one file per season, e.g. /mmz4281/2425/E0.csv): ` +
    `${MAIN_LEAGUES.map((l) => l.code).join(', ')}. ` +
    `Valid extra-league codes (one file for all seasons, e.g. /new/ARG.csv): ` +
    `${EXTRA_LEAGUES.map((l) => l.code).join(', ')}. Call list_odds_leagues for names and countries.`
  );
}

// ── Season code handling (main leagues only) ────────────────────────
// football-data.co.uk's own convention is a 4-digit pair, e.g. "2425" for
// 2024/25, "9394" for 1993/94. We accept that literally (it is the only
// unambiguous bare-digit form — a plain "2024" could mean the 2023/24 OR
// 2024/25 season, so we refuse to guess) plus "YYYY-YY" / "YYYY/YYYY" forms
// with an explicit separator.
function normalizeMainSeason(input: string): string {
  const s = String(input).trim();
  if (/^\d{4}$/.test(s)) return s; // literal short code: "2425", "9394", "0506"
  const m = /^(\d{2,4})\s*[/-]\s*(\d{2,4})$/.exec(s);
  if (m) {
    const first = m[1].slice(-2);
    const second = m[2].slice(-2);
    return `${first}${second}`;
  }
  throw new Error(
    `Could not parse season "${input}". Use football-data.co.uk's own short code ` +
      `"YYZZ" (e.g. "2425" for 2024/25, "9394" for 1993/94), or "YYYY-YY"/"YYYY/YYYY" ` +
      `(e.g. "2024-25", "2024/2025"). A bare 4-digit year like "2024" is ambiguous ` +
      `between the 2023/24 and 2024/25 files, so it is refused rather than guessed.`,
  );
}

function currentMainSeasonCode(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() + 1 >= 7 ? y : y - 1; // European season runs ~Jul/Aug-May
  const a = String(startYear).slice(-2);
  const b = String(startYear + 1).slice(-2);
  return `${a}${b}`;
}

function mainSeasonLabel(shortCode: string): string {
  if (!/^\d{4}$/.test(shortCode)) return shortCode;
  const a = Number(shortCode.slice(0, 2));
  const b = Number(shortCode.slice(2, 4));
  const centuryA = a <= 30 ? 2000 : 1900; // 1993/94 .. 2029/30-ish before rollover
  const fullA = centuryA + a;
  return `${fullA}/${String(b).padStart(2, '0')}`;
}

// ── CSV parsing ──────────────────────────────────────────────────────

interface ParsedCsv {
  header: string[];
  rows: Record<string, string>[];
}

function parseCsv(text: string): ParsedCsv {
  const cleaned = text.replace(/^﻿/, '');
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(',').map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = (cells[c] ?? '').trim();
    }
    rows.push(row);
  }
  return { header, rows };
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** "16/08/2024" or "14/08/93" -> "2024-08-16" / "1993-08-14". */
function parseUkDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) return undefined;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yyyy = m[3];
  if (yyyy.length === 2) {
    const yy = Number(yyyy);
    yyyy = String(yy <= 30 ? 2000 + yy : 1900 + yy);
  }
  return `${yyyy}-${mm}-${dd}`;
}

// ── Fetching a CSV, with a loud (never-silent) 404/error path ────────

async function fetchCsv(path: string, cacheTtlByStatus: Record<string, number>, notFoundHint: string): Promise<ParsedCsv> {
  const url = `${BASE}${path}`;
  const res = await pwFetch(url, cacheTtlByStatus);
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('csv')) {
    // football-data.co.uk answers a missing file with either a 404 or (via
    // Apache mod_speling) a 300 "Multiple Choices" HTML page — neither is a
    // CSV, so content-type is the real signal, not just res.ok.
    throw new Error(`${SOURCE}: no data at ${path} (HTTP ${res.status}). ${notFoundHint}`);
  }
  const text = await res.text();
  return parseCsv(text);
}

// ── Odds normalization ────────────────────────────────────────────────
// Every column in every season's file is one of a small set of shapes, all
// documented at football-data.co.uk/notes.txt: a bookmaker/market code
// followed by H/D/A (1X2), by ">2.5"/"<2.5" (total goals), or by "AHH"/"AHA"
// (Asian handicap), with a "C" inserted right after the code for the closing
// line. Columns present vary by season (older seasons carry fewer
// bookmakers, no closing odds at all before ~2019/20) — we read whichever
// keys the season's own header actually has, never assume a fixed layout.
const BOOKMAKER_LABELS: Record<string, string> = {
  '1XB': '1XBet',
  B365: 'Bet365',
  BF: 'Betfair',
  BFD: 'Betfred',
  BMGM: 'BetMGM',
  BV: 'Betvictor',
  BS: 'Blue Square',
  BW: 'Bet&Win',
  CL: 'Coral',
  GB: 'Gamebookers',
  IW: 'Interwetten',
  LB: 'Ladbrokes',
  PP: 'Paddy Power',
  PS: 'Pinnacle',
  // Pinnacle's own column is "PS*" for 1X2 but plain "P*" for over/under and
  // Asian handicap in every season observed — not a legacy/current split,
  // just a different column name per bet type. Same bookmaker either way.
  P: 'Pinnacle',
  SK: 'Skybet',
  SO: 'Sporting Odds',
  SB: 'Sportingbet',
  SJ: 'Stan James',
  SY: 'Stanleybet',
  VC: 'VC Bet',
  WH: 'William Hill',
  BFE: 'Betfair Exchange',
  Max: 'Market maximum',
  Avg: 'Market average',
  BbMx: 'Betbrain maximum (legacy, pre-2019/20)',
  BbAv: 'Betbrain average (legacy, pre-2019/20)',
};
const CODES = Object.keys(BOOKMAKER_LABELS);

interface Triple {
  home?: number;
  draw?: number;
  away?: number;
}
interface Pair {
  over?: number;
  under?: number;
}
interface AhSide {
  home?: number;
  away?: number;
  line?: number;
}

function triple(row: Record<string, string>, h: string, d: string, a: string): Triple | undefined {
  const home = num(row[h]);
  const draw = num(row[d]);
  const away = num(row[a]);
  if (home === undefined && draw === undefined && away === undefined) return undefined;
  const t: Triple = {};
  if (home !== undefined) t.home = home;
  if (draw !== undefined) t.draw = draw;
  if (away !== undefined) t.away = away;
  return t;
}

function pair(row: Record<string, string>, over: string, under: string): Pair | undefined {
  const o = num(row[over]);
  const u = num(row[under]);
  if (o === undefined && u === undefined) return undefined;
  const p: Pair = {};
  if (o !== undefined) p.over = o;
  if (u !== undefined) p.under = u;
  return p;
}

interface OddsLine<T> {
  code: string;
  bookmaker: string;
  opening?: T;
  closing?: T;
}

function extract1x2(row: Record<string, string>): OddsLine<Triple>[] {
  const out: OddsLine<Triple>[] = [];
  for (const code of CODES) {
    const opening = triple(row, `${code}H`, `${code}D`, `${code}A`);
    const closing = triple(row, `${code}CH`, `${code}CD`, `${code}CA`);
    if (opening || closing) {
      const entry: OddsLine<Triple> = { code, bookmaker: BOOKMAKER_LABELS[code] };
      if (opening) entry.opening = opening;
      if (closing) entry.closing = closing;
      out.push(entry);
    }
  }
  return out;
}

function extractOverUnder25(row: Record<string, string>): OddsLine<Pair>[] {
  const out: OddsLine<Pair>[] = [];
  for (const code of CODES) {
    const opening = pair(row, `${code}>2.5`, `${code}<2.5`);
    const closing = pair(row, `${code}C>2.5`, `${code}C<2.5`);
    if (opening || closing) {
      const entry: OddsLine<Pair> = { code, bookmaker: BOOKMAKER_LABELS[code] };
      if (opening) entry.opening = opening;
      if (closing) entry.closing = closing;
      out.push(entry);
    }
  }
  return out;
}

function extractAsianHandicap(row: Record<string, string>): { market_line_opening?: number; market_line_closing?: number; books: OddsLine<AhSide>[] } {
  const books: OddsLine<AhSide>[] = [];
  for (const code of CODES) {
    const homeO = num(row[`${code}AHH`]);
    const awayO = num(row[`${code}AHA`]);
    const homeC = num(row[`${code}CAHH`]);
    const awayC = num(row[`${code}CAHA`]);
    // Older seasons gave some bookmakers (B365, GB, LB) their own handicap
    // line column; modern seasons share one market-wide line (AHh/AHCh)
    // handled separately below.
    const ownLine = num(row[`${code}AH`]) ?? num(row[`${code}AHh`]);
    if (homeO === undefined && awayO === undefined && homeC === undefined && awayC === undefined) continue;
    const entry: OddsLine<AhSide> = { code, bookmaker: BOOKMAKER_LABELS[code] };
    if (homeO !== undefined || awayO !== undefined) {
      entry.opening = { ...(homeO !== undefined ? { home: homeO } : {}), ...(awayO !== undefined ? { away: awayO } : {}), ...(ownLine !== undefined ? { line: ownLine } : {}) };
    }
    if (homeC !== undefined || awayC !== undefined) {
      entry.closing = { ...(homeC !== undefined ? { home: homeC } : {}), ...(awayC !== undefined ? { away: awayC } : {}) };
    }
    books.push(entry);
  }
  const market_line_opening = num(row.AHh);
  const market_line_closing = num(row.AHCh);
  const result: { market_line_opening?: number; market_line_closing?: number; books: OddsLine<AhSide>[] } = { books };
  if (market_line_opening !== undefined) result.market_line_opening = market_line_opening;
  if (market_line_closing !== undefined) result.market_line_closing = market_line_closing;
  return result;
}

// ── Row -> normalized match ───────────────────────────────────────────

interface NormalizedMatch {
  date?: string;
  time?: string;
  home_team: string;
  away_team: string;
  full_time: { home_goals?: number; away_goals?: number; result?: string };
  half_time?: { home_goals?: number; away_goals?: number; result?: string };
  referee?: string;
  match_stats?: Record<string, number>;
  odds_1x2: OddsLine<Triple>[];
  odds_over_under_2_5: OddsLine<Pair>[];
  odds_asian_handicap: { market_line_opening?: number; market_line_closing?: number; books: OddsLine<AhSide>[] };
  season_raw?: string; // extra leagues only — the literal Season column value
}

function normalizeMainRow(row: Record<string, string>): NormalizedMatch {
  const stats: Record<string, number> = {};
  const statCols: [string, string][] = [
    ['HS', 'home_shots'], ['AS', 'away_shots'], ['HST', 'home_shots_on_target'], ['AST', 'away_shots_on_target'],
    ['HC', 'home_corners'], ['AC', 'away_corners'], ['HF', 'home_fouls'], ['AF', 'away_fouls'],
    ['HY', 'home_yellow_cards'], ['AY', 'away_yellow_cards'], ['HR', 'home_red_cards'], ['AR', 'away_red_cards'],
    ['Attendance', 'attendance'],
  ];
  for (const [col, key] of statCols) {
    const v = num(row[col]);
    if (v !== undefined) stats[key] = v;
  }
  const m: NormalizedMatch = {
    date: parseUkDate(row.Date),
    home_team: row.HomeTeam,
    away_team: row.AwayTeam,
    full_time: { home_goals: num(row.FTHG), away_goals: num(row.FTAG), result: row.FTR || undefined },
    odds_1x2: extract1x2(row),
    odds_over_under_2_5: extractOverUnder25(row),
    odds_asian_handicap: extractAsianHandicap(row),
  };
  if (row.Time) m.time = row.Time;
  if (row.Referee) m.referee = row.Referee;
  if (row.HTHG || row.HTAG || row.HTR) {
    m.half_time = { home_goals: num(row.HTHG), away_goals: num(row.HTAG), result: row.HTR || undefined };
  }
  if (Object.keys(stats).length > 0) m.match_stats = stats;
  return m;
}

function normalizeExtraRow(row: Record<string, string>): NormalizedMatch {
  return {
    date: parseUkDate(row.Date),
    time: row.Time || undefined,
    home_team: row.Home,
    away_team: row.Away,
    full_time: { home_goals: num(row.HG), away_goals: num(row.AG), result: row.Res || undefined },
    odds_1x2: extract1x2(row),
    odds_over_under_2_5: extractOverUnder25(row),
    odds_asian_handicap: extractAsianHandicap(row),
    season_raw: row.Season,
  };
}

function matchesTeamFilter(m: NormalizedMatch, teamQuery: string): boolean {
  const q = teamQuery.toLowerCase();
  const home = (m.home_team ?? '').toLowerCase();
  const away = (m.away_team ?? '').toLowerCase();
  return home.includes(q) || away.includes(q) || q.includes(home) || q.includes(away);
}

function matchesDateRange(m: NormalizedMatch, dateFrom?: string, dateTo?: string): boolean {
  if (!m.date) return !dateFrom && !dateTo; // can't filter undated rows except by excluding them when a range was asked for
  if (dateFrom && m.date < dateFrom) return false;
  if (dateTo && m.date > dateTo) return false;
  return true;
}

function validateIsoDate(label: string, s: string | undefined): void {
  if (s === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${label} must be "YYYY-MM-DD" (got "${s}").`);
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 400;

function resolveLimit(input: unknown): number {
  if (input === undefined || input === null || input === '') return DEFAULT_LIMIT;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`"limit" must be a positive number (got "${input}"). Default is ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`);
  }
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function narrowHint(): string {
  return 'Narrow with "team", "date_from"/"date_to", or "season" (extra leagues) to see different matches; raise "limit" (max 400) to see more of this one.';
}

// ── Odds shaping: compact (default) vs full ─────────────────────────────
// The full normalized shape (every bookmaker, opening AND closing, plus
// shots/corners/cards/referee) runs to ~2.9KB/match — fine for one match,
// unusable as the default for a league season (380 matches = >1MB, more
// than a model should have to read to answer "what were the odds"). The
// compact default keeps only: closing 1X2 from Pinnacle, Bet365 and the
// market average/max; the market's closing over/under 2.5; and the Asian
// handicap closing LINE (the number itself, not a per-bookmaker breakdown)
// — plus date/teams/full-time score. Non-odds match detail (referee,
// half-time score, shots/corners/cards) and the full multi-bookmaker
// breakdown are both dropped by default and restored by `bookmakers`.
const CORE_1X2_CODES = new Set(['PS', 'P', 'B365', 'Max', 'Avg']);
const CORE_OU_CODES = new Set(['Max', 'Avg']);
const CORE_AH_CODES = new Set<string>(); // compact AH = the line only, no per-bookmaker odds

interface BookmakerScope {
  codes1x2: Set<string> | null; // null = every code
  codesOu: Set<string> | null;
  codesAh: Set<string> | null;
  keepOpening: boolean;
  keepExtras: boolean; // referee / half_time / match_stats
  form: 'compact' | 'full';
  detail: string;
}

function resolveBookmakersArg(input: unknown): BookmakerScope {
  if (input === undefined || input === null || input === '') {
    return {
      codes1x2: CORE_1X2_CODES,
      codesOu: CORE_OU_CODES,
      codesAh: CORE_AH_CODES,
      keepOpening: false,
      keepExtras: false,
      form: 'compact',
      detail:
        'Closing 1X2 from Pinnacle, Bet365 and the market average/max; the market\'s closing over/under 2.5; ' +
        'and the Asian handicap closing line (the number, not a per-bookmaker breakdown) where the season ' +
        'carries one. Referee/half-time/match-stats are omitted. Pass bookmakers:"all" (or an array of ' +
        'bookmaker codes) for opening+closing detail across every bookmaker plus full match detail.',
    };
  }
  if (typeof input === 'string' && input.trim().toLowerCase() === 'all') {
    return {
      codes1x2: null,
      codesOu: null,
      codesAh: null,
      keepOpening: true,
      keepExtras: true,
      form: 'full',
      detail: 'Opening and closing odds for every bookmaker this season carries, plus full match detail.',
    };
  }
  if (Array.isArray(input) && input.length > 0) {
    const codes = new Set(input.map((c) => String(c).trim()));
    return {
      codes1x2: codes,
      codesOu: codes,
      codesAh: codes,
      keepOpening: true,
      keepExtras: true,
      form: 'full',
      detail: `Opening and closing odds for bookmaker code(s): ${Array.from(codes).join(', ')}, plus full match detail.`,
    };
  }
  throw new Error(
    `"bookmakers" must be "all" or a non-empty array of bookmaker codes (e.g. ["B365","PS"]). Omit it for the compact default. See the README for the full code list (notes.txt on football-data.co.uk).`,
  );
}

function shapeOddsLines<T>(lines: OddsLine<T>[], codes: Set<string> | null, keepOpening: boolean): OddsLine<T>[] {
  const out: OddsLine<T>[] = [];
  for (const l of lines) {
    if (codes && !codes.has(l.code)) continue;
    if (keepOpening) {
      out.push(l);
    } else if (l.closing) {
      out.push({ code: l.code, bookmaker: l.bookmaker, closing: l.closing });
    }
  }
  return out;
}

function shapeMatch<T extends NormalizedMatch>(m: T, scope: BookmakerScope): T {
  const ah = m.odds_asian_handicap;
  const shapedAh: NormalizedMatch['odds_asian_handicap'] = { books: shapeOddsLines(ah.books, scope.codesAh, scope.keepOpening) };
  if (scope.keepOpening && ah.market_line_opening !== undefined) shapedAh.market_line_opening = ah.market_line_opening;
  if (ah.market_line_closing !== undefined) shapedAh.market_line_closing = ah.market_line_closing;

  // Spread first so any extra fields the caller attached (team_results adds
  // season/season_label per match) ride through untouched; only the odds
  // buckets and, in compact mode, the non-odds extras are rewritten below.
  const shaped: T = {
    ...m,
    odds_1x2: shapeOddsLines(m.odds_1x2, scope.codes1x2, scope.keepOpening),
    odds_over_under_2_5: shapeOddsLines(m.odds_over_under_2_5, scope.codesOu, scope.keepOpening),
    odds_asian_handicap: shapedAh,
  };
  if (!scope.keepExtras) {
    delete shaped.time;
    delete shaped.referee;
    delete shaped.half_time;
    delete shaped.match_stats;
  }
  return shaped;
}

// ── Tools ──────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'list_odds_leagues',
    description:
      'Lists every football-data.co.uk league code (22 main European leagues with per-season files, 16 extra-league countries with one all-seasons file), with names, countries and the file layout — call before match_odds/team_results to get a valid code.',
    summary: 'Every league code football-data.co.uk covers, with country and name.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'match_odds',
    description:
      'Historical football match results and odds (1X2, over/under 2.5 goals, Asian handicap) from football-data.co.uk, for one league + season. Default response is compact (closing lines from Pinnacle/Bet365/market avg+max, up to 50 matches); pass bookmakers:"all" or raise limit for more detail. Optionally filter by team or date range.',
    summary: 'Historical match results and odds for one league and season.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        league: { type: 'string', description: 'League code, e.g. "E0" (Premier League) or "ARG" (Argentina). Call list_odds_leagues for the full list.' },
        season: {
          type: 'string',
          description:
            'Required for main leagues (22 European divisions): football-data.co.uk\'s short code "YYZZ" (e.g. "2425" for 2024/25) or "YYYY-YY"/"YYYY/YYYY". Optional for extra-league countries (one file spans all seasons) — when given, matches rows whose Season column contains this year.',
        },
        team: { type: 'string', description: 'Optional: only matches involving this team (case-insensitive partial match on home or away).' },
        date_from: { type: 'string', description: 'Optional: ISO date "YYYY-MM-DD", inclusive lower bound.' },
        date_to: { type: 'string', description: 'Optional: ISO date "YYYY-MM-DD", inclusive upper bound.' },
        limit: { type: 'number', description: 'Max matches to return, default 50, max 400. Response reports total_matches and truncated so you know if you need to raise this or narrow the filters.' },
        bookmakers: {
          description:
            'Optional: "all" for opening+closing odds across every bookmaker, or an array of bookmaker codes (e.g. ["B365","PS"]) for opening+closing on just those. Omit for the compact default — closing-only odds from Pinnacle, Bet365 and the market average/max.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
      required: ['league'],
    },
  },
  {
    name: 'team_results',
    description:
      'A team\'s football results and odds across one or more seasons of a single football-data.co.uk league, newest first. Default response is compact (closing lines, up to 50 matches); pass bookmakers:"all" or raise limit for more. For a main league with no `seasons` given, searches the 5 most recent seasons; an extra-league country file already spans its whole history.',
    summary: 'One team\'s results and odds across multiple seasons of one league.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team: { type: 'string', description: 'Team name, case-insensitive partial match, e.g. "Man United" or "Barcelona".' },
        league: { type: 'string', description: 'League code, e.g. "E0" or "SP1". Call list_odds_leagues for the full list.' },
        seasons: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific season codes to search (main-league short codes like "2425", or a year to match against an extra-league Season column). Defaults to the 5 most recent seasons for a main league, or the whole file for an extra league.',
        },
        limit: { type: 'number', description: 'Max matches to return, default 50, max 400. Response reports total_matches and truncated so you know if you need to raise this or narrow the filters.' },
        bookmakers: {
          description:
            'Optional: "all" for opening+closing odds across every bookmaker, or an array of bookmaker codes (e.g. ["B365","PS"]) for opening+closing on just those. Omit for the compact default — closing-only odds from Pinnacle, Bet365 and the market average/max.',
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
      required: ['team', 'league'],
    },
  },
];

// ── match_odds ───────────────────────────────────────────────────────

async function matchOdds(args: Record<string, unknown>): Promise<unknown> {
  const league = String(args.league ?? '').trim().toUpperCase();
  if (!league) throw new Error(`"league" is required. ${validLeagueCodesMessage()}`);
  const team = args.team !== undefined ? String(args.team).trim() : undefined;
  const dateFrom = args.date_from !== undefined ? String(args.date_from).trim() : undefined;
  const dateTo = args.date_to !== undefined ? String(args.date_to).trim() : undefined;
  validateIsoDate('date_from', dateFrom);
  validateIsoDate('date_to', dateTo);
  const limit = resolveLimit(args.limit);
  const scope = resolveBookmakersArg(args.bookmakers);

  if (MAIN_BY_CODE.has(league)) {
    const info = MAIN_BY_CODE.get(league)!;
    if (args.season === undefined || String(args.season).trim() === '') {
      throw new Error(
        `"season" is required for main league "${league}" (${info.name}, ${info.country}). ` +
          `Use the short code "YYZZ" (e.g. "2425" for 2024/25); earliest available is "${info.earliest_season}", current is "${currentMainSeasonCode()}".`,
      );
    }
    const season = normalizeMainSeason(String(args.season));
    const isCurrent = season === currentMainSeasonCode();
    const path = `/mmz4281/${season}/${league}.csv`;
    const csv = await fetchCsv(
      path,
      isCurrent ? SHORT_CACHE : LONG_CACHE,
      `Season "${args.season}" (resolved to "${season}") may not exist for ${league}. Earliest for this league is "${info.earliest_season}", current is "${currentMainSeasonCode()}".`,
    );
    let matches = csv.rows.map(normalizeMainRow);
    if (team) matches = matches.filter((m) => matchesTeamFilter(m, team));
    if (dateFrom || dateTo) matches = matches.filter((m) => matchesDateRange(m, dateFrom, dateTo));
    const totalMatches = matches.length;
    if (totalMatches === 0) {
      throw new Error(
        `No matches found for league "${league}" season "${season}"${team ? ` with team filter "${team}"` : ''}${dateFrom || dateTo ? ' in that date range' : ''}. ` +
          `The season file has ${csv.rows.length} row(s) before filtering — check team spelling or widen the date range.`,
      );
    }
    const truncated = totalMatches > limit;
    const returned = (truncated ? matches.slice(0, limit) : matches).map((m) => shapeMatch(m, scope));
    return {
      league,
      league_name: info.name,
      country: info.country,
      season,
      season_label: mainSeasonLabel(season),
      match_count: returned.length,
      total_matches: totalMatches,
      truncated,
      narrow_hint: truncated ? narrowHint() : undefined,
      odds_form: scope.form,
      odds_form_detail: scope.detail,
      matches: returned,
      result_key: 'full_time.result / half_time.result: H = home win, D = draw, A = away win',
      source: SOURCE,
      source_url: `${BASE}${path}`,
      attribution: `Data via football-data.co.uk (${BASE})`,
      data_as_of: isCurrent ? new Date().toISOString() : 'season complete — historical file, not expected to change',
    };
  }

  if (EXTRA_BY_CODE.has(league)) {
    const info = EXTRA_BY_CODE.get(league)!;
    const path = `/new/${league}.csv`;
    const csv = await fetchCsv(path, SHORT_CACHE, `No file at ${path} for extra-league code "${league}".`);
    let matches = csv.rows.map(normalizeExtraRow);
    const seasonFilter = args.season !== undefined ? String(args.season).trim() : undefined;
    if (seasonFilter) {
      matches = matches.filter((m) => (m.season_raw ?? '').includes(seasonFilter));
    }
    if (team) matches = matches.filter((m) => matchesTeamFilter(m, team));
    if (dateFrom || dateTo) matches = matches.filter((m) => matchesDateRange(m, dateFrom, dateTo));
    const totalMatches = matches.length;
    if (totalMatches === 0) {
      const availableSeasons = Array.from(new Set(csv.rows.map((r) => r.Season).filter(Boolean))).slice(0, 25);
      throw new Error(
        `No matches found for extra league "${league}" (${info.country})${seasonFilter ? ` with season filter "${seasonFilter}"` : ''}${team ? ` and team filter "${team}"` : ''}. ` +
          `Season values present in this file include: ${availableSeasons.join(', ')}.`,
      );
    }
    const truncated = totalMatches > limit;
    const returned = (truncated ? matches.slice(-limit) : matches).map((m) => shapeMatch(m, scope)); // most recent when truncating
    return {
      league,
      league_name: info.name,
      country: info.country,
      season: seasonFilter ?? 'all seasons in file',
      match_count: returned.length,
      total_matches: totalMatches,
      truncated,
      narrow_hint: truncated ? narrowHint() : undefined,
      odds_form: scope.form,
      odds_form_detail: scope.detail,
      matches: returned,
      result_key: 'full_time.result: H = home win, D = draw, A = away win',
      source: SOURCE,
      source_url: `${BASE}${path}`,
      attribution: `Data via football-data.co.uk (${BASE})`,
      data_as_of: new Date().toISOString(),
      note: 'Extra-league files only carry CLOSING odds (no opening line) and a smaller set of bookmakers than the main leagues.',
    };
  }

  throw new Error(`Unknown league code "${league}". ${validLeagueCodesMessage()}`);
}

// ── team_results ───────────────────────────────────────────────────────

function recentMainSeasons(count: number): string[] {
  const cur = currentMainSeasonCode();
  const startYear = Number(cur.slice(0, 2)) <= 30 ? 2000 + Number(cur.slice(0, 2)) : 1900 + Number(cur.slice(0, 2));
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const y = startYear - i;
    const a = String(y).slice(-2);
    const b = String(y + 1).slice(-2);
    out.push(`${a}${b}`);
  }
  return out;
}

async function teamResults(args: Record<string, unknown>): Promise<unknown> {
  const team = String(args.team ?? '').trim();
  if (!team) throw new Error('"team" is required.');
  const league = String(args.league ?? '').trim().toUpperCase();
  if (!league) throw new Error(`"league" is required. ${validLeagueCodesMessage()}`);
  const seasonsArg = Array.isArray(args.seasons) ? args.seasons.map((s) => String(s)) : undefined;
  const limit = resolveLimit(args.limit);
  const scope = resolveBookmakersArg(args.bookmakers);

  if (MAIN_BY_CODE.has(league)) {
    const info = MAIN_BY_CODE.get(league)!;
    const seasons = (seasonsArg && seasonsArg.length > 0 ? seasonsArg.map(normalizeMainSeason) : recentMainSeasons(5));
    const bySeasons: { season: string; season_label: string; matches: NormalizedMatch[]; error?: string }[] = [];
    for (const season of seasons) {
      const isCurrent = season === currentMainSeasonCode();
      const path = `/mmz4281/${season}/${league}.csv`;
      try {
        const csv = await fetchCsv(path, isCurrent ? SHORT_CACHE : LONG_CACHE, `No file for ${league} season ${season}.`);
        const matches = csv.rows.map(normalizeMainRow).filter((m) => matchesTeamFilter(m, team));
        bySeasons.push({ season, season_label: mainSeasonLabel(season), matches });
      } catch (err) {
        bySeasons.push({ season, season_label: mainSeasonLabel(season), matches: [], error: err instanceof Error ? err.message : String(err) });
      }
    }
    const allMatches = bySeasons.flatMap((s) => s.matches.map((m) => ({ ...m, season: s.season, season_label: s.season_label })));
    const totalMatches = allMatches.length;
    if (totalMatches === 0) {
      throw new Error(
        `No matches found for team "${team}" in league "${league}" (${info.name}) across season(s) ${seasons.join(', ')}. ` +
          `Check spelling (football-data.co.uk team names, e.g. "Man United" not "Manchester United") or pass explicit "seasons".`,
      );
    }
    const truncated = totalMatches > limit;
    const returned = (truncated ? allMatches.slice(0, limit) : allMatches).map((m) => shapeMatch(m, scope));
    return {
      team_query: team,
      league,
      league_name: info.name,
      country: info.country,
      seasons_searched: seasons.map((s) => ({ season: s, season_label: mainSeasonLabel(s) })),
      match_count: returned.length,
      total_matches: totalMatches,
      truncated,
      narrow_hint: truncated ? narrowHint() : undefined,
      odds_form: scope.form,
      odds_form_detail: scope.detail,
      matches: returned,
      result_key: 'full_time.result / half_time.result: H = home win, D = draw, A = away win',
      source: SOURCE,
      attribution: `Data via football-data.co.uk (${BASE})`,
    };
  }

  if (EXTRA_BY_CODE.has(league)) {
    const info = EXTRA_BY_CODE.get(league)!;
    const path = `/new/${league}.csv`;
    const csv = await fetchCsv(path, SHORT_CACHE, `No file at ${path} for extra-league code "${league}".`);
    let matches = csv.rows.map(normalizeExtraRow).filter((m) => matchesTeamFilter(m, team));
    if (seasonsArg && seasonsArg.length > 0) {
      matches = matches.filter((m) => seasonsArg.some((s) => (m.season_raw ?? '').includes(s)));
    }
    const totalMatches = matches.length;
    if (totalMatches === 0) {
      throw new Error(
        `No matches found for team "${team}" in extra league "${league}" (${info.country})${seasonsArg ? ` with seasons filter ${seasonsArg.join(', ')}` : ''}. Check spelling.`,
      );
    }
    const truncated = totalMatches > limit;
    const returned = (truncated ? matches.slice(-limit) : matches).map((m) => shapeMatch(m, scope));
    return {
      team_query: team,
      league,
      league_name: info.name,
      country: info.country,
      match_count: returned.length,
      total_matches: totalMatches,
      truncated,
      narrow_hint: truncated ? narrowHint() : undefined,
      odds_form: scope.form,
      odds_form_detail: scope.detail,
      matches: returned,
      result_key: 'full_time.result: H = home win, D = draw, A = away win',
      source: SOURCE,
      attribution: `Data via football-data.co.uk (${BASE})`,
      note: 'Extra-league files only carry CLOSING odds and a smaller set of bookmakers than the main leagues.',
    };
  }

  throw new Error(`Unknown league code "${league}". ${validLeagueCodesMessage()}`);
}

// ── list_odds_leagues ───────────────────────────────────────────────────────

function listLeagues(): unknown {
  return {
    main_leagues: MAIN_LEAGUES.map((l) => ({
      code: l.code,
      name: l.name,
      country: l.country,
      file_layout: `one CSV per season: /mmz4281/<season>/${l.code}.csv`,
      earliest_season: l.earliest_season,
      earliest_season_label: mainSeasonLabel(l.earliest_season),
      current_season: currentMainSeasonCode(),
    })),
    extra_leagues: EXTRA_LEAGUES.map((l) => ({
      code: l.code,
      name: l.name,
      country: l.country,
      file_layout: `one CSV for all seasons: /new/${l.code}.csv`,
    })),
    total_main_leagues: MAIN_LEAGUES.length,
    total_extra_leagues: EXTRA_LEAGUES.length,
    notes:
      'Main leagues: full odds history (opening + closing, up to ~25 bookmakers) back to 1993/94. ' +
      'Extra leagues: closing odds only, fewer bookmakers, typically back to 2012/13. ' +
      'Pass a main-league code + required "season" to match_odds, or an extra-league code with an optional "season" year filter.',
    source: SOURCE,
    source_url: BASE,
    attribution: `Data via football-data.co.uk (${BASE})`,
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_odds_leagues':
      return listLeagues();
    case 'match_odds':
      return matchOdds(args);
    case 'team_results':
      return teamResults(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
