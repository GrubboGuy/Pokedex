"""Settings for the picks. Change the numbers here to tune them."""

TITLE = "Pokédex"
TAGLINE = "The daily card market mag"
EDITION_TZ = "America/New_York"  # the calendar day the picks belong to, for marking what is new today

# TCGplayer category for English Pokemon cards on TCGCSV.
CATEGORY_ID = 3

# How many picks each list shows, and how many may come from one set.
PICKS_PER_LIST = 8
MAX_PER_SET = 3

# Days back we want a price snapshot for. Missing ones are backfilled from
# TCGCSV's daily archive, a few per run.
HISTORY_OFFSETS = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 28, 30, 35, 42, 49, 56, 63, 70, 77, 84, 90]
MAX_ARCHIVE_DOWNLOADS_PER_RUN = 24
HISTORY_KEEP_DAYS = 120

# A 7-day move bigger than this is treated as a data glitch, not a pick.
MAX_SANE_WEEKLY_MOVE = 3.0

# Eras by set release date (first day of each era). Year ranges are approximate.
ERAS = [
    ("wotc", "Wizards of the Coast", "1999-01-01"),
    ("ex", "EX", "2003-07-01"),
    ("dp", "Diamond & Pearl to HeartGold SoulSilver", "2007-05-01"),
    ("bwxy", "Black & White and XY", "2011-04-01"),
    ("sm", "Sun & Moon", "2017-02-01"),
    ("swsh", "Sword & Shield", "2020-02-01"),
    ("sv", "Scarlet & Violet", "2023-03-01"),
    ("mega", "Mega Evolution", "2025-09-01"),
]

# Set-name prefixes, used when a set has no usable release date (promo groups).
ERA_PREFIXES = [
    ("ME", "mega"), ("SV", "sv"), ("SWSH", "swsh"), ("SM", "sm"), ("XY", "bwxy"),
    ("BW", "bwxy"), ("HGSS", "dp"), ("DP", "dp"), ("EX ", "ex"),
]

SEALED_WORDS = (
    "booster box", "elite trainer box", "booster bundle", "booster pack",
    "collection", "tin", "build & battle", "blister", "premium", "bundle",
    "trainer box", "display",
)
SEALED_SKIP_WORDS = ("code card", " case", "case)", "sleeves", "playmat", "binder", "deck box")

# PokemonPriceTracker free tier: 100 credits a day, 2 per card with graded data.
GRADED_LOOKUPS_PER_RUN = 40
GRADED_MAX_AGE_DAYS = 7

SOURCES = [
    {
        "id": "tcgcsv",
        "name": "TCGplayer market price, via TCGCSV",
        "url": "https://tcgcsv.com/",
        "note": "Daily copy of TCGplayer's own price data. Market price is TCGplayer's figure for what a card has recently sold for. The cheapest copy for sale is the lowest-priced copy listed on TCGplayer at that time, in any condition.",
    },
    {
        "id": "rarebox",
        "name": "Price history before Sept 16, 2026, via Rarebox",
        "url": "https://github.com/novaoc/rarebox-price-history",
        "note": "A public copy of older daily TCGplayer prices, used once to fill in our price history from June to mid-September 2026. Single cards only. On days when a card had no market price, it uses the middle asking price.",
    },
    {
        "id": "poketrace",
        "name": "eBay sold prices and prices by condition, via PokeTrace",
        "url": "https://poketrace.com/",
        "note": "eBay sold prices for ungraded cards, and TCGplayer prices by condition, each with the number of sales. Looked up for the current picks only. eBay sale counts are approximate.",
    },
    {
        "id": "ppt",
        "name": "eBay graded sales, via PokemonPriceTracker",
        "url": "https://www.pokemonpricetracker.com/",
        "note": "Prices of PSA-graded copies from completed eBay sales, looked up for the current picks only.",
    },
]
