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
| `fontSizePx` | `32` | Headline size |
| `sourceFontSizePx` | `18` | Source label size |
| `heightPx` | `104` | Height of the bar |
| `maxLines` | `2` | Lines a headline may wrap to before it is ellipsised. The marquee ignores it |

Per feed: `title`, `url`, `maxItems`, `reloadInterval`, `weight`, `freshWeight`,
`freshHours`, `type`, and for `type: "s2bluf"`, `maxReports`.

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

## Text size and wrapping

Sized by measurement rather than taste. At the original 26px on a single line,
**8 of 31 real headlines (26%) were already being ellipsised** on the 1080px
panel; at 32px on one line it would have been 77%. Allowing two lines is what
makes the larger text work — over a live rotation of 40 headlines, exactly one
(a 127-character MarketWatch headline) still clips at 32px, and 34px is the
first size at which the longest headline no longer fits in two lines.

So: bigger text *and* a quarter as much truncation. The bar grows from 74px to
104px, which costs nothing — the band above the ticker is empty on this layout.

The marquee is exempt: it scrolls, so it never truncates and must never wrap.

## Weighting the rotation

`weight` is how many slots in the rotation a feed gets, and the interleave is
smooth weighted round-robin — the scheduler nginx uses. A feed of weight 4
among seven of weight 1 gets four slots in eleven, **spread through** the
rotation rather than clumped into a block of four.

`freshWeight` and `freshHours` are the "especially if new" part: while a
feed's newest item is inside `freshHours`, the whole feed is promoted to the
higher weight, so the day a new wire report lands it takes over the bar and
then settles back.

Measured on a live rotation with the wire at `weight: 4, freshWeight: 7`: the
wire leads the rotation, takes 23% of the slots, and lands at positions 1, 3,
5, 6, 9, 11, 13, 14, 15 — gaps of one to three, never a block.

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
| S2 Wire (index) | 1.4 KB | 10 | yes |
| S2 Wire (one report page) | 16.6 KB | — | yes |
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

## S2 Underground's The Wire — `type: "s2bluf"`

The one feed here that needs following a link further, and the one that can
break because someone else changed their page.

S2's feed is an index of videos. Every title is just a date — "The Wire -
November 4, 2026" — and every description is boilerplate, so putting the feed
itself on a ticker shows a date stamp and nothing else. The brief is on each
report's own page, opening in S2's house format:

```
//BLUF: AMERICAN MIDTERM ELECTIONS RESULT IN MAJOR VICTORIES FOR DEMOCRATS.
CYBERATTACKS CONTINUE AROUND EUROPE, GROWING IN SCALE AND IMPACT. WARTIME
PREPARATIONS CONTINUE AROUND MIDDLE EAST.//
```

which splits into two or three sentences of 30–85 characters — already exactly
a ticker's length and tone. So the module reads the index, fetches the
`maxReports` most recent report pages, and lifts the BLUF out of each.

Both steps revalidate, and report pages are cached by URL, so a day with no new
report costs one 304 and nothing else. A new report costs 1.4 KB + 16.6 KB,
once.

**This reads someone else's HTML, so it is the most breakable thing here.** If
S2 drop the `//BLUF: … //` delimiter or move the reports, extraction returns
nothing, that counts as a failed fetch, and the previous wire lines stay on the
bar while it retries. It deliberately does *not* fall back to the bare dated
titles — a bar reading "The Wire - November 4, 2026" is worse than one showing
yesterday's brief. One unreachable report never costs the others.

## The Hacker News connection

Node abandons a connection attempt after 250 ms and switches address family
(Happy Eyeballs). The mirror's LAN publishes AAAA records but has no working
IPv6 route, and Hacker News is served from its own machines in the US, about
1.3 s away from Perth — so the IPv4 attempt was being cancelled at 250 ms and
the fetch reported `ETIMEDOUT`, while `curl -4` pulled the same URL down in
1.2 s. Every other feed here is on a CDN with an Australian edge and answers
well inside 250 ms, which is why Hacker News was the only one that failed.

`node_helper.js` raises the limit to 3 s with
`net.setDefaultAutoSelectFamilyAttemptTimeout()`. That is process-global, so
it affects other modules' requests too — acceptable, since it only applies
once an address family has already failed.

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
