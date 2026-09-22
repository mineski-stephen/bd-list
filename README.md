# BD List

A single static page that renders the BD team's live Google Sheet as a dashboard:
per-BD status cards on top, a per-month stacked bar chart underneath.

No build step, no npm, no CDN — five files and a browser.

---

## Running it

Google blocks the data request when the page is opened straight from disk, so it
has to be served over http. Double-click **`serve.cmd`**, or from a terminal in this
folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

> **Why can't I just double-click `index.html`?**
> The published-sheet URL 307-redirects to `googleusercontent.com`. With an `http://`
> origin both hops return the `Access-Control-Allow-Origin` header the browser needs;
> with a `file://` page the origin is `null` and the redirect hop returns no such
> header, so the fetch dies before the data arrives. Opening the file directly still
> renders the bundled snapshot (see below) and tells you how to fix it — it just
> can't reach live data.

---

## What it shows

### Per-BD sections

One section per BD, ordered by total pipeline value, with **Unassigned** always last
(rows whose `BD` column is blank).

Each section shows a card for **all nine statuses**, always in the same order. A
status with no projects still gets a card — greyed out, showing `—`. That is
deliberate: an empty *Won* card is information.

Cards are **expanded by default**, except **6. Deferred/Cancelled** and **Lost**,
which start collapsed — they are the closed-out buckets, bulky and rarely what you
came to read. Click a header to open or close it, or use the **Collapse all /
Expand all** button in the top bar; expanding from there opens *every* card,
including those two. Inside, projects are sorted
by **amount, descending**; rows with no amount show `—` and sort last.

Each row shows **Client · Project Name · Amount**. Long names are trimmed with an
ellipsis; **hover the row and any trimmed text slides sideways** far enough to show
the rest, pauses, and eases back. Only the cells that actually overrun move — the
distance and the duration are measured per cell, so everything travels at the same
reading pace. Honoured for keyboard focus too, and skipped entirely under
`prefers-reduced-motion`.

### Remarks tooltip

Hovering a list item shows a balloon that follows the cursor, containing that row's
**Remarks**. Rows *without* a remark show **no balloon at all** — so the ones that do
have something to say are marked with a dotted underline under the client name and a
`help` cursor.

Chart segments get a tooltip too, but theirs always appears and identifies the
project (client, name, status, amount) — a bare coloured rectangle in a stack is
otherwise unreadable.

### Per-month chart

Bars are **Projected Month**, in calendar order. Each stack segment is **one project**,
coloured by status, largest at the bottom, so bar height is the month's total.

- **Lost** is drawn **below the zero line** as a negative value.
- **Deferred/Cancelled** is **excluded** entirely.
- Projects with **no projected month** are not charted (they still appear in their
  BD cards).
- A month whose projects are *all* excluded **keeps its slot and renders empty**,
  because a month going to zero is worth seeing. December does exactly this today:
  its single project is Deferred/Cancelled.

Positive and negative share one scale, so the two halves are directly comparable.
When there are no Lost projects the zero line simply sits at the bottom and it looks
like an ordinary column chart.

---

## Status colours

Sampled from the status chips in the sheet itself, so the dashboard matches what
people already see there.

| Status | Fill | Text |
|---|---|---|
| 1. Prospect Identified | `#C6DBE1` | `#134F5C` |
| 2. Outreach Started | `#E6CFF2` | `#53338A` |
| 3. Discovery Meeting | `#5A3286` | `#FFFFFF` |
| 4. Active follow-up | `#FFC8AA` | `#7A3F0C` |
| 5. Proposal/Credentials Sent | `#0A53A8` | `#FFFFFF` |
| 6. Deferred/Cancelled | `#E6E6E6` | `#4A4A4A` |
| 7. RFP/RFQ Provided | `#BFE1F6` | `#0A4A96` |
| Won | `#11734B` | `#FFFFFF` |
| Lost | `#B10202` | `#FFFFFF` |

They are defined **once**, as custom properties at the top of `styles.css`, and read
from there by the card swatches, the legend and the SVG segments alike. Change a hex
there and everything follows.

Cards appear in the sheet's own numbered order, with `Won` and `Lost` last.

---

## Live data and the Refresh button

The page fetches the sheet on load and stamps the time in the top bar. **Refresh**
re-fetches on demand — no page reload, no cache.

If the live fetch fails, the page falls back to `snapshot.js` (a copy of the data
bundled at build time), renders it in full, and shows an amber banner saying so. It
never shows a blank page. If a *refresh* fails after a good load, the previous data
stays on screen and the banner reports the failure.

### Regenerating the snapshot

```bash
python -c "import json,datetime,urllib.request as u; \
url='https://docs.google.com/spreadsheets/d/e/2PACX-1vQJrkTQFOO7VryCuwJRNX6wcBWvsDfG0r_goHm0QTNzIxY6q8RdNx4H_ttx0lBAzXcJS7elgOGuek1K/pub?gid=0&single=true&output=csv'; \
c=u.urlopen(url,timeout=30).read().decode('utf-8-sig'); \
open('snapshot.js','w',encoding='utf-8',newline='\n').write('// Bundled fallback copy of the sheet. Regenerate with the command in README.md.\nwindow.BD_SNAPSHOT_DATE = %s;\nwindow.BD_SNAPSHOT_CSV  = %s;\n' % (json.dumps(datetime.date.today().isoformat()), json.dumps(c)))"
```

It is loaded with a plain `<script>` tag rather than `fetch()` on purpose: classic
scripts work under `file://` while fetching a local file does not, so the fallback
also rescues the double-click case.

---

## Files

| File | |
|---|---|
| `index.html` | Page skeleton and mount points |
| `styles.css` | Status colour tokens, layout, cards, tooltip |
| `app.js` | Fetch → parse → normalise → group → render → chart → tooltip |
| `snapshot.js` | Bundled fallback copy of the data |
| `serve.cmd` | Starts the local server and opens the browser |

---

## Configuration

Everything tweakable sits in one block at the top of `app.js`:

| Constant | |
|---|---|
| `CSV_URL` | The published sheet. Swap this to point at a different tracker. |
| `CURRENCY_PREFIX` | `''` by default. Set to `'₱'` to prefix every amount. |
| `SHOW_UNSCHEDULED_BAR` | `false`. Set `true` to add a "No Month" bar for undated projects. |
| `CHART_EXCLUDE` | Statuses kept out of the chart. Currently `deferred`. |
| `NEGATIVE_STATUSES` | Statuses drawn below the zero line. Currently `lost`. |
| `COLLAPSED_BY_DEFAULT` | Statuses whose cards start closed. Currently `deferred` and `lost`. |
| `DEFAULT_YEAR` | Year assumed for month cells that have none — only used once the sheet starts carrying years. |
| `DEBUG_FORCE_LOST` | Set to a client name to force its rows to `Lost`. Handy for checking the negative axis while the sheet has no Lost projects. |

---

## How the sheet is read

Columns are matched **by name**, not position, so reordering columns in the sheet
changes nothing. `BD, AM, Client, Project Name, Type, Status, Amount,
First Contact Date, Win/Lost Date, Projected Month, Remarks`.

**Amounts** are parsed from quoted, comma-formatted text (`"3,815,330.00"`);
parentheses mean negative; blank stays blank rather than becoming zero, so a missing
amount never quietly counts as `0`.

**Statuses** carry a numbered prefix in the sheet (`1. Prospect Identified`). That
prefix is **stripped before matching**, so renumbering the list, or dropping the
numbers entirely, needs no code change. Matching is case-insensitive and tolerates
spacing variants (`Deferred / Cancelled`, `Active Follow Up`). An unrecognised status
is not dropped — it lands in an extra "Other" card and logs a console warning, which
is what you'll see if a row still holds one of the retired statuses (`CE Submitted`,
`For Submission`, `Projection`, `Exploratory`). They are deliberately **not** aliased
onto the new ones, since no mapping between them is unambiguous.

**Projected Month** is **year-aware**. Today the sheet holds bare abbreviations
(`Sep`), so months sort Jan→Dec. If the column ever starts carrying years, the
dashboard adapts on its own: `Sep 2026`, `Sept '26`, `Feb-27`, `2027-03` and `5/2027`
all parse, sorting switches to year-then-month so `Jan 2027` lands after `Dec 2026`,
and labels pick up the year once the data spans more than one. No code change needed.

---

## Notes

- Values from the sheet are inserted as text, never as HTML, so a stray `<` or a
  pasted tag in a project name can't break or inject into the page.
- Rows are keyed by their position in the CSV, not by client or project name —
  several clients (BingoPlus, FUNaloMAX) legitimately appear more than once.
- The chart re-lays itself on window resize and scrolls horizontally rather than
  squashing when there are many months.
- Hover-to-read measures overflow at hover time, not at render time, so it stays
  correct after the window is resized or a card is collapsed and reopened.
