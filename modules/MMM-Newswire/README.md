# MMM-Newswire

A news ticker for the bathroom mirror. Replaces MagicMirror's stock `newsfeed`
module.

## Why not the stock module

Two reasons, both measured on this mirror's actual feeds.

**Bandwidth.** The stock module polls every five minutes and never sends a
cache validator — worse, it explicitly sends `Cache-Control: no-cache,
no-store, must-revalidate`, so every poll downloads the whole feed even when
nothing has changed. With the old five-feed list that was about **33 MB a
day**, three quarters of it the Guardian's 114-item feed.

This module fetches every four hours, stores each feed's `ETag` /
`Last-Modified` and sends them back. Seven feeds now cost about **0.25 MB a
day**.

Note that gzip is *not* where the saving comes from. Node's `fetch` negotiates
that on its own and the stock module already had it — ABC's feed is 85 KB raw
but only 10 KB on the wire. Budget by wire bytes, not by raw size.

**Motion.** A cross-fade does not read across a two-way mirror; anything that
sits still sinks into the glass.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `animation` | `"roll"` | `roll`, `fade`, `marquee` or `wipe` — see below |
| `holdMs` | `9000` | How long one headline holds still (not marquee) |
| `transitionMs` | `700` | Length of the change itself (not marquee) |
| `marqueeSpeed` | `223` | Crawl speed in **pixels per second** |
| `marqueeItems` | `10` | Headlines per marquee pass |
| `maxItems` | `60` | Headlines in the rotation |
| `maxItemsPerFeed` | `6` | Per feed, before the interleave. Overridable per feed |
| `reloadInterval` | `4 h` | Overridable per feed |
| `retryMs` | `10 min` | First retry after a failure; steps back toward `reloadInterval` |
| `showSource` | `true` | The small uppercase source label |
| `showAge` | `false` | Adds "2h", "35m" after the headline |
| `staleAfterHours` | `12` | After this with no successful fetch, the bar says `offline` |
| `fontSizePx` | `26` | Headline size |
| `sourceFontSizePx` | `15` | Source label size |
| `heightPx` | `74` | Height of the bar |

### Animations

- **`roll`** (default) — the headline lifts out upward and the next rises in
  from below. Reads as a departures board: one clear movement per change.
- **`fade`** — plain cross-fade. The stock behaviour, for when the mirror
  should be as calm as possible.
- **`marquee`** — a continuous crawl. Speed is set in pixels per second, so it
  does not speed up just because the headlines in that pass are short.
- **`wipe`** — the headline writes on left to right, holds, then cuts.

All four animate transform and opacity only (plus `clip-path` for the wipe), so
the GPU composites them instead of repainting text every frame. That matters
here because the whole page is rotated 90° for the portrait panel.

The marquee strip is capped at `marqueeItems` because it is one composited
layer: ten headlines at the default font is about 8,400 px, comfortably inside
the 16,384 px texture limit of the mirror's Intel HD 500. Push it much further
and Chromium tiles the layer and the crawl starts to stutter.

## Feeds

```js
feeds: [
  { title: "ABC News", url: "...", maxItems: 6, reloadInterval: 4*60*60*1000 },
]
```

`title` is what shows as the source label. Feed order sets the interleave
(sources alternate rather than arriving in blocks) and decides which source is
credited when two feeds carry the same story — ABC News and ABC Business share
their lead most days, and the duplicate is dropped.

Measured, as of 3 Nov 2026 — "revalidates" means an unchanged feed costs a 304
with no body:

| Feed | Wire bytes | Items | Revalidates |
| --- | --- | --- | --- |
| ABC News | 10.0 KB | 25 | no |
| SBS News | 6.5 KB | 25 | no validator offered |
| ABC Business | 10.1 KB | 25 | no |
| MarketWatch | 2.5 KB | 10 | yes |
| Investing.com | 1.2 KB | 10 | yes |
| RBA media releases | 0.6 KB | 1 | yes |
| Hacker News | 11.2 KB | 30 | no validator offered |

Known bad: `theregister.com` is 318 KB a fetch. `hnrss.org` returns 502 often
enough not to depend on it — `news.ycombinator.com/rss` is first-party and
stays up. The Guardian AU feed was dropped: 87 KB and 114 items for a ticker
that shows one headline at a time. The "Where's Wally" travel feed is
deliberately absent too: MMM-WallyMap already puts the trip, chapter, post
title and both endpoints on screen, so in the ticker as well it would only be
saying the same thing twice. Nor is the neaves.au blog feed: the bar is news
only.

### Getting a 304 out of Node

Node's `fetch` sends `Cache-Control: no-cache` and `Pragma: no-cache` of its
own accord. Express treats a request saying *no-cache* as a refusal to accept a
304 and returns the whole body anyway, so a conditional request to neaves.au
was silently pointless until both headers were overridden with
`Cache-Control: max-age=0`. With the override, five of the nine feeds
revalidate instead of one — three of the seven configured here.

## Behaviour when things break

- A feed that fails keeps its previous headlines on screen and retries sooner
  than the normal interval, stepping back toward it as failures accumulate. It
  is never dropped permanently.
- A response that parses to zero items counts as a failure, **and its validator
  is not stored** — otherwise the next poll would get a 304 for the junk and
  the feed would be stuck on it.
- Headlines and validators are cached to `~/.cache/mmm-newswire/state.json`,
  written via a temp file and rename. The updater restarts MagicMirror at 03:00
  nightly; without this the ticker would sit empty every morning until the
  fetches landed, and would refetch every feed in full.
- With no headlines at all the bar says so plainly rather than going blank.
- After `staleAfterHours` with no successful fetch, a small `offline` marker
  appears, so old headlines are never presented as current.

## No dependencies

Custom modules reach the mirror by `cp` from this repo, never `npm install`, so
anything requiring a package would work on a dev box and fail on the mirror.
The RSS/Atom/RDF parser is hand-rolled in `node_helper.js` for that reason.
