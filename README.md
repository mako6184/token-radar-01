# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mako6184/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mako6184/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar built from the sealed DefiLlama snapshot: every protocol that still records no token (and is not a wrapped or staked product of one that trades), ranked by the implied value of its launch, each with a concrete, costed farm plan.

## How it works

- **Census** — the watchlist rule applied at every size: 198 pre-token protocols, with the full official watchlist (40) covered.
- **Implied value** — nearest-peer comps: the 24 tokenised peers nearest in log TVL (a fixed penalty when the category differs), far-out comp multiples trimmed against the selected set's own median, and the value read off the comps' market caps scaled by the TVL ratio to the power 0.92, adjusted for 7-day TVL growth and protocol age. Validated with 5-fold cross-validation on held-out peers (median error ×3.0, 28% within ×2).
- **Launch propensity** — a logistic model over the whole snapshot on size, age, chain count, momentum and the category's own token rate, cross-validated (Brier 0.204 vs 0.248 base rate), shown as context, not a promise.
- **Farm plans** — per-protocol steps generated from category, chain and size; every step states its cost and time, and each row carries a season cash cost and a verdict.

## Run it

```sh
node main.ts --input <snapshot.json>   # writes board.json, data.js, dossier.json, dashboard/
```

Open `dashboard/index.html` for the board: sortable and filterable, with a detail view for every protocol. No network needed.

---

Entered on [make.fun](https://make.fun/?ref=mako6184&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
