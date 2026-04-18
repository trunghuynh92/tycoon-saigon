# Tycoon Saigon

A Vietnamese-themed Monopoly variant built on top of IntrepidCoder's open-source JavaScript Monopoly engine. Board squares are re-skinned to Saigon districts and landmarks, and the game adds macroeconomic mechanics — **Mortgage Interest**, **Cost of Living**, a **Bubble + Crash** event system with three new card types (Snipe, Catastrophe, Property Tax Reassessment), **Fire-Sale Bankruptcy** with realistic liquidation auctions, and an optional **Claude AI** trade negotiator — that change long-game dynamics, break the classic Orange/Red standoff, and create comeback moments. Four AI personalities (Shark, Careful, Monopolist, Claude) play with emergent board evaluation.

Tycoon Saigon is a fork of [IntrepidCoder/monopoly](http://www.intrepidcoder.com/projects/monopoly/) and keeps that engine's vanilla JS + jQuery architecture. No build step — open `index.html` in a browser and play.

## Play online

**https://tycoon-saigon.vercel.app**

## Playing the game

Open the link above or `index.html` in any modern browser. On the setup screen, pick 2–8 players. For each slot you can choose:

- **Human** — you click the dice and buttons
- **AI (Test)** — the original baseline AI from the upstream project, kept for comparison
- **AI (Shark)** — aggressive leverager, buys on thin cushions, proposes cash trades early
- **AI (Careful)** — cash hoarder, rarely trades, camps in jail late-game
- **AI (Monopolist)** — targets the highest-scored group, pays premiums for completion trades
- **AI (Claude)** *(coming soon)* — uses the Claude API for trade negotiation; rule-based for all other decisions. Will be available as a premium feature.

When the game starts, all players roll dice to determine turn order — highest roll goes first. Human players click to roll; AI players roll automatically. Mortgage interest, Cost of Living, and the Bubble + Crash event system are all on by default.

## New mechanics

### Mortgage interest

Every property you mortgage accrues 10% interest on the outstanding debt per lap. Interest is charged when the player passes GO, after salary is collected. If interest pushes your cash below zero and you can't cover it by selling houses or mortgaging more, the engine foreclosure-sells assets in priority order until you are solvent or bankrupt.

The practical effect is that mortgaging is no longer a free panic button. Low-value mortgages used to fund higher-rent purchases are still profitable (the rent delta beats the interest), but stacking mortgages to stay in the game accelerates the death spiral.

### Cost of Living

On each pass-GO, after salary, each player pays `firstRollThisTurn × lapsCompleted`. The first roll of the turn is captured once per turn (doubles don't re-roll the COL number), and each player's lap counter advances independently.

This is the key standoff-breaker. In experienced play, four players who all know Orange and Red are the best groups tend to sit on the final piece forever rather than hand anyone the monopoly. Cost of Living makes stasis expensive — the longer the game drags, the more every pass-GO costs — so the player with the weakest cash position eventually has to deal.

Order of operations at pass-GO: salary → Cost of Living → mortgage interest → foreclosure if still negative.

### Jail interaction

Because each player's COL scales with their own lap count, camping in jail (skipping pass-GO for up to 3 turns) becomes slightly profitable very late. The 3-roll cap keeps it from becoming dominant. Careful AI exploits this; Shark and Monopolist generally pay bail to keep moving.

### Bubble + Crash

The game tracks total mortgage debt across all players. When system-wide debt crosses $1000, a Financial Crisis triggers: interest rates spike to 25% (2.5× normal) for one full round, and an emergency DSCR check fires on every leveraged player. Players whose debt-service coverage ratio falls below the crisis threshold get margin-called — the bank forecloses their cheapest mortgaged properties and sends them to auction.

This is the "bubble pop" mechanic. A dominant player who leveraged aggressively to build houses is suddenly paying 25% interest instead of 10%, and their weakest properties get repossessed. The crisis lasts one round and then subsides, with an 8-round cooldown before another can fire. Most games see 1-2 crises, which is enough for drama without feeling constant.

### Event cards

Three new card types replace some of the weaker original cards:

**Snipe Card** (Chance deck) — A holdable card, like Get Out of Jail Free. When you draw it, keep it in your hand. During foreclosure auctions, you can play the Snipe card to grab the property at face value, bypassing all bids. During fire-sale bankruptcy auctions, the snipe card is even more powerful: the holder gets **first pick** of all properties on the block before auctions begin, choosing any one at face value. This is the primary comeback mechanic — the leading player gets margin-called, their best properties hit the block, and you cherry-pick the one that completes your monopoly.

**Catastrophe** (Community Chest deck) — When drawn, ALL players immediately roll dice and pay 5× their roll. Average hit is $35 per player, which sounds mild, but it fires on everyone simultaneously and can cascade — a player already squeezed by COL and interest might get pushed into debt resolution by an extra $35, triggering a foreclosure that feeds someone's Snipe card.

**Property Tax Reassessment** (Chance deck) — The drawing player pays $40 per house and $115 per hotel they own. This specifically punishes the overbuilder — a player with 9 houses on Orange pays $360, which can be devastating if they're cash-tight from aggressive building.

### Fire-Sale Bankruptcy

Vanilla Monopoly's bankruptcy rule — the creditor inherits all properties — creates a snowball effect where the richest player absorbs the bankrupt player's empire and becomes unbeatable. Tycoon Saigon replaces this with a realistic liquidation flow:

1. **Sell buildings** — all houses and hotels are sold back at 50%, cash goes to the bankrupt player.
2. **Auction properties** — all properties go on the block, sorted most valuable first. Other players bid on them one by one, with the most desirable properties auctioned first. Proceeds go to the bankrupt player.
3. **Stop when solvent** — as soon as the bankrupt player has raised enough cash to cover their debt, auctions stop. They keep whatever properties haven't been auctioned yet.
4. **Settlement** — if the player can cover the debt, they pay the creditor and survive (potentially propertyless but still in the game). If not, the creditor receives whatever was raised and absorbs the loss; the player is eliminated.

The "stop when solvent" rule means the bankrupt player loses their best assets (since those are auctioned first and other players snatch them) but keeps the scraps. This creates a slow decline rather than instant death, and prevents any single player from inheriting a property empire. Snipe card holders get first pick before auctions begin.

### Claude AI Trade Negotiation *(coming soon)*

Players set to "AI (Claude)" use the Anthropic Claude API to evaluate incoming trade proposals. The AI receives full game state context — its cash, debt, DSCR, property holdings, monopoly progress, opponent positions, and crisis status — and returns a JSON decision (accept, reject, or counter-offer with reasoning). All other decisions (buying, building, mortgaging, jail) use the same rule-based logic as Monopolist. If the API call fails, a simple rule-based fallback handles the trade.

In production, API calls are routed through a server-side proxy (`/api/claude-trade`) so the API key is never exposed to the browser. The model used is `claude-sonnet-4-20250514` with a 512-token limit per trade evaluation.

### Trade abuse prevention

To prevent API cost abuse, the game enforces:
- **2 trade proposals per turn** per player
- **3-turn cooldown** after a trade is rejected by the same player
- **Duplicate trade detection** — resubmitting identical terms is blocked instantly

## AI personalities

All three new AIs share the same group-scoring machinery. Each group on the board gets scored every decision using landing frequency (Monopoly's classic Markov chain peaks post-jail, so Orange is highest at ~13%), number of active opponents, current ownership fraction, a contest penalty for how crowded the group is, and a cost penalty that discourages dumping cash into Dark Blue when Orange is still open. The three personalities differ in how aggressively they act on those scores.

**Shark** buys on a $20 cushion, leverages into houses on any monopoly, unmortgages as soon as it has more than $800 in cash, and proposes cash trades up to 1.5× face value when it's one piece away from a monopoly. Accepts any completion trade and any net-positive trade, and late in the game will accept slightly losing trades to keep moves flowing.

**Careful** is the cash hoarder. Only buys when it can keep $400 in reserve, builds houses only when it has 5× the house price banked, never proposes trades, refuses any trade that gives up a monopoly or a developed square, and prefers jail to the open board late-game. By design, Careful is expected to win around 20% of games — its archetype is "don't lose" rather than "win", and attempts to fix its win rate should be resisted.

**Monopolist** plays the emergent scoring straight. It ranks every group, buys aggressively inside its top-scored group (including defensive buys to deny opponents), proposes trades for its highest-ranked one-away group at up to 1.75× face value, and camps in jail only after lap 28. It is the personality most likely to break the Orange/Red standoff.

**Claude** *(coming soon)* delegates trade decisions to the Claude API, which receives serialized game state and returns reasoned accept/reject/counter decisions. Buying, building, and other decisions use the same logic as Monopolist. Claude's trade evaluation considers factors the rule-based AIs cannot — like reading bluff potential, assessing multi-step trade sequences, and weighing risk in the context of upcoming crisis probability.

## Simulator

`sim/tycoon-sim.js` is a headless Node simulator that runs thousands of games to validate mechanics and AI balance. It implements the same mortgage interest, Cost of Living, fire-sale bankruptcy, Bubble + Crash, and DSCR margin call systems as the playable game. The simulator includes the "stop when solvent" fire-sale rule and snipe cherry-pick mechanic.

Run from the project root:

    node sim/tycoon-sim.js

Useful flags:

    node sim/tycoon-sim.js --no-cost-of-living    # disable COL for comparison sweeps
    node sim/tycoon-sim.js --no-events            # disable Bubble/Crash + event cards
    node sim/tycoon-sim.js --bubble-threshold 1000 # system debt that triggers a crisis
    node sim/tycoon-sim.js --crisis-mult 2.5      # interest multiplier during crisis
    node sim/tycoon-sim.js --catastrophe-mult 5   # catastrophe card: N× dice roll
    node sim/tycoon-sim.js --tax-per-house 40     # property tax per house
    node sim/tycoon-sim.js --games 1000           # number of games to simulate

The output includes per-strategy win rates, margin call activity, event card impact (average catastrophe/property tax paid, snipe cards used), and financial crisis frequency.

### Timeline Chart

`sim/gen-timeline.js` runs a single sim game and generates an HTML page with interactive Chart.js line charts showing per-round Net Worth, Cash, Debt, Buildings, and Properties for each player, with vertical annotation lines marking Catastrophe, Property Tax, Financial Crisis, and Fire Sale events.

    node sim/gen-timeline.js                    # default seed 42
    node sim/gen-timeline.js --seed 314         # specific seed
    node sim/gen-timeline.js --max-rounds 200   # cap rounds

Output is written to `sim-timeline.html` in the project root. Open it in a browser to inspect game dynamics visually.

### Balance (1000-game sample, 3 players)

| Strategy   | Win Rate | First Eliminated | Avg Survival |
|------------|----------|------------------|--------------|
| Shark      | 25.1%    | 53.5%            | 117 rounds   |
| Careful    | 36.5%    | 18.1%            | 124 rounds   |
| Monopolist | 38.4%    | 23.9%            | 121 rounds   |

Careful's higher win rate reflects its survivability in the no-trade sim environment. In real games with human trading, Monopolist and Shark can negotiate group completions, which would pull Careful's rate closer to its design target of ~20%.

## Project layout

    index.html              game entry point + setup UI
    monopoly.js             core game engine (turns, trades, fire-sale bankruptcy, auctions)
    ai.js                   AI personalities (Test, Shark, Careful, Monopolist, Claude)
    lang.js                 i18n (Vietnamese / English)
    saigonedition.js        Saigon-themed board, property names, prices, groups
    classicedition.js       original US board (for reference / fallback)
    newyorkcityedition.js   NYC board variant from upstream
    api/claude-trade.js     Vercel Function — server-side Claude API proxy
    apikey.local.js         local-only API key (gitignored)
    images/                 board and piece art
    styles.css              board and UI styling
    sim/tycoon-sim.js       headless Node simulator (fire-sale, DSCR, COL, events)
    sim/gen-timeline.js     single-game timeline chart generator (Chart.js)
    sim/test-balance.js     1000-game win rate / balance check
    sim-timeline.html       generated timeline chart (open in browser)
    CLAUDE.md               guidance for Claude Code
    LICENSE                 upstream license

## Credits

Original Monopoly engine by IntrepidCoder ([source](http://www.intrepidcoder.com/projects/monopoly/)). Saigon theming, mortgage interest, Cost of Living, fire-sale bankruptcy, Claude AI integration, and the Shark/Careful/Monopolist AI personalities are additions in this fork. Monopoly is a trademark of Hasbro; this project is a non-commercial educational fork.
