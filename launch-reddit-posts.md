# Tycoon Saigon — Reddit Launch Posts

---

## Post 1: r/boardgames

**Title:** Monopoly games take 3 hours and the winner is obvious after 30 minutes — I added financial crises, fire-sale bankruptcy, and a holdable Tax Audit card to fix that

**Body:**

You know the feeling. Forty-five minutes in, someone has a monopoly with hotels, and the next two hours are just everyone slowly bleeding out. The game's too long, the leader snowballs, and if you go bankrupt early you sit there watching. Monopoly has a 4.4 on BoardGameGeek for a reason.

I spent the last few months building **Tycoon Saigon** — a free, browser-based Monopoly variant that adds real economic mechanics to fix exactly those problems. Games are shorter, leads are contestable, and bankruptcy doesn't just hand the winner more stuff.

You can play it right now: **https://tycoon-saigon.vercel.app**

Here's what's different:

**Cost of Living breaks the standoff.** Every time you pass GO, you pay a cost that scales with how many laps you've completed. Early game it's nothing. By lap 15 it's eating into your salary. This is the big one — in experienced play, nobody wants to trade the final piece that gives someone a monopoly, so the mid-game stalls out. Cost of Living makes stasis expensive. The player with the weakest cash position eventually *has* to deal.

**Mortgage interest makes debt dangerous.** Mortgaged properties accrue 10% interest per lap, charged at pass-GO. Mortgaging is no longer a free panic button — stacking mortgages to stay alive accelerates the death spiral instead of delaying it.

**Bubble + Crash punishes overleveraging.** The game tracks total mortgage debt across all players. When it crosses $1000, a Financial Crisis triggers — interest rates spike to 25% for one round, and overleveraged players get margin-called. Their weakest properties get repossessed and sent to auction. Most games see 1-2 crises, which is enough for drama without feeling random.

**Fire-Sale Bankruptcy prevents snowballing.** When a player goes bankrupt, instead of the creditor inheriting everything (the classic snowball), properties are auctioned off most-valuable-first to ALL players. Crucially, auctions stop as soon as the bankrupt player raises enough to cover their debt — so they lose their best assets but keep the scraps. No more "one player absorbs an empire and becomes unbeatable."

**Tax Audit Card targets the runaway leader.** A holdable card from the Chance deck. When you draw it, keep it in your hand. On any future turn, you can play it to trigger a city-wide property tax audit — ALL players pay $40 per house and $115 per hotel. The skill is in the timing: hold it until the leader has built up heavily and you haven't, then drop it. Even before you play it, the *threat* of the card discourages reckless building. I ran 1000-game simulations — the leader pays ~$170 in property tax per game while the trailing players pay ~$5. It self-targets.

**Snipe Card is the comeback mechanic.** Another holdable card. When someone's properties hit the auction block (from fire-sale or margin call), you can play it to grab any one property at face value, skipping the bidding. The leading player gets margin-called, their best stuff hits the block, and you cherry-pick the piece that completes your monopoly.

**Casino replaces Free Parking.** Instead of the broken "collect tax money" house rule, landing on the center square lets you pick a bet tier and roll doubles to win — from $10 for $50 (any double) up to $60 for $1000 (double 6 only). Opt-in risk/reward instead of free money injection that inflates the game.

The board is themed around Saigon (Ho Chi Minh City) districts — District 1, Thao Dien, Thu Thiem, Tan Son Nhat Airport — with bilingual English/Vietnamese support. But the mechanics work regardless of theming.

There are three AI opponents with distinct personalities: Shark (aggressive leverager), Careful (cash hoarder, camps in jail late-game), and Monopolist (targets the highest-value group and pays premiums to complete it). I ran 1000-game balance sweeps — Shark wins 20%, Careful 47%, Monopolist 33% in the no-trade sim. Careful's high rate reflects survivability; in real games with trading, Monopolist and Shark pull ahead.

Your game auto-saves every turn, so you can close the browser and resume later.

It's free, runs in any browser, no install needed. The two things I'm most curious about: does Cost of Living fix the "nobody trades" stalemate without feeling too punishing? And does the Tax Audit card create interesting decisions, or does it feel like random punishment? Would love your take.

---

## Post 2: r/gamedev

**Title:** I built a Monopoly variant with economic crisis mechanics and validated it with a 1000-game headless simulator — here's what the data showed

**Body:**

I've been working on **Tycoon Saigon**, a browser-based Monopoly variant that adds macroeconomic mechanics — mortgage interest, cost of living that scales per lap, a bubble/crash system that margin-calls overleveraged players, fire-sale bankruptcy, and holdable event cards (Snipe and Tax Audit) that create strategic catch-up moments.

Playable here: **https://tycoon-saigon.vercel.app**

I wanted to share the technical side, because the most interesting part wasn't building the game — it was figuring out how to validate that the mechanics actually work.

**The balance problem.** I added three AI personalities: Shark (aggressive, leverages hard, trades early), Careful (hoards cash, never trades, camps in jail), and Monopolist (targets highest-scored color group, pays premiums for completion trades). They all share the same group-scoring engine — each color group gets ranked every decision based on landing frequency, ownership fraction, competition, and cost — but they act on those scores with different aggression levels.

The question was: do the new mechanics actually change outcomes? And specifically: if one player gets a monopoly early (the "runaway leader" problem), can they be stopped?

**The simulator.** I wrote a headless Node.js re-implementation of the full game — same mortgage interest, same cost of living formula, same bubble/crash triggers, same fire-sale auction logic, same Tax Audit card. It loads the real board data from the game files so nothing drifts. Then I ran 1000 games with fixed seeds.

**Key findings:**

*Standard 3-player games (Shark/Careful/Monopolist):*
- Average game length: 119 rounds (vs 200+ in vanilla Monopoly)
- Financial crises: 1.4 per game
- Tax Audit hits the leader for ~$170 avg, trailing players for ~$5
- Shark wins 20%, Careful 47%, Monopolist 33%

*Worst case — 4 Monopolists, one handed the Orange group for free at turn 0:*
- Orange holder wins 93.9% — still dominant
- BUT: without the mechanics (no COL, no crisis, no Tax Audit), Orange wins ~98%+
- The mechanics are helping, they're just not enough to overcome a free monopoly
- In real games, monopolies cost a trade (you give up something), so this scenario is rarer

**Cost of Living is the standoff-breaker.** Without it, games stall because no rational player trades the final piece of a monopoly. With it, the player with the weakest cash position gets squeezed every pass-GO until they're forced to deal.

**The Tax Audit card creates a threat ecosystem.** Even when it's not played, the leader has to consider: "someone might be holding a Tax Audit — should I build 4 houses or wait?" The card adds a skill dimension (timing) rather than just another random event. AI plays it when opponents have 3+ more building units, which naturally self-targets the leader.

**The architecture is deliberately simple.** Vanilla JavaScript, jQuery 1.11, no build step, no framework. The tradeoff is that the browser game and the simulator are two parallel implementations of the same rules — when I change a mechanic, I change it in both places. The simulator catches drift.

**What I'd do differently:** Start with the simulator. Building the playable game first meant I was tuning by feel instead of data. Once I had the sim, I could see that the crisis multiplier at 2.5x created the right margin call frequency, and that the Tax Audit card was hitting the leader 30x harder than trailing players.

Source is on GitHub: https://github.com/trunghuynh92/tycoon-saigon

---

## Post 3: r/webdev

**Title:** I built a full board game in vanilla JS + jQuery — no React, no build step, just one big .js file and vibes

**Body:**

I've been working on **Tycoon Saigon**, a Monopoly variant with economic mechanics like mortgage interest, financial crises, holdable event cards, and AI opponents. It started as a fork of an open-source vanilla JS Monopoly engine and I kept the architecture: jQuery 1.11, module-level globals, no bundler, no TypeScript.

Play it here: **https://tycoon-saigon.vercel.app**

The entire game engine is one ~165KB JavaScript file. The AI logic is another file. Board data is a third. `index.html` loads them in order and they communicate through globals. It's the kind of architecture that makes modern devs wince, but for a single-page board game with no routing and no server state — it works fine.

Some things I noticed building this way:

**No build step is genuinely freeing.** Edit a file, refresh the browser. No waiting for webpack, no HMR glitches, no "why is my change not showing up" debugging. For a game where you're tweaking a constant and immediately watching how it plays, the instant feedback loop matters a lot.

**jQuery is still fine for DOM-heavy games.** The board is a table. Tokens move between cells. Popups appear and disappear. Cards flip. That's 90% of the UI. jQuery's `.show()`, `.hide()`, event delegation — it does exactly what I need without ceremony.

**Deployment is trivial.** Static files on Vercel, one serverless function for an API proxy (for an upcoming Claude AI trade negotiator feature). `vercel deploy --prod` and done. No build pipeline to debug.

**localStorage for save/resume.** Game auto-saves every turn. Close the browser, come back, click "Resume." No database, no auth. ~200 lines of serialize/deserialize code covering all game state. Simple and it just works.

**The one real downside: parallel implementations.** I also wrote a headless Node.js simulator to balance-test the AI (1000-game sweeps to validate win rates). Because there are no modules, the simulator is a separate re-implementation of the same rules. When I change a mechanic, I change it in both places. A module system would let them share code — that's the one thing I'd change.

**i18n without a framework.** The game supports English and Vietnamese. I wrote a 50-line `t(key, params)` function that does string interpolation from a flat dictionary, plus `updateStaticText()` that walks `[data-i18n]` DOM nodes on language toggle. No i18n library needed.

The game has some fun mechanics — cost of living that scales per lap, a bubble/crash system that margin-calls players, fire-sale bankruptcy auctions, holdable cards (Snipe and Tax Audit), a casino that replaces Free Parking, and three AI personalities validated with simulation runs.

Free, no login, works in any browser. Source on GitHub: https://github.com/trunghuynh92/tycoon-saigon

Curious if anyone else is building games with this kind of zero-tooling approach, or if I'm the last holdout.
