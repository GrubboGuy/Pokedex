# Pokédex daily

Daily Pokémon card market picks, built from real TCGplayer price data and published as a phone-friendly web app. Runs at $0.

## How it works

1. **Morning run** (`.github/workflows/issue.yml`, 05:05 UTC with backups at 06:35 and 08:05 UTC, early because GitHub starts scheduled runs hours late and sometimes skips them; the aim is done by 7:00 AM US Eastern all year): copies the TCGplayer market price of every English Pokémon single and sealed product from [TCGCSV](https://tcgcsv.com/), saves it as that day's snapshot, compares it with 7, 30 and 90 days ago, re-runs the list rules in `pipeline/score.py` and writes `today.json`, the picks the site shows. Picks that were not in the previous day's lists are marked as new.
   - An **evening run** (21:30 UTC) saves the day's prices soon after TCGCSV refreshes and tops up the eBay and graded lookups. Three more runs through the day (15:20, 19:20 and 01:20 UTC) refresh the live eBay prices. None of these change the picks. Pushes do not change them either, unless the commit message contains `[cut issue]`; every push to `main` runs the job, including an empty commit.
   - TCGCSV withdrew its public price archive in September 2026, so history before 2026-09-16 was seeded once from [Rarebox](https://github.com/novaoc/rarebox-price-history) with `tools/seed_history.py` (singles only). There is no data for 2026-09-16 to 2026-09-30.
2. **Numbered issue**: the Friday-morning run (Thursday's prices) also starts a new `issue-N.json`. That copy is kept as cut and listed under Back issues; the daily refreshes in between only change `today.json`.
3. **eBay sold prices** (optional): if the `POKETRACE_API_KEY` repository secret is set, eBay sold averages for raw cards and TCGplayer prices by condition, each with sale counts, are looked up on PokeTrace's free plan for the issue's picks every day.
4. **Graded prices** (optional): if the `PPT_API_KEY` repository secret is set, PSA 10 and PSA 9 prices for the issue's picks are looked up on PokemonPriceTracker's free tier, a few per run.
5. **Live eBay prices** (optional): if the `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` repository secrets are set (a production keyset from developer.ebay.com, with "Exempted from Marketplace Account Deletion" switched on), each pick gets the cheapest matching Buy It Now listing from eBay's Browse API, with shipping and the condition the seller declared (`pipeline/ebay.py`). Listings are matched on name, number and version; graded, damaged, foreign-language and far-too-cheap listings are skipped. Nothing about sellers is stored.
   - **Cheaper on eBay**: on scheduled runs and re-picks the job also looks through about 150 often-traded singles (`deal_pool` in `pipeline/score.py`) for a Near Mint copy listed 15% to 40% under the market price, and publishes the best as their own list. A tally in `ebay-usage.json` keeps the day's calls under eBay's default 5,000.
6. **Versions**: every price is for one printing of a card. `variants_for` in `pipeline/score.py` lists the others (same number, and same name on another number in the set). PSA prices are only attached when they can be tied to a version (`pipeline/graded.py`).
7. **Site**: `web/` is a static app with no build step and self-hosted fonts (Archivo, Newsreader, VT323, all under the SIL Open Font License). The workflow copies it and the issue files to GitHub Pages.

Saved data (price snapshots, issues) lives on the `data` branch, rewritten as a single commit each run.

## Tuning the picks

- Thresholds, list size and eras: `pipeline/config.py`
- The rule for each list: the `LISTS` table and the functions above it in `pipeline/score.py`
- Name and tagline: `TITLE` and `TAGLINE` in `pipeline/config.py`

## Running a new issue by hand

Actions → **Build issue and publish** → Run workflow → `cut: force`. A push whose commit message contains `[cut issue]` does the same.

## Testing locally without network access

```
python tests/fixture_server.py /tmp/testdata 8765 &
TCGCSV_BASE=http://127.0.0.1:8765 TCGCSV_PAUSE=0 MIN_PRODUCTS=100 python -m pipeline.run --data-dir /tmp/testdata
```

The fixture serves made-up numbers in TCGCSV's format. It is only for testing the code.

The site also gets `data/search.json` (every product, for the Search tab) and `data/sets/<id>.json` (price history per set), written by `pipeline/site.py` on every run.

## Limits of the free version

No sales counts, no per-condition prices, graded prices only for the picks, and no Reddit or X scan yet. This is market information, not financial advice. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay.
