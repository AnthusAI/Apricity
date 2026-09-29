# Scale: ranked pages without reading whole tables (design, 2026-09-27)

Today every ranked page downloads whole tables and ranks them in the browser. That is fine at the
current size and will not be at 10–100×. This note says what each page reads now, where it stops
working, and how the data model changes so that a page asks for **one page of results, already in
order**. It builds on `design/storage.md` (one schema, three backends; `resource.ts` is the source of
truth; pure logic written once and specified in Gherkin).

## §0 Principles

1. **A page reads a page.** Every list the site shows (Home, Activity, a tab, a tag, a sample's clips)
   is one indexed query of about 24 rows, whatever the size of the library. Nothing lists a table to
   sort it.
2. **Rank is written, not computed on read.** When something that decides an order changes (a rating,
   a tag, a title, a license, the passing of a day), a writer updates the rows that order it. Readers
   only query.
3. **A ranked row carries what its card shows** (title, path, kind, owner, tags, stars), so a page is
   one query, not a query plus a lookup per card.
4. **The math is written once.** The Bayesian standing, the windows, the home page's worth and the sort
   keys live in `web/src/data/ranked.ts` (with `rank-window.ts` and `home-feed.ts`), used by the ranking
   Lambda and the web alike and tested there (`test/ranked.test.ts`: the keys sort exactly as the rank
   functions order).
5. **The same pages everywhere.** The cloud keeps ranked rows with a Lambda on the tables' streams; a
   local library computes the same rows in the web app from its tables with the same functions
   (`data/ranked-read.ts`), which is instant at a local library's size and leaves nothing to keep in step.

## §1 What pages read today

Production, 2026-09-27 (DynamoDB item counts): 1,401 clips, 602 candidates, 325 markers, 217 activity
lines, 166 activity cards, 148 samples, 126 tally rows, 86 score refs, 85 recordings, 61 ratings, 13
scores, 1 handle.

| Page | Reads | Grows with | Becomes slow near |
|---|---|---|---|
| Activity, Top | every Activity card; every Tally row for scores, samples and clips | cards; items × days rated | ~2k cards or ~20k tally rows |
| Activity, Recent | one page of cards, then a lookup per card | — (paged) | fine; but the kind filter is a filter-after-read, so a rare kind returns thin pages |
| Home | every Score record **with its text**; every score Tally row | scores; score-days rated | ~1k scores (text dominates) |
| Tag leaderboard, `/tags` | every Score record with its text; score tallies | scores | ~1k scores |
| Scores / Beats / Chords / Melodies tabs | every Score with text; score tallies | scores | ~1k scores |
| Clips tab | every Clip; every Sample (the library index); clip tallies | clips; library | ~10k clips |
| Samples tab | the library index: every Sample, Recording, Clip, Marker, Job | library | ~5k samples |
| Any page, not a curator | the hidden-item check: every Sample's recording id, every Recording, every Clip id and ScoreRef | library, clips, refs | ~20k clips + refs |
| Names on cards | every Handle | people | ~10k people |
| Search boxes | whatever list is loaded, filtered in the browser | — | only works while everything is loaded |

AppSync returns at most 1,000 items a page and pages are sequential, about 0.2–1.3 s each from the
browser; tally rows accumulate per item per day forever. Those two facts set the thresholds above.

## §2 The model

### §2.1 `Ranked`: one row per item per list it appears in

```ts
Ranked: a.model({
  id: a.id().required(),           // `<list>|<targetType>#<targetId>`
  list: a.string().required(),     // which list this row orders (below)
  sort: a.string().required(),     // the list's order, as a string that sorts descending (below)
  targetType: a.ref("RatingTarget").required(),
  targetId: a.id().required(),
  // What the card shows, copied here so a page is one query:
  title: a.string(), kind: a.string(), owner: a.string(), path: a.string(),
  samplePath: a.string(), clipStart: a.float(), clipEnd: a.float(), tags: a.string().array(),
  stars: a.float(), ratings: a.integer(),   // in the list's window
  lastAt: a.datetime(),
})
.secondaryIndexes((i) => [i("list").sortKeys(["sort"]).queryField("rankedByList")])
.authorization(everyone),               // written only by the ranking Lambda
```

**Lists** (the partition key):

| List | Order | Page |
|---|---|---|
| `feed\|top\|<kind or all>` | worth: all-time stars × kind weight × freshness (`data/home-feed.ts`) | Home, Top |
| `feed\|recent\|<kind or all>` | latest activity | Home, Recent (replaces the filter-after-read) |
| `<kind>\|<window>` (`beat\|week`, `clip\|all`, `sample\|month`…) | Bayesian score in the window, then newest | each tab |
| `tag\|<tag>\|<window>` | Bayesian score in the window | a tag's leaderboard |
| `tags` | how many scores use the tag (one row per tag; built) | `/tags`, Home's tag strip, a tag page's "Other tags" |
| `hidden` | none: one row per hidden item, its id only (built) | anyone not a curator, to leave hidden items out |

**Sort keys** are strings that sort in list order: fixed-width, zero-padded fields, most significant
first, e.g. `1|3.8421|2026-09-26T22:10:00Z` for a rated item (rated flag, Bayesian score to four
places, latest activity). Queries read the index descending, so the best comes first and ties go to the
most recent, as `rank()` in `data/rank-window.ts` orders them today.

**Hidden items** (a sample whose recording has no documented license, its clips, and the scores that
use it) are listed in `hidden`: one row per item, carrying its id and nothing else. Readers who aren't
curators read that list (a few rows) and leave those items out; curators see them flagged. That
replaces the hidden-item check (§1), which listed every Clip, ScoreRef, Recording and Sample. It lists
every score, and the samples and clips that have a card (only those show in a list the Lambda keeps).
The feed and tag lists still hold hidden items' rows, as in phase 1; a page skips them. A `…|curator`
partition (the public lists never holding them) remains possible if that ever matters: hidden items are
rare, so pages are rarely thinned.

**Window widening** (a quiet week shows the month): a leaderboard whose window's first page has no
rated rows reads the next wider window's list instead, and says so. The feed's Top counts stars over
all time (a stored order can't widen), with freshness lifting what's new.

### §2.2 Who writes `Ranked`

A **ranking Lambda** fed by the streams of `Tally` (stars changed), `Score` (title, kind, tags, owner,
new, deleted), `Sample` and `Clip` (new, renamed, retired), `Activity` (latest activity), and `Recording`
(license documented or not). For each change it computes the item's standings (all time and each
window, from its Tally rows) and writes that item's rows in every list it belongs to: 5–15 writes per
rating, in one or two `TransactWriteItems`.

The Lambda also follows **Recording** (documented or not), **Sample** (its recording changed) and
**ScoreRef** (a score's samples) streams: a change rebuilds everything whose hiding could follow it (a
recording's samples, their clips and the scores using them). A score's tags changing recounts those
tags' rows in `tags` (a COUNT query of each tag's `tag|<tag>|all` list).

A **nightly job** (EventBridge, once a day) ages the windows: for every item rated in the last year it
recomputes the week, month and year standings and the home page's freshness, and rewrites the rows
whose sort keys changed. Tally day rows stay the source of truth, so the job can rebuild everything.

The **backfill** is the nightly pass run once by hand (the Lambda invoked with an empty event) after the
first deploy; it is also the recovery path.

### §2.3 Leaner reads elsewhere

- **Scores without their text.** List queries select the fields a list shows; the text loads when a
  score opens. (`Score.list` currently returns every score's full text.)
- **Handles on demand.** Cards look up the handles of the owners on the page, in a batch get with a
  cache, instead of listing every handle.
- **A sample's clips by index.** The sample page reads `clipsBySample`, as it mostly does already; the
  Clips tab reads `Ranked`, not every Clip plus the library index.
- **Comment counts** are already on Activity cards; `Ranked` rows copy them for every list.

### §2.4 Search

The search boxes filter what is loaded, which stops working once lists are paged. Two options, decided
when phase 3 starts:

1. **A `SearchTerm` model** written by the ranking Lambda: one row per (normalized word prefix, item),
   queried by prefix. Cheap, handles titles, tags and handles, no fuzzy matching.
2. **OpenSearch** fed from DynamoDB (Amplify's zero-ETL integration): fuzzy, faceted, a monthly
   running cost.

### §2.5 A local library

The web app's `rankedPage` (`data/ranked-read.ts`) computes a local library's rows from its scores and
ratings with the same functions and pages them the same way, so the views don't know which mode they
are in. (A local library has no Activity cards; a score's news there is its last change.)

## §3 Phases

| Phase | When | What |
|---|---|---|
| **1** | before ~1k scores or ~2k activity cards (built 2026-09-27) | `Ranked` with the `feed\|…` and `tag\|…` lists; the ranking Lambda, its nightly pass and backfill; score lists without text. Home and tag pages each read a page at a time. |
| **2** | before ~10k clips or ~5k samples | **Built 2026-09-27:** the `hidden` list replacing the hidden-item check; `tags` rows for `/tags` and Home's tag strip. **Moved to phase 3** (they lose features until search is paged too: the tabs' search boxes, "Mine" and the Clips filters all work on the whole list): the per-kind tab lists (`<kind>\|<window>`) and the Clips and Samples tabs paged from `Ranked`; handles on demand (needs an owner index people can't spoof, and every name label reads them synchronously today). |
| **3** | before ~50k items, or when search matters | search (§2.4), with the tabs paged from `Ranked` and "Mine" and the Clips filters as lists or search facets; handles on demand; the curation candidates feed (`storage.md` §1.5, §7). |

Each phase ships behind the same web views: a view switches from "list and rank" to "query a page"
list by list, with the old path kept only until its list's backfill has run in production.

## §4 Costs and limits

- **Write amplification.** A rating rewrites 5–15 rows (its lists across windows and tags). At 100k
  ratings a month that is about 1.5M writes, a few dollars on demand.
- **Hot partitions.** `home` and `activity|…|all` take every write for their list. A DynamoDB partition
  sustains about 1,000 writes a second, far above any rating rate we will see. If it were ever reached,
  the list shards (`home#0`…`home#7`) and a page merges the shards' first pages.
- **Consistency.** Rows follow their inputs within a second or two (stream latency). A rating a person
  makes shows in their own card at once, as now; the list order catches up on the next load.
- **Rebuilds.** Changing the ranking math means rewriting every row: the backfill script, run once.

## §5 Verification

- `features/ranking/*.feature`: the Bayesian standing, window totals and widening, the Top and home
  orders, sort-key encoding (a key sorts where the rank says). Run against TypeScript (Lambda and web)
  and Rust (`apricity serve`).
- Lambda unit tests from stream records, as `functions/tally` and `functions/activity` have now.
- A parity test: a fixture library served locally and loaded into a sandbox backend returns the same
  first pages for every list.
- A load test in a sandbox (never production): a script writes 50k synthetic items and 500k ratings;
  every list's first page stays one query under 300 ms.

## §6 Open questions

1. **Home's window.** It uses the week, widening when quiet. With more activity, should it blend the
   week and all-time standings instead, so a classic doesn't disappear on a busy week?
2. **Guests and hidden items.** A guest never sees `…|curator` lists. Does a signed-in non-curator
   ever need to see their own undocumented upload in a list (flagged)? Probably yes, from "Mine".
3. **Deleting.** A deleted score must drop out of every list at once: the ranking Lambda deletes its
   rows on the Score stream's REMOVE, and the backfill tolerates orphans.
4. **Kinds and tags on clips and samples.** Tag leaderboards rank scores only; if clips get tags, their
   rows join the same `tag|…` lists.
