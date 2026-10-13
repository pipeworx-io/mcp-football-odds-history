# @pipeworx/football-odds-history

Historical football (soccer) match results and odds from sportsbooks — 1X2,
over/under 2.5 goals, and Asian handicap — for 22 main European leagues back
to 1993/94 and 16 further countries back to roughly 2012/13.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1779+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `list_odds_leagues()` — every league code this pack covers, with name, country
  and file layout (main leagues: one file per season; extra leagues: one file
  spanning all seasons).
- `match_odds(league, season?, team?, date_from?, date_to?, limit?, bookmakers?)`
  — results and odds for one league + season (season is required for the 22
  main leagues; optional for the 16 extra-league countries, whose single file
  already spans every season). Optional team / date filters.
- `team_results(team, league, seasons?, limit?, bookmakers?)` — one team's
  results and odds across multiple seasons of a single league, newest first.
  Defaults to the 5 most recent seasons for a main league if `seasons` is not
  given.

**Response size.** A full season is 380 matches, and the full odds detail for
one match (every bookmaker, opening and closing) runs to several KB — too
much to hand a model by default. Both tools default to a **compact** shape:
closing 1X2 from Pinnacle, Bet365 and the market average/max; the market's
closing over/under 2.5; and the Asian handicap closing *line* (the number,
not a per-bookmaker breakdown); referee/half-time/shots-corners-cards are
omitted. `limit` caps how many matches come back (default 50, max 400); the
response always reports `match_count` (returned), `total_matches` (all rows
matching your filters), `truncated`, and — when truncated — a `narrow_hint`
naming the arguments that narrow the result. Pass `bookmakers: "all"` for
opening+closing odds across every bookmaker plus full match detail, or
`bookmakers: ["B365","PS"]` for that detail on just the named code(s). Every
response says which form (`odds_form` / `odds_form_detail`) it returned.

Every odds entry names its bookmaker and whether the figure is the opening or
closing line; older seasons simply carry fewer bookmaker columns (and no
closing odds at all before roughly 2019/20) — the response only includes
whatever the source season actually has, never a fabricated value.

## Auth

Keyless. The upstream is free and requires no registration.

## Data sources

- football-data.co.uk (compiled by Joseph Buchdahl) — historical football
  match results and bookmaker betting odds across 22 main European leagues
  and 16 further countries, free and keyless. The site asks for attribution;
  every tool response names football-data.co.uk as the source.

Column coverage varies by season — the site adds bookmakers and an explicit
closing line over time, so a 1990s-era file has far fewer odds columns than a
2020s one, and a handful of very old combinations (e.g. the English National
League before it was tracked) simply don't exist. This pack reads whichever
columns a given season's file actually has rather than assuming a fixed
layout, and a request for a combination the site doesn't carry comes back as
a clear error rather than a silent empty result.

Two bookmaker codes resolve to the same name for a structural reason, not a
data error: Pinnacle's column is `PS*` for 1X2 odds but plain `P*` for
over/under and Asian handicap, in every season observed. Both are labeled
"Pinnacle" — the raw column code is kept on each entry so the distinction
is still visible if it matters.

Dates before the mid-2000s are given as a 2-digit year in the source file;
this pack applies the obvious pivot (`<=30` → 20xx, else 19xx), which is safe
across the site's actual 1993/94–present range.

The site's own per-country pages are the only place that enumerates valid
league/season combinations; there is no machine-readable index, so the
`list_odds_leagues` code list in this pack was built by checking each country's
page directly and should be re-verified if football-data.co.uk adds a league.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "football-odds-history": {
      "url": "https://gateway.pipeworx.io/football-odds-history/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/football-odds-history/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1779+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/list_odds_leagues \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/list_odds_leagues`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "football-odds-history": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-football-odds-history"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-football-odds-history
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Football Odds History data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
