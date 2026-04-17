# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There is **no build step** and no `package.json`. Everything runs from source.

**Play the game in a browser:**

    npx serve -l 3456     # the dev server configured in .claude/launch.json
    # …then open http://localhost:3456

Opening `index.html` directly with `file://` also works, but the Claude AI trade feature requires the page to be loaded over `http(s)://` (the Anthropic API rejects `file://` origins).

**Syntax-check a script after editing** (no test runner exists for the browser code):

    node -c monopoly.js
    node -c ai.js
    node -c saigonedition.js
    node -c lang.js

**Headless simulator** (validates mechanics, AI balance, event impact):

    node sim/tycoon-sim.js                          # default: 500 games, 3 AIs
    node sim/tycoon-sim.js --games 1000
    node sim/tycoon-sim.js --no-cost-of-living      # disable COL
    node sim/tycoon-sim.js --no-events              # disable Bubble/Crash + event cards
    node sim/tycoon-sim.js --no-margin-call         # disable DSCR margin calls
    node sim/tycoon-sim.js --bubble-threshold 1500  # system-debt trigger
    node sim/tycoon-sim.js --crisis-mult 2.5        # interest mult during crisis
    node sim/tycoon-sim.js --interest 0.10          # base mortgage interest rate
    node sim/tycoon-sim.js --four-mono              # 4× Monopolist matchup
    node sim/tycoon-sim.js --passive                # add a Passive opponent
    node sim/tycoon-sim.js -h                       # full flag list

**1000-game balance check** (fixed seeds 1..1000, win/elim/survival rates):

    node sim/test-balance.js

**Generate a single-game timeline chart** (writes `sim-timeline.html` at repo root, open in browser):

    node sim/gen-timeline.js                  # seed 42
    node sim/gen-timeline.js --seed 314 --max-rounds 200

## Architecture

Tycoon Saigon is a fork of IntrepidCoder's vanilla-JS Monopoly. The browser game uses jQuery 1.11 and module-level globals — there is no bundler, no modules, no TypeScript. There are **two parallel implementations of the same rules** that must be kept in sync:

1. The browser game (`monopoly.js` + `ai.js`) — runs the playable UI.
2. The headless simulator (`sim/tycoon-sim.js`) — a pure-Node re-implementation for AI balance testing.

When you change a rule, change it in **both places** or the sim's win-rate numbers will diverge from real play.

### Browser code load order

`index.html` loads scripts in this order — the order matters because each later script depends on globals defined by the earlier ones:

    jquery → lang.js → <edition>.js → ai.js → monopoly.js

Swap the active board by editing the `<edition>.js` script tag in `index.html`:
- `saigonedition.js` (default) — Saigon-themed board
- `classicedition.js` — original US board
- `newyorkcityedition.js` — NYC variant from upstream

Each edition file defines `Square()` / `Card()` constructors and the 40-square `square[]` array plus the Chance / Community Chest decks.

### `monopoly.js` — game engine

Single ~160 KB file. The top of the file is the **balance constants block** (`INTEREST_RATE`, `GO_SALARY`, `BUBBLE_THRESHOLD`, `CRISIS_INTEREST_MULT`, `CATASTROPHE_MULT`, `TAX_PER_HOUSE`, `DSCR_FLOOR`, `DSCR_BORROW`, `CASINO_TIERS`, etc.) — tune mechanics here. The simulator has its own copy of these same constants near the top of `sim/tycoon-sim.js`; **update both when tuning**.

Core flows added on top of the upstream engine:

- **Mortgage interest** — accrues per lap, charged at pass-GO.
- **Cost of Living** — `firstRollThisTurn × lapsCompleted`, charged at pass-GO.
- **Pass-GO order of operations** — salary → COL → mortgage interest → foreclosure if still negative. Don't reorder these without understanding the death-spiral interactions.
- **Bubble + Crash** — tracks system-wide mortgage debt; when it crosses `BUBBLE_THRESHOLD` and the cooldown (8 rounds) has elapsed, sets `crisisActive = true` for one round, multiplying interest by `CRISIS_INTEREST_MULT` and triggering DSCR margin calls.
- **Fire-Sale Bankruptcy** — replaces vanilla "creditor inherits all". Sells houses at 50%, auctions properties most-valuable-first, **stops as soon as the bankrupt player is solvent** (this rule is load-bearing for game balance — keep it).
- **Snipe card** — held in hand like Get Out of Jail Free; in fire-sale, holder gets first pick at face value before auctions begin.
- **Casino** — replaces Free Parking at square 20; tiered double-or-nothing bets, see `CASINO_TIERS`.
- **Game log** — `gameLog`, `turnCounter`, `originalPlayers`, `eliminatedPlayers` capture per-turn snapshots for post-game review.

### `ai.js` — AI personalities

Five constructors: `AITest`, `AIShark`, `AICareful`, `AIMonopolist`, `AIClaude`. Each takes a player object `p` and attaches decision methods (`buyProperty`, `acceptTrade`, `proposeTrade`, etc.) that the engine calls. Each has a static `count` for naming.

The three new personalities (Shark / Careful / Monopolist) all use the shared `aiScoreGroup` / `aiRankGroups` / `aiBestProgressGroup` / `aiFindMissingPieceOwner` machinery — they differ only in **how aggressively** they act on the same group scores. Don't duplicate scoring logic into a personality; extend the shared helpers.

`AIClaude` delegates **only trade decisions** to the Anthropic API (model `claude-sonnet-4-20250514`, 512-token cap, `anthropic-dangerous-direct-browser-access` header). All other decisions reuse Monopolist logic. There is a rule-based fallback for API failures.

`AICareful`'s ~20% win rate is **intentional** — its archetype is "don't lose", not "win". Resist tuning it upward; it's the control case for the COL standoff-breaker hypothesis.

### `lang.js` — i18n

Vietnamese (default) and English. `t(key, params)` returns a translated string with `{name}`-style interpolation; `updateStaticText()` walks `[data-i18n]` DOM nodes. When adding a new piece of UI text, add the key to **both** `LANG.vi` and `LANG.en` and reference it via `t(...)` rather than hardcoding strings.

### `sim/` — headless simulator

`tycoon-sim.js` is an independent re-implementation, not a wrapper around the browser engine. It loads the real `saigonedition.js` `square[]` (via `loadSquares()`) so property names/prices/rents stay in sync, but cards, AI, and game flow are reimplemented. It exports `{ loadSquares, playGame, strategies, makeRng, configure }` — `gen-timeline.js` and `test-balance.js` consume these.

Module-level config (`EVENTS_ENABLED`, `INTEREST_RATE`, etc.) is `let`-scoped and only mutable via the CLI flag parser in `main()` or the exported `configure()` function. External scripts that want to override defaults must call `configure({...})` before `playGame()`.

When adding a new sim flag, parse it in `main()` AND surface it through `configure()` so timeline / balance scripts can use it.

### `base/`

The README lists `base/` as "base rules and shared constants", but on disk it currently contains only a vestigial `.git` directory. Treat it as empty — nothing in the running game or simulator imports from it.
