# Mockups and the MMM-Newswire harness

Nothing in here is deployed. `scripts/02-modules-install.sh` only copies
`modules/*/`, so this directory never reaches the mirror's MagicMirror install.

## newswire-harness.html

Runs the **real** `MMM-Newswire.js` and its real stylesheet, against real
headlines, at the panel's 1080px width — so the ticker can be changed and
checked without touching the mirror. It stubs just enough of the MagicMirror
module API (`Module.register`, `updateDom`, `sendSocketNotification`) to let
the module run in a plain browser; the module itself is not modified or
duplicated.

It shows all four animations at once, plus the offline state and a regression
case.

```bash
python -m http.server 8478 --bind 127.0.0.1 --directory .
```

Then open <http://127.0.0.1:8478/_mockups/newswire-harness.html> — run the
server from the repository root, not from this directory, because the page
loads the module from `../modules/MMM-Newswire/`. It must be served over HTTP:
opened as a `file://` URL the browser blocks the `fetch` of `headlines.json`.

What to look for:

- **Each animation** behaves as intended, and nothing is clipped at 1080px.
- **The fps counter** in each caption. These animations are transform/opacity
  only so the GPU composites them; a figure far below the display's refresh
  rate means something has started forcing repaints. (A backgrounded or hidden
  browser tab throttles itself and will read far lower — judge it with the
  window in front.)
- **The regression row** must say PASS. It replays the real startup order: the
  node helper broadcasts an empty payload before any network happens, and the
  headlines follow seconds later. That second payload has to replace the
  placeholder. It did not, once, and the mirror sat on "Fetching headlines"
  with 27 headlines already cached behind it.

## headlines.json

The fixture the harness renders, committed so the page works from a fresh
clone. Refresh it from the live feeds with:

```bash
node _mockups/refresh-headlines.js
```

That runs the real `node_helper.js` against the feed list in
`config/config-guest.js`, so the fixture always matches what the mirror is
actually configured to pull — there is no second copy of the feed list or the
defaults to drift out of step.

## ticker-options.html

The animation options as first proposed, side by side: cross-fade, vertical
roll, continuous marquee and wipe reveal. Kept as the record of what was
chosen and why — vertical roll as the default, and the marquee at half the
speed shown here (the crawl here runs at 446 px/s; the module ships at 223).
