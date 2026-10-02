# Pokédex weekly

A weekly magazine of Pokémon card market picks, built from real TCGplayer price data and published as a phone-friendly web app. Runs at $0.

## How it works

1. **Daily job** (`.github/workflows/issue.yml`, 21:30 UTC): copies the TCGplayer market price of every English Pokémon single and sealed product from [TCGCSV](https://tcgcsv.com/), and backfills up to 90 days of history from TCGCSV's daily archive.
2. **Weekly issue** (Thursday night's run, ready Friday morning US time): compares today's prices with 7, 30 and 90 days ago, runs the list rules in `pipeline/score.py`, and writes `issue-N.json`.
3. **Graded prices** (optional): if the `PPT_API_KEY` repository secret is set, PSA 10 and PSA 9 prices for the issue's picks are looked up on PokemonPriceTracker's free tier, a few per run.
4. **Site**: `web/` is a static app with no build step. The workflow copies it and the issue files to GitHub Pages.

Saved data (price snapshots, issues) lives on the `data` branch, rewritten as a single commit each run.

## Tuning the picks

- Thresholds, list size and eras: `pipeline/config.py`
- The rule for each list: the `LISTS` table and the functions above it in `pipeline/score.py`
- Name and tagline: `TITLE` and `TAGLINE` in `pipeline/config.py`

## Running a new issue by hand

Actions → **Build issue and publish** → Run workflow → `cut: force`.

## Testing locally without network access

```
python tests/fixture_server.py /tmp/testdata 8765 &
TCGCSV_BASE=http://127.0.0.1:8765 TCGCSV_PAUSE=0 MIN_PRODUCTS=100 python -m pipeline.run --data-dir /tmp/testdata
```

The fixture serves made-up numbers in TCGCSV's format. It is only for testing the code.

## Limits of the free version

No sales counts, no per-condition prices, graded prices only for the picks, and no Reddit or X scan yet. This is market information, not financial advice. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay.
