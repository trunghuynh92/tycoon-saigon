#!/usr/bin/env node
/**
 * Tycoon Saigon — Headless Simulator
 *
 * Runs many games with 3 player strategies and reports aggregate stats
 * so we can see whether the 10% mortgage-interest mechanic actually
 * punishes over-leveraged play.
 *
 * Usage:
 *   node sim/tycoon-sim.js [--games 500] [--max-rounds 200] [--seed 12345] [--verbose]
 *
 * The engine is an independent pure-JS re-implementation of the rules
 * in monopoly.js. It loads the real saigonedition.js squares so property
 * names, prices, and rents exactly match the game. Card effects are
 * reimplemented as data (the spec says Saigon cards have identical
 * mechanical effects to the classic set, only flavor text changes).
 *
 * Intentionally out of scope for v1:
 *   - Player-to-player trading (real trade AI is a huge problem)
 *   - Incremental auctions (simplified to sealed-bid)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// =============================================================
// 1. Seedable RNG (Mulberry32)
// =============================================================
function makeRng(seed) {
	let s = (seed >>> 0) || 1;
	return function rng() {
		s = (s + 0x6D2B79F5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const randInt = (rng, lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;
const rollDie = rng => randInt(rng, 1, 6);
function shuffle(arr, rng) {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
	}
	return a;
}

// =============================================================
// 2. Load Saigon Edition squares (reuse real data)
// =============================================================
function loadSquares() {
	const src = fs.readFileSync(path.join(__dirname, '..', 'saigonedition.js'), 'utf8');
	// Stub every DOM / card-callback reference so the file loads cleanly.
	// Load lang.js for t() function
	const langSrc = fs.readFileSync(path.join(__dirname, '..', 'lang.js'), 'utf8');
	const fn = new Function(`
		const document = { getElementById: () => ({ innerHTML: '', textContent: '' }), querySelectorAll: () => [] };
		const $ = () => ({ show: () => ({ text: () => {} }) });
		const addAlert = () => {}, updateOwned = () => {};
		const player = [], turn = 0;
		const addamount = () => {}, subtractamount = () => {};
		const collectfromeachplayer = () => {}, payeachplayer = () => {};
		const advance = () => {}, advanceToNearestUtility = () => {}, advanceToNearestRailroad = () => {};
		const gobackthreespaces = () => {}, gotojail = () => {}, streetrepairs = () => {};
		const drawSnipeCard = () => {}, catastrophe = () => {}, propertyTaxReassessment = () => {};
		${langSrc}
		${src}
		return square;
	`);
	const arr = fn();
	return arr.map((sq, i) => ({
		index: i,
		name: sq.name || '',
		price: sq.price || 0,
		groupNumber: sq.groupNumber || 0,
		baserent: sq.baserent || 0,
		rent1: sq.rent1 || 0,
		rent2: sq.rent2 || 0,
		rent3: sq.rent3 || 0,
		rent4: sq.rent4 || 0,
		rent5: sq.rent5 || 0,
		houseprice: sq.houseprice || 0,
		owner: 0,
		mortgage: false,
		house: 0,
		hotel: 0,
	}));
}

// =============================================================
// 3. Card effect tables (classic set — Saigon flavor same mechanics)
// =============================================================
const COMMUNITY_CHEST = [
	{ type: 'jailCard' },                                  // 0
	{ type: 'collect', amount: 10 },                        // 1
	{ type: 'collect', amount: 50 },                        // 2
	{ type: 'collect', amount: 100 },                       // 3
	{ type: 'collect', amount: 20 },                        // 4
	{ type: 'collect', amount: 100 },                       // 5
	{ type: 'collect', amount: 100 },                       // 6
	{ type: 'collect', amount: 25 },                        // 7
	{ type: 'pay', amount: 100 },                           // 8
	{ type: 'collect', amount: 200 },                       // 9
	{ type: 'pay', amount: 50 },                            // 10
	{ type: 'pay', amount: 50 },                            // 11
	{ type: 'collectFromEach', amount: 10 },                // 12
	{ type: 'advance', to: 0 },                             // 13
	{ type: 'catastrophe' },                                // 14 — replaces streetRepairs
	{ type: 'goToJail' },                                   // 15
];

const CHANCE = [
	{ type: 'jailCard' },                                   // 0
	{ type: 'snipeCard' },                                  // 1 — replaces streetRepairs
	{ type: 'pay', amount: 15 },                            // 2
	{ type: 'payEach', amount: 50 },                        // 3
	{ type: 'back3' },                                      // 4
	{ type: 'nearestUtility' },                             // 5
	{ type: 'collect', amount: 50 },                        // 6
	{ type: 'nearestRailroad' },                            // 7
	{ type: 'taxAuditCard' },                               // 8 — holdable Tax Audit
	{ type: 'advance', to: 5 },                             // 9
	{ type: 'advance', to: 39 },                            // 10
	{ type: 'advance', to: 24 },                            // 11
	{ type: 'collect', amount: 150 },                       // 12
	{ type: 'nearestRailroad' },                            // 13
	{ type: 'advance', to: 11 },                            // 14
	{ type: 'goToJail' },                                   // 15
];

// =============================================================
// 4. Game constants (must match monopoly.js tuning knobs)
// =============================================================
let INTEREST_RATE = 0.10;    // mutable via --interest flag for sweeps
let DSCR_FLOOR = 1.0;        // mutable via --dscr-floor; margin call fires below this
let DSCR_BORROW = 2.0;       // mutable via --dscr-borrow; bank rejects new mortgages below this
let MARGIN_CALL_ENABLED = true;  // --no-margin-call disables the whole system
let LEVERAGE_ENABLED = true;     // --no-leverage disables voluntary leveraged buying
let COST_OF_LIVING_ENABLED = true; // --no-cost-of-living disables the inflation mechanic
let EVENTS_ENABLED = true;           // --no-events disables Bubble/Crash + event cards
let BUBBLE_THRESHOLD = 1000;         // total system mortgage debt that triggers a crisis
let CRISIS_INTEREST_MULT = 2.5;      // interest multiplier during a crisis lap
let CATASTROPHE_MULT = 5;            // catastrophe card: pay this × dice roll
let TAX_PER_HOUSE = 40;              // property tax reassessment: per house
let TAX_PER_HOTEL = 115;             // property tax reassessment: per hotel
const GO_SALARY = 200;
const MORTGAGE_VALUE = 0.50;
const UNMORTGAGE_COST = 0.55;
const STARTING_CASH = 1500;
const JAIL_POSITION = 10;
const GOTO_JAIL_POSITION = 30;
const INCOME_TAX_POSITION = 4;
const LUXURY_TAX_POSITION = 38;
const INCOME_TAX_AMOUNT = 200;
const LUXURY_TAX_AMOUNT = 100;
const JAIL_BAIL = 50;
const GROUP_SIZE = { 1: 4, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 2 };
const CASINO_POSITION = 20;
let CASINO_ENABLED_SIM = true;
const CASINO_TIERS_SIM = [
	{ bet: 10,  minDouble: 1, payout: 50 },
	{ bet: 20,  minDouble: 2, payout: 120 },
	{ bet: 30,  minDouble: 3, payout: 210 },
	{ bet: 40,  minDouble: 4, payout: 320 },
	{ bet: 50,  minDouble: 5, payout: 500 },
	{ bet: 60,  minDouble: 6, payout: 1000 },
];

// =============================================================
// 5. Engine helpers
// =============================================================
function createEngine(template, playerConfigs, rng, options) {
	return {
		rng,
		verbose: !!(options && options.verbose),
		squares: template.map(sq => Object.assign({}, sq)),
		players: playerConfigs.map((cfg, i) => ({
			index: i + 1,              // 1-indexed; 0 = bank
			name: cfg.name,
			strategy: cfg.strategy,
			strategyName: cfg.strategy.name,
			position: 0,
			money: STARTING_CASH,
			inJail: false,
			jailTurns: 0,
			chestJailCard: false,
			chanceJailCard: false,
			snipeCard: false,          // holdable — play to grab foreclosed property at face value
			taxAuditCard: false,       // holdable — play to trigger property tax on all players
			bankrupt: false,
			bankruptRound: null,
			totalInterestPaid: 0,
			totalRentPaid: 0,
			totalRentReceived: 0,
			lapsCompleted: 0,
			housesBuilt: 0,
			mortgagesTaken: 0,
			peakDebt: 0,
			marginCallsReceived: 0,
			propertiesForeclosed: 0,
			firstRollThisTurn: 7,   // captured at the start of takeTurn, read at pass-GO
			totalCostOfLivingPaid: 0,
			totalCatastrophePaid: 0,
			totalPropertyTaxPaid: 0,
			snipesUsed: 0,
		casinoBets: 0,
		casinoWinnings: 0,
		casinoLosses: 0,
		})),
		chestDeck: shuffle(COMMUNITY_CHEST.map((_, i) => i), rng),
		chestPtr: 0,
		chanceDeck: shuffle(CHANCE.map((_, i) => i), rng),
		chancePtr: 0,
		round: 0,
		crisisActive: false,       // true during a bubble-pop lap
		crisisRound: 0,            // round the current crisis started
		totalCrises: 0,            // how many bubbles have popped this game
		lastCrisisRound: 0,        // cooldown: don't re-trigger within 5 rounds
		// Timeline tracking
		timeline: [],              // per-round snapshots [{round, players: [{name,nw,cash,debt,houses}]}]
		events: [],                // [{round, type, description}]
	};
}

function log(engine, msg) {
	if (engine.verbose) console.log(`    r${engine.round}: ${msg}`);
}

// Capture a snapshot of all players for the timeline
function snapshotTimeline(engine) {
	const snap = { round: engine.round, players: [] };
	for (const p of engine.players) {
		let debt = 0, houses = 0, hotels = 0, props = 0;
		for (const sq of engine.squares) {
			if (sq.owner !== p.index) continue;
			props++;
			if (sq.mortgage) debt += Math.round(sq.price * MORTGAGE_VALUE);
			houses += sq.house;
			hotels += sq.hotel;
		}
		snap.players.push({
			name: p.name,
			nw: p.bankrupt ? 0 : netWorth(engine, p),
			cash: p.bankrupt ? 0 : p.money,
			debt: debt,
			houses: houses + hotels * 5,
			props: props,
			bankrupt: p.bankrupt
		});
	}
	engine.timeline.push(snap);
}

function addEvent(engine, type, desc) {
	engine.events.push({ round: engine.round, type: type, description: desc });
}

function drawChance(engine) {
	if (engine.chancePtr >= engine.chanceDeck.length) {
		engine.chanceDeck = shuffle(CHANCE.map((_, i) => i), engine.rng);
		engine.chancePtr = 0;
	}
	return engine.chanceDeck[engine.chancePtr++];
}
function drawChest(engine) {
	if (engine.chestPtr >= engine.chestDeck.length) {
		engine.chestDeck = shuffle(COMMUNITY_CHEST.map((_, i) => i), engine.rng);
		engine.chestPtr = 0;
	}
	return engine.chestDeck[engine.chestPtr++];
}

function getMortgageDebt(engine, player) {
	let total = 0;
	for (const sq of engine.squares) {
		if (sq.owner === player.index && sq.mortgage) {
			total += Math.round(sq.price * MORTGAGE_VALUE);
		}
	}
	return total;
}

// Expected rent income per lap — static base rent proxy, matches what the
// in-game bank would use. Uses baserent × monopoly multiplier + house rent,
// with dice-7 approximation for utilities and full-occupancy for hubs.
function getRentIncomePerLap(engine, player) {
	let total = 0;
	for (const sq of engine.squares) {
		if (sq.owner !== player.index || sq.mortgage) continue;
		if (sq.groupNumber === 1) {
			const n = countInGroup(engine, player.index, 1);
			total += 25 * Math.pow(2, n - 1);
		} else if (sq.groupNumber === 2) {
			const n = countInGroup(engine, player.index, 2);
			total += 7 * (n === 2 ? 10 : 4);
		} else if (sq.hotel) {
			total += sq.rent5;
		} else if (sq.house >= 1 && sq.house <= 4) {
			total += sq['rent' + sq.house];
		} else {
			const monoMult = ownsMonopoly(engine, player, sq.groupNumber) ? 2 : 1;
			total += sq.baserent * monoMult;
		}
	}
	return total;
}

function getIncomePerLap(engine, player) {
	return GO_SALARY + getRentIncomePerLap(engine, player);
}

function getDSCR(engine, player) {
	const debt = getMortgageDebt(engine, player);
	if (debt === 0) return Infinity;
	const interest = debt * INTEREST_RATE;
	if (interest === 0) return Infinity;
	return getIncomePerLap(engine, player) / interest;
}

function countInGroup(engine, playerIndex, groupNumber) {
	let count = 0;
	for (const sq of engine.squares) {
		if (sq.groupNumber === groupNumber && sq.owner === playerIndex) count++;
	}
	return count;
}

function ownsMonopoly(engine, player, groupNumber) {
	if (!groupNumber || groupNumber <= 2) return false;
	return countInGroup(engine, player.index, groupNumber) === GROUP_SIZE[groupNumber];
}

function groupHasBuildings(engine, groupNumber) {
	for (const sq of engine.squares) {
		if (sq.groupNumber === groupNumber && (sq.house > 0 || sq.hotel > 0)) return true;
	}
	return false;
}

function groupAllUnmortgaged(engine, player, groupNumber) {
	for (const sq of engine.squares) {
		if (sq.groupNumber === groupNumber && sq.owner === player.index && sq.mortgage) return false;
	}
	return true;
}

function calculateRent(engine, sq, diceSum) {
	if (!sq.owner || sq.mortgage) return 0;
	if (sq.groupNumber === 1) {
		const n = countInGroup(engine, sq.owner, 1);
		return 25 * Math.pow(2, n - 1);          // 25, 50, 100, 200
	}
	if (sq.groupNumber === 2) {
		const n = countInGroup(engine, sq.owner, 2);
		return diceSum * (n === 2 ? 10 : 4);
	}
	if (sq.hotel) return sq.rent5;
	if (sq.house >= 1 && sq.house <= 4) return sq['rent' + sq.house];
	const owner = engine.players[sq.owner - 1];
	return ownsMonopoly(engine, owner, sq.groupNumber) ? sq.baserent * 2 : sq.baserent;
}

function netWorth(engine, player) {
	let w = player.money;
	for (const sq of engine.squares) {
		if (sq.owner !== player.index) continue;
		if (sq.mortgage) continue;                   // mortgaged = 0 equity
		w += sq.price;
		w += (sq.house + sq.hotel * 5) * Math.round(sq.houseprice / 2);
	}
	return w;
}

// =============================================================
// 6. Core movement & landing
// =============================================================
function sendToJail(engine, player) {
	player.position = JAIL_POSITION;
	player.inJail = true;
	player.jailTurns = 0;
	log(engine, `${player.name} → JAIL`);
}

// Bank's margin call: fires at pass-GO when DSCR would be below the floor.
// The only legal cure is foreclosing mortgaged properties (no new borrowing,
// no house sales — those either can't happen in group or make ratio worse).
// Foreclosure clears the mortgage, drops the debt, property returns to bank
// as unowned (owner = 0, unmortgaged, no houses). Cheapest first so the
// player retains their most valuable holdings longest.
function triggerMarginCall(engine, player) {
	if (!MARGIN_CALL_ENABLED) return;
	let fired = false;
	let guard = 60;
	while (guard-- > 0) {
		const dscr = getDSCR(engine, player);
		if (dscr >= DSCR_FLOOR) break;

		// Priority 1 — foreclose mortgaged properties (zero income loss)
		const mortgaged = [];
		for (const sq of engine.squares) {
			if (sq.owner === player.index && sq.mortgage) mortgaged.push(sq);
		}
		if (mortgaged.length > 0) {
			mortgaged.sort((a, b) => a.price - b.price);
			const sq = mortgaged[0];
			if (!fired) {
				log(engine, `${player.name} MARGIN CALL (DSCR ${dscr.toFixed(2)} < ${DSCR_FLOOR})`);
				player.marginCallsReceived++;
				fired = true;
			}
			log(engine, `  bank forecloses ${sq.name} (mortgaged, clears $${Math.round(sq.price * MORTGAGE_VALUE)} principal)`);
			sq.owner = 0;
			sq.mortgage = false;
			sq.house = 0;
			sq.hotel = 0;
			player.propertiesForeclosed++;
			// Foreclosed property goes to auction — Snipe card can intercept
			runAuctionWithSnipe(engine, sq, 'foreclosure');
			continue;
		}

		// Priority 2 — foreclose unmortgaged, undeveloped properties
		// (only hit when the player has exhausted all mortgaged options)
		const unmortgaged = [];
		for (const sq of engine.squares) {
			if (sq.owner !== player.index) continue;
			if (sq.mortgage || sq.house || sq.hotel) continue;
			unmortgaged.push(sq);
		}
		if (unmortgaged.length > 0) {
			unmortgaged.sort((a, b) => a.price - b.price);
			const sq = unmortgaged[0];
			if (!fired) {
				log(engine, `${player.name} MARGIN CALL (DSCR ${dscr.toFixed(2)} < ${DSCR_FLOOR})`);
				player.marginCallsReceived++;
				fired = true;
			}
			log(engine, `  bank forecloses ${sq.name} (unmortgaged, full face $${sq.price})`);
			sq.owner = 0;
			sq.mortgage = false;
			player.propertiesForeclosed++;
			// Foreclosed property goes to auction — Snipe card can intercept
			runAuctionWithSnipe(engine, sq, 'foreclosure');
			continue;
		}

		// Nothing left to foreclose → the player's only assets are built
		// groups generating rent that is still below interest. That's a
		// terminal state (developed monopoly can't be auto-sold by the
		// bank without destroying the player), so we exit and let the
		// subsequent interest payment push the player into bankruptcy.
		log(engine, `  no foreclosable assets — margin call abandoned`);
		break;
	}
}

function collectSalaryAndPayInterest(engine, player) {
	player.money += GO_SALARY;
	player.lapsCompleted++;

	// Cost of living — inflation tax. Grows with the player's own lap count,
	// variance from the first dice roll of the turn on which they passed GO.
	// Order: salary in hand → pay cost of living → margin call check → interest.
	let costOfLiving = 0;
	if (COST_OF_LIVING_ENABLED) {
		costOfLiving = player.firstRollThisTurn * player.lapsCompleted;
		player.money -= costOfLiving;
		player.totalCostOfLivingPaid += costOfLiving;
		if (player.money < 0) {
			resolveDebt(engine, player, null);
			if (player.bankrupt) return;
		}
	}

	// Bank runs the DSCR check BEFORE collecting interest. If the player
	// can't service their debt from cash flow, the bank forecloses first
	// to shrink the debt pile, then levies interest on the reduced total.
	triggerMarginCall(engine, player);

	const debt = getMortgageDebt(engine, player);
	if (debt > player.peakDebt) player.peakDebt = debt;
	if (debt > 0) {
		const effectiveRate = engine.crisisActive ? INTEREST_RATE * CRISIS_INTEREST_MULT : INTEREST_RATE;
		const interest = Math.round(debt * effectiveRate);
		player.money -= interest;
		player.totalInterestPaid += interest;
		if (costOfLiving > 0) {
			log(engine, `${player.name} +$${GO_SALARY} salary, -$${costOfLiving} COL (lap ${player.lapsCompleted}), -$${interest} interest on $${debt} debt`);
		} else {
			log(engine, `${player.name} +$${GO_SALARY} salary, -$${interest} interest on $${debt} debt`);
		}
	} else {
		if (costOfLiving > 0) {
			log(engine, `${player.name} +$${GO_SALARY} salary, -$${costOfLiving} COL (lap ${player.lapsCompleted})`);
		} else {
			log(engine, `${player.name} +$${GO_SALARY} salary`);
		}
	}
	if (player.money < 0) {
		resolveDebt(engine, player, null);      // bank creditor
	}
}

function moveTo(engine, player, newPos, collectGo) {
	const old = player.position;
	player.position = ((newPos % 40) + 40) % 40;
	if (collectGo && player.position < old) {
		collectSalaryAndPayInterest(engine, player);
	}
}

function advanceSteps(engine, player, steps) {
	const newPos = player.position + steps;
	if (newPos >= 40) {
		player.position = newPos - 40;
		collectSalaryAndPayInterest(engine, player);
	} else {
		player.position = newPos;
	}
}

function pay(engine, payer, amount, payee) {
	payer.money -= amount;
	if (payee) {
		payee.money += amount;
		payer.totalRentPaid += amount;
		payee.totalRentReceived += amount;
		log(engine, `${payer.name} pays $${amount} to ${payee.name}`);
	} else {
		log(engine, `${payer.name} pays $${amount} to bank`);
	}
	if (payer.money < 0) {
		resolveDebt(engine, payer, payee);
	}
}

// Casino (position 20) — trailing players bet big, leaders skip
function simCasino(engine, player) {
	if (!CASINO_ENABLED_SIM) return;

	// Calculate wealth rank
	const alive = engine.players.filter(p => !p.bankrupt);
	const myNW = netWorth(engine, player);
	let rank = 1;
	for (const p of alive) {
		if (p !== player && netWorth(engine, p) > myNW) rank++;
	}

	// Strategy decides tier — same logic as playable game AI
	let tierIdx = -1;
	const stratName = player.strategy.name;

	if (stratName === 'Careful') {
		tierIdx = -1; // never gambles
	} else if (rank === 1) {
		tierIdx = -1; // leading — don't gamble
	} else if (rank === alive.length) {
		// Last place — go big
		for (let i = CASINO_TIERS_SIM.length - 1; i >= 0; i--) {
			if (player.money >= CASINO_TIERS_SIM[i].bet) { tierIdx = i; break; }
		}
	} else {
		// Middle — moderate bet
		if (player.money >= 30) tierIdx = 2;
		else if (player.money >= 20) tierIdx = 1;
		else if (player.money >= 10) tierIdx = 0;
	}

	if (tierIdx < 0) {
		log(engine, `${player.name} visits Casino — walks away`);
		return;
	}

	const tier = CASINO_TIERS_SIM[tierIdx];
	if (player.money < tier.bet) return;

	// Roll
	const d1 = rollDie(engine.rng);
	const d2 = rollDie(engine.rng);
	const isDouble = d1 === d2;
	const win = isDouble && d1 >= tier.minDouble;

	player.money -= tier.bet;
	player.casinoBets = (player.casinoBets || 0) + tier.bet;

	if (win) {
		player.money += tier.payout;
		player.casinoWinnings = (player.casinoWinnings || 0) + tier.payout;
		log(engine, `*** CASINO: ${player.name} bets $${tier.bet}, rolls ${d1}-${d2}, WINS $${tier.payout}! ***`);
	} else {
		player.casinoLosses = (player.casinoLosses || 0) + tier.bet;
		log(engine, `CASINO: ${player.name} bets $${tier.bet}, rolls ${d1}-${d2} — loses`);
	}
}

function handleLanding(engine, player, diceSum) {
	const pos = player.position;
	const sq = engine.squares[pos];
	log(engine, `${player.name} lands on ${sq.name} (${pos})`);

	if (pos === GOTO_JAIL_POSITION) { sendToJail(engine, player); return; }
	if (pos === INCOME_TAX_POSITION) { pay(engine, player, INCOME_TAX_AMOUNT, null); return; }
	if (pos === LUXURY_TAX_POSITION) { pay(engine, player, LUXURY_TAX_AMOUNT, null); return; }
	if (pos === CASINO_POSITION && CASINO_ENABLED_SIM) { simCasino(engine, player); return; }

	if (pos === 7 || pos === 22 || pos === 36) {
		applyCard(engine, player, CHANCE[drawChance(engine)], 'Chance', diceSum);
		return;
	}
	if (pos === 2 || pos === 17 || pos === 33) {
		applyCard(engine, player, COMMUNITY_CHEST[drawChest(engine)], 'Chest', diceSum);
		return;
	}

	// Property / hub / utility
	if (sq.price > 0) {
		if (sq.owner === 0) {
			const wants = player.strategy.wantToBuy(engine, player, sq);
			if (wants && player.money >= sq.price) {
				player.money -= sq.price;
				sq.owner = player.index;
				log(engine, `${player.name} BUYS ${sq.name} for $${sq.price}`);
			} else if (wants && player.strategy.wantLeveragedBuy && player.strategy.wantLeveragedBuy(engine, player, sq)) {
				// Try to raise the shortfall via voluntary mortgage.
				// Bank may refuse any loan that would drop DSCR below threshold.
				log(engine, `${player.name} wants ${sq.name} ($${sq.price}) — attempting leveraged buy`);
				const ok = raiseCashViaMortgage(engine, player, sq.price);
				if (ok && player.money >= sq.price) {
					player.money -= sq.price;
					sq.owner = player.index;
					log(engine, `${player.name} LEVERAGED BUY ${sq.name} for $${sq.price}`);
				} else {
					log(engine, `  leverage insufficient → auction`);
					runAuction(engine, sq, player);
				}
			} else {
				runAuction(engine, sq, player);
			}
		} else if (sq.owner !== player.index) {
			const owner = engine.players[sq.owner - 1];
			if (!owner.bankrupt) {
				const rent = calculateRent(engine, sq, diceSum);
				if (rent > 0) pay(engine, player, rent, owner);
			}
		}
	}
}

function runAuction(engine, sq, skipPlayer) {
	// Simplified sealed-bid: each strategy names a max, highest wins and pays its max.
	let bestBid = 0, bestBidder = null;
	for (const p of engine.players) {
		if (p.bankrupt) continue;
		const cap = p.strategy.maxAuctionBid(engine, p, sq);
		// Allow bidding up to mortgageable value, not just pocket cash
		const affordable = mortgageableValue(engine, p);
		const bid = Math.min(cap, affordable);
		if (bid > bestBid) { bestBid = bid; bestBidder = p; }
	}
	if (bestBidder && bestBid > 0) {
		// Winner mortgages to cover if needed
		if (bestBidder.money < bestBid) {
			raiseCashViaMortgage(engine, bestBidder, bestBid);
		}
		bestBidder.money -= bestBid;
		sq.owner = bestBidder.index;
		log(engine, `AUCTION: ${bestBidder.name} wins ${sq.name} for $${bestBid}`);
	}
}

// =============================================================
// 7. Card effects
// =============================================================
function applyCard(engine, player, card, deck, diceSum) {
	log(engine, `${player.name} draws ${deck}: ${card.type}`);
	switch (card.type) {
		case 'jailCard':
			if (deck === 'Chance') player.chanceJailCard = true;
			else player.chestJailCard = true;
			return;
		case 'collect':
			player.money += card.amount;
			return;
		case 'pay':
			pay(engine, player, card.amount, null);
			return;
		case 'collectFromEach':
			for (const other of engine.players) {
				if (other !== player && !other.bankrupt) pay(engine, other, card.amount, player);
			}
			return;
		case 'payEach':
			for (const other of engine.players) {
				if (other === player || other.bankrupt) continue;
				pay(engine, player, card.amount, other);
				if (player.bankrupt) return;
			}
			return;
		case 'advance':
			moveTo(engine, player, card.to, true);
			if (!player.bankrupt) handleLanding(engine, player, diceSum);
			return;
		case 'back3':
			player.position = (player.position - 3 + 40) % 40;
			handleLanding(engine, player, diceSum);
			return;
		case 'nearestUtility': {
			const pos = player.position;
			const target = pos < 12 || pos >= 28 ? 12 : 28;
			moveTo(engine, player, target, true);
			const sq = engine.squares[target];
			if (sq.owner && sq.owner !== player.index && !sq.mortgage) {
				const r = (rollDie(engine.rng) + rollDie(engine.rng)) * 10;
				pay(engine, player, r, engine.players[sq.owner - 1]);
			} else if (sq.owner === 0 && sq.price > 0) {
				if (player.strategy.wantToBuy(engine, player, sq) && player.money >= sq.price) {
					player.money -= sq.price; sq.owner = player.index;
				} else {
					runAuction(engine, sq, player);
				}
			}
			return;
		}
		case 'nearestRailroad': {
			const pos = player.position;
			let target;
			if (pos < 5 || pos >= 35) target = 5;
			else if (pos < 15) target = 15;
			else if (pos < 25) target = 25;
			else target = 35;
			moveTo(engine, player, target, true);
			const sq = engine.squares[target];
			if (sq.owner && sq.owner !== player.index && !sq.mortgage) {
				const rent = calculateRent(engine, sq, diceSum) * 2;
				pay(engine, player, rent, engine.players[sq.owner - 1]);
			} else if (sq.owner === 0 && sq.price > 0) {
				if (player.strategy.wantToBuy(engine, player, sq) && player.money >= sq.price) {
					player.money -= sq.price; sq.owner = player.index;
				} else {
					runAuction(engine, sq, player);
				}
			}
			return;
		}
		case 'goToJail':
			sendToJail(engine, player);
			return;
		case 'streetRepairs': {
			let houses = 0, hotels = 0;
			for (const sq of engine.squares) {
				if (sq.owner === player.index) { houses += sq.house; hotels += sq.hotel; }
			}
			const cost = houses * card.house + hotels * card.hotel;
			if (cost > 0) pay(engine, player, cost, null);
			return;
		}
		// ——— NEW TYCOON SAIGON CARDS ———
		case 'snipeCard':
			if (!EVENTS_ENABLED) return;
			player.snipeCard = true;
			log(engine, `${player.name} draws SNIPE CARD — holds until a foreclosure auction`);
			return;
		case 'catastrophe': {
			if (!EVENTS_ENABLED) {
				// Fallback: old streetRepairs behavior
				let h2 = 0, ht2 = 0;
				for (const sq of engine.squares) {
					if (sq.owner === player.index) { h2 += sq.house; ht2 += sq.hotel; }
				}
				const c2 = h2 * 40 + ht2 * 115;
				if (c2 > 0) pay(engine, player, c2, null);
				return;
			}
			// Catastrophe: ALL players pay CATASTROPHE_MULT × their next dice roll
			log(engine, `*** CATASTROPHE — all players pay ${CATASTROPHE_MULT}× their dice roll ***`);
			addEvent(engine, 'catastrophe', 'Catastrophe — all pay ' + CATASTROPHE_MULT + '× dice');
			for (const other of engine.players) {
				if (other.bankrupt) continue;
				const cd1 = rollDie(engine.rng), cd2 = rollDie(engine.rng);
				const catCost = (cd1 + cd2) * CATASTROPHE_MULT;
				other.totalCatastrophePaid += catCost;
				log(engine, `  ${other.name} rolls ${cd1}+${cd2}=${cd1+cd2}, pays $${catCost}`);
				pay(engine, other, catCost, null);
				if (other.bankrupt) continue;
			}
			return;
		}
		case 'taxAuditCard':
			if (!EVENTS_ENABLED) {
				pay(engine, player, 15, null);
				return;
			}
			player.taxAuditCard = true;
			log(engine, `${player.name} draws TAX AUDIT CARD — holds until opponents build up`);
			return;
		case 'propertyTax': {
			if (!EVENTS_ENABLED) {
				pay(engine, player, 15, null);
				return;
			}
			log(engine, `*** PROPERTY TAX REASSESSMENT — all players pay $${TAX_PER_HOUSE}/house, $${TAX_PER_HOTEL}/hotel ***`);
			addEvent(engine, 'propertyTax', 'Property Tax — $' + TAX_PER_HOUSE + '/house, $' + TAX_PER_HOTEL + '/hotel');
			for (const other of engine.players) {
				if (other.bankrupt) continue;
				let oHouses = 0, oHotels = 0;
				for (const sq of engine.squares) {
					if (sq.owner === other.index) { oHouses += sq.house; oHotels += sq.hotel; }
				}
				const taxCost = oHouses * TAX_PER_HOUSE + oHotels * TAX_PER_HOTEL;
				if (taxCost > 0) {
					other.totalPropertyTaxPaid += taxCost;
					log(engine, `  ${other.name} pays $${taxCost} (${oHouses} houses, ${oHotels} hotels)`);
					pay(engine, other, taxCost, null);
				} else {
					log(engine, `  ${other.name} has no buildings — no charge`);
				}
			}
			return;
		}
	}
}

// =============================================================
// 7b. Tax Audit — AI plays holdable card
// =============================================================
function tryPlayTaxAudit(engine, player) {
	if (!player.taxAuditCard || !EVENTS_ENABLED) return false;
	let myBuildings = 0, oppBuildings = 0;
	for (const sq of engine.squares) {
		if (sq.owner === player.index) myBuildings += sq.hotel ? 5 : sq.house;
		else if (sq.owner > 0) oppBuildings += sq.hotel ? 5 : sq.house;
	}
	if (oppBuildings <= myBuildings + 3) return false;
	player.taxAuditCard = false;
	log(engine, `*** ${player.name} plays TAX AUDIT CARD — all players pay $${TAX_PER_HOUSE}/house, $${TAX_PER_HOTEL}/hotel ***`);
	addEvent(engine, 'taxAudit', 'Tax Audit played by ' + player.name);
	for (const other of engine.players) {
		if (other.bankrupt) continue;
		let h = 0, ht = 0;
		for (const sq of engine.squares) {
			if (sq.owner === other.index) { h += sq.house; ht += sq.hotel; }
		}
		const cost = h * TAX_PER_HOUSE + ht * TAX_PER_HOTEL;
		if (cost > 0) {
			other.totalPropertyTaxPaid += cost;
			log(engine, `  ${other.name} pays $${cost} (${h} houses, ${ht} hotels)`);
			pay(engine, other, cost, null);
		}
	}
	return true;
}

// =============================================================
// 7c. Bubble + Crash system
// =============================================================
function getSystemDebt(engine) {
	let total = 0;
	for (const p of engine.players) {
		if (p.bankrupt) continue;
		total += getMortgageDebt(engine, p);
	}
	return total;
}

function checkBubble(engine) {
	if (!EVENTS_ENABLED) return;
	if (engine.crisisActive) return;  // already in crisis
	if (engine.round - engine.lastCrisisRound < 8) return;  // cooldown (8 rounds between crises)

	const debt = getSystemDebt(engine);
	if (debt >= BUBBLE_THRESHOLD) {
		engine.crisisActive = true;
		engine.crisisRound = engine.round;
		engine.totalCrises++;
		addEvent(engine, 'crisis', 'Financial Crisis — system debt $' + debt);
		log(engine, `\n*** FINANCIAL CRISIS — system debt $${debt} >= threshold $${BUBBLE_THRESHOLD} ***`);
		log(engine, `    Interest rate SPIKES to ${(INTEREST_RATE * CRISIS_INTEREST_MULT * 100).toFixed(0)}% for this round`);

		// Crisis forces a DSCR check on every non-bankrupt player with debt.
		// This is the "bubble pop" — the bank calls in loans it wouldn't normally.
		// Uses a tighter threshold (DSCR_FLOOR × 1.5) so more players get hit.
		const crisisFloor = DSCR_FLOOR * 1.5;
		for (const p of engine.players) {
			if (p.bankrupt) continue;
			const pDebt = getMortgageDebt(engine, p);
			if (pDebt === 0) continue;
			const pDscr = getDSCR(engine, p);
			if (pDscr < crisisFloor) {
				log(engine, `    CRISIS MARGIN CALL on ${p.name} (DSCR ${pDscr.toFixed(2)} < crisis floor ${crisisFloor.toFixed(2)})`);
				p.marginCallsReceived++;
				// Foreclose cheapest mortgaged properties until DSCR improves
				let guard = 20;
				while (guard-- > 0) {
					const currentDscr = getDSCR(engine, p);
					if (currentDscr >= crisisFloor) break;
					const mortgaged = [];
					for (const sq of engine.squares) {
						if (sq.owner === p.index && sq.mortgage) mortgaged.push(sq);
					}
					if (mortgaged.length === 0) break;
					mortgaged.sort((a, b) => a.price - b.price);
					const sq = mortgaged[0];
					log(engine, `      forecloses ${sq.name}`);
					sq.owner = 0;
					sq.mortgage = false;
					sq.house = 0;
					sq.hotel = 0;
					p.propertiesForeclosed++;
					// Foreclosed property hits auction — Snipe card can intercept!
					runAuctionWithSnipe(engine, sq, 'foreclosure');
				}
			}
		}
		log(engine, '');
	}
}

function endCrisis(engine) {
	if (engine.crisisActive) {
		// Crisis persists until system debt drops below threshold
		let totalDebt = 0;
		for (const p of engine.players) {
			if (p.bankrupt) continue;
			for (const sq of engine.squares) {
				if (sq.owner === p.index && sq.mortgage) totalDebt += Math.round(sq.price * MORTGAGE_VALUE);
			}
		}
		if (totalDebt < BUBBLE_THRESHOLD) {
			engine.crisisActive = false;
			engine.lastCrisisRound = engine.round;
			log(engine, `*** Financial crisis ends — debt $${totalDebt} < $${BUBBLE_THRESHOLD} — interest returns to ${(INTEREST_RATE * 100).toFixed(0)}% ***`);
		}
	}
}

// Modified auction that supports Snipe card interception
function runAuctionWithSnipe(engine, sq, reason) {
	// Check if any player holds a Snipe card and wants to use it
	if (EVENTS_ENABLED && reason === 'foreclosure') {
		for (const p of engine.players) {
			if (p.bankrupt || !p.snipeCard) continue;
			// AI decision: use Snipe if the property is in a group they already own,
			// or if it's a high-value group (6=Orange, 7=Red), and they can afford face value
			const mine = countInGroup(engine, p.index, sq.groupNumber);
			const isValuable = sq.groupNumber >= 6 && sq.groupNumber <= 8;
			if ((mine >= 1 || isValuable) && p.money >= sq.price) {
				p.snipeCard = false;
				p.money -= sq.price;
				sq.owner = p.index;
				sq.mortgage = false;
				p.snipesUsed++;
				log(engine, `*** SNIPE! ${p.name} plays Snipe card — grabs ${sq.name} at face value $${sq.price} ***`);
				return true;
			}
		}
	}
	// Normal sealed-bid auction
	runAuction(engine, sq, null);
	return false;
}

// =============================================================
// 8a. Voluntary leveraged borrowing (for buy decisions)
// =============================================================
// Mortgage the player's non-monopoly, undeveloped holdings to raise cash
// for a purchase. Per-step DSCR check refuses any mortgage that would
// push the post-mortgage ratio below DSCR_BORROW. Returns true if the
// player has at least `target` cash afterward.
function raiseCashViaMortgage(engine, player, target) {
	if (!LEVERAGE_ENABLED) return player.money >= target;

	const candidates = [];
	for (const sq of engine.squares) {
		if (sq.owner !== player.index || sq.mortgage) continue;
		if (sq.house || sq.hotel) continue;
		// Monopoly rule: can't mortgage if any property in the group has buildings.
		if (sq.groupNumber > 2 && groupHasBuildings(engine, sq.groupNumber)) continue;
		// Protect monopoly groups — mortgaging them removes rent income
		// and undermines the whole leverage play.
		if (sq.groupNumber > 2 && ownsMonopoly(engine, player, sq.groupNumber)) continue;
		candidates.push(sq);
	}
	// Cheapest first to minimize total collateral locked up
	candidates.sort((a, b) => a.price - b.price);

	for (const sq of candidates) {
		if (player.money >= target) break;

		// DSCR check: simulate mortgaging this property, see what the
		// ratio would become. If below the borrow threshold, refuse.
		sq.mortgage = true;
		const postDscr = getDSCR(engine, player);
		if (postDscr < DSCR_BORROW) {
			sq.mortgage = false;   // bank refuses this loan
			log(engine, `  bank refuses mortgage on ${sq.name} (would leave DSCR ${postDscr.toFixed(2)} < ${DSCR_BORROW})`);
			break;                  // larger props will fail same check
		}
		player.money += Math.round(sq.price * MORTGAGE_VALUE);
		player.mortgagesTaken++;
		log(engine, `  ${player.name} mortgages ${sq.name} for $${Math.round(sq.price * MORTGAGE_VALUE)} (DSCR now ${postDscr.toFixed(2)})`);
	}
	return player.money >= target;
}

// Estimate how much cash a player could have after mortgaging everything
// the bank would approve (DSCR-aware). Used for auction bids.
function mortgageableValue(engine, player) {
	if (!LEVERAGE_ENABLED) return player.money;
	const candidates = [];
	for (const sq of engine.squares) {
		if (sq.owner !== player.index || sq.mortgage) continue;
		if (sq.house || sq.hotel) continue;
		// Monopoly rule: can't mortgage if any property in the group has buildings.
		if (sq.groupNumber > 2 && groupHasBuildings(engine, sq.groupNumber)) continue;
		if (sq.groupNumber > 2 && ownsMonopoly(engine, player, sq.groupNumber)) continue;
		candidates.push(sq);
	}
	candidates.sort((a, b) => a.price - b.price);
	// Simulate mortgaging cumulatively, then undo all
	let extra = 0;
	const mortgaged = [];
	for (const sq of candidates) {
		sq.mortgage = true;
		mortgaged.push(sq);
		const postDscr = getDSCR(engine, player);
		if (postDscr < DSCR_BORROW) {
			sq.mortgage = false; // bank would refuse this one
			mortgaged.pop();
			break;
		}
		extra += Math.round(sq.price * MORTGAGE_VALUE);
	}
	// Undo all simulated mortgages
	for (const sq of mortgaged) sq.mortgage = false;
	return player.money + extra;
}

// =============================================================
// 8. Debt resolution & bankruptcy
// =============================================================
function resolveDebt(engine, player, creditor) {
	// Try normal cash-raise first (sell houses, mortgage)
	let guard = 60;
	while (player.money < 0 && guard-- > 0) {
		const action = chooseCashRaise(engine, player);
		if (!action) break;
		executeCashRaise(engine, player, action);
	}
	if (player.money >= 0) return; // recovered

	// Still can't pay — fire sale: auction ALL properties
	fireSale(engine, player, creditor);
}

function chooseCashRaise(engine, player) {
	// 1. Sell a hotel (one at a time, highest-value group first)
	let bestHotel = null;
	for (const sq of engine.squares) {
		if (sq.owner === player.index && sq.hotel > 0) {
			if (!bestHotel || sq.houseprice > bestHotel.houseprice) bestHotel = sq;
		}
	}
	if (bestHotel) return { type: 'sellHotel', index: bestHotel.index };

	// 2. Sell houses evenly: pick the square with the max house count in any group
	let bestHouse = null;
	for (const sq of engine.squares) {
		if (sq.owner === player.index && sq.house > 0) {
			if (!bestHouse || sq.house > bestHouse.house) bestHouse = sq;
		}
	}
	if (bestHouse) return { type: 'sellHouse', index: bestHouse.index };

	// 3. Mortgage undeveloped properties — non-monopoly first, then monopoly
	const nonMono = [], mono = [];
	for (const sq of engine.squares) {
		if (sq.owner !== player.index || sq.mortgage) continue;
		if (sq.house || sq.hotel) continue;
		if (sq.groupNumber > 2 && ownsMonopoly(engine, player, sq.groupNumber)) mono.push(sq);
		else nonMono.push(sq);
	}
	nonMono.sort((a, b) => b.price - a.price);
	mono.sort((a, b) => b.price - a.price);
	const target = nonMono[0] || mono[0];
	if (target) return { type: 'mortgage', index: target.index };
	return null;
}

function executeCashRaise(engine, player, action) {
	const sq = engine.squares[action.index];
	switch (action.type) {
		case 'mortgage':
			sq.mortgage = true;
			player.money += Math.round(sq.price * MORTGAGE_VALUE);
			player.mortgagesTaken++;
			log(engine, `${player.name} MORTGAGES ${sq.name} for $${Math.round(sq.price * MORTGAGE_VALUE)}`);
			return;
		case 'sellHouse':
			sq.house--;
			player.money += Math.round(sq.houseprice / 2);
			log(engine, `${player.name} sells house on ${sq.name}`);
			return;
		case 'sellHotel':
			sq.hotel = 0;
			sq.house = 4;
			player.money += Math.round(sq.houseprice / 2);
			log(engine, `${player.name} sells hotel on ${sq.name}`);
			return;
	}
}

// ================================================================
// FIRE SALE — Tycoon Saigon bankruptcy rules
// ================================================================
// Player can't pay → claw back creditor overpayment → sell houses →
// auction ALL properties (proceeds go to player) → settle.
// If player can cover debt after auctions → SURVIVES (propertyless).
// Otherwise → eliminated, creditor eats the shortfall.
// ================================================================
function fireSale(engine, player, creditor) {
	const shortfall = -player.money; // positive: how much they're short

	// Claw back overpayment from creditor
	if (creditor && !creditor.bankrupt) {
		creditor.money -= shortfall;
		log(engine, `${creditor.name} returns $${shortfall} overpayment (pending fire sale)`);
	}
	player.money = 0;
	const rentOwed = shortfall;

	addEvent(engine, 'fireSale', player.name + ' FIRE SALE — owes $' + rentOwed);
	log(engine, `${player.name} FIRE SALE — owes $${rentOwed}, auctioning all properties`);

	// Phase 1: Sell all houses/hotels at 50% — cash to player
	let houseSales = 0;
	for (const sq of engine.squares) {
		if (sq.owner !== player.index) continue;
		if (sq.hotel > 0) {
			houseSales += Math.round(sq.houseprice * 0.5 * 5);
			sq.hotel = 0;
			sq.house = 0;
		} else if (sq.house > 0) {
			houseSales += Math.round(sq.houseprice * 0.5 * sq.house);
			sq.house = 0;
		}
	}
	player.money += houseSales;
	if (houseSales > 0) log(engine, `  sold buildings for $${houseSales}`);

	// Check: house sales alone might cover it
	if (player.money >= rentOwed) {
		player.money -= rentOwed;
		if (creditor && !creditor.bankrupt) {
			creditor.money += rentOwed;
			log(engine, `  ${player.name} pays $${rentOwed} to ${creditor.name} from house sales — survives!`);
		}
		return;
	}

	// Phase 2: ALL properties on the block — most valuable first.
	// Other players snatch the best ones; auction stops once player is solvent.
	let auctionTotal = 0;
	const propsToAuction = [];
	for (const sq of engine.squares) {
		if (sq.owner === player.index && sq.price > 0) {
			propsToAuction.push(sq);
		}
	}
	// Sort most expensive first — other players grab the valuable ones
	propsToAuction.sort((a, b) => b.price - a.price);

	// === SNIPE FIRST PICK ===
	// Before auctions begin, any snipe card holder gets to browse ALL properties
	// on the block and cherry-pick one at face value.
	if (EVENTS_ENABLED) {
		for (const p of engine.players) {
			if (p.bankrupt || p === player || !p.snipeCard) continue;
			// AI picks: best group-completing property, or highest value
			let bestSnipe = null, bestScore = -1;
			for (const sq of propsToAuction) {
				if (p.money < sq.price) continue;
				const mine = countInGroup(engine, p.index, sq.groupNumber);
				const groupSize = GROUP_SIZE[sq.groupNumber] || 3;
				// Score: completing a group is top priority, then partial group, then raw value
				let score = sq.price;
				if (mine >= groupSize - 1) score += 10000; // completes monopoly
				else if (mine >= 1) score += 5000;          // advances toward group
				if (sq.groupNumber >= 6) score += 1000;     // premium groups
				if (score > bestScore) { bestScore = score; bestSnipe = sq; }
			}
			if (bestSnipe) {
				p.snipeCard = false;
				bestSnipe.owner = 0; // release from bankrupt player
				p.money -= bestSnipe.price;
				bestSnipe.owner = p.index;
				p.snipesUsed++;
				player.money += bestSnipe.price;
				auctionTotal += bestSnipe.price;
				log(engine, `  *** SNIPE! ${p.name} cherry-picks ${bestSnipe.name} at face value $${bestSnipe.price}`);
				// Remove from auction list
				const idx = propsToAuction.indexOf(bestSnipe);
				if (idx >= 0) propsToAuction.splice(idx, 1);
			}
		}
	}

	// === AUCTIONS — one by one, stop when solvent ===
	let propsAuctioned = 0;
	for (const sq of propsToAuction) {
		if (player.money >= rentOwed) {
			log(engine, `  raised enough ($${player.money} >= $${rentOwed}) — keeping ${propsToAuction.length - propsAuctioned} remaining properties`);
			break;
		}
		sq.owner = 0;
		// Keep mortgage status — buyer's problem (no snipe check — already done above)
		const proceeds = runFireSaleAuctionNoSnipe(engine, sq, player);
		auctionTotal += proceeds;
		player.money += proceeds;
		propsAuctioned++;
	}
	log(engine, `  fire sale: ${propsAuctioned} of ${propsToAuction.length} properties auctioned, raised $${auctionTotal}, total cash $${player.money}`);

	// Discard jail/snipe cards
	player.chanceJailCard = false;
	player.chestJailCard = false;
	player.snipeCard = false;

	// Phase 3: Settlement
	if (player.money >= rentOwed) {
		// SURVIVAL — pay debt, keep remainder
		player.money -= rentOwed;
		if (creditor && !creditor.bankrupt) {
			creditor.money += rentOwed;
			log(engine, `  ${player.name} pays $${rentOwed} to ${creditor.name} — SURVIVES with $${player.money}!`);
		} else {
			log(engine, `  ${player.name} pays $${rentOwed} to bank — SURVIVES with $${player.money}!`);
		}
	} else {
		// DEFAULT — creditor gets whatever player raised, eats the loss
		const paid = player.money;
		const deficit = rentOwed - paid;
		if (creditor && !creditor.bankrupt && paid > 0) {
			creditor.money += paid;
			log(engine, `  ${creditor.name} receives $${paid}, absorbs $${deficit} loss`);
		}
		player.money = 0;
		player.bankrupt = true;
		player.bankruptRound = engine.round;
		log(engine, `${player.name} ELIMINATED (round ${engine.round})`);
	}
}

// Fire-sale auction: sealed-bid, proceeds returned to caller (not bank)
// Fire-sale auction without snipe check (snipe is handled before the auction loop)
function runFireSaleAuctionNoSnipe(engine, sq, bankruptPlayer) {
	// Sealed-bid auction
	let bestBid = 0, bestBidder = null;
	for (const p of engine.players) {
		if (p.bankrupt || p === bankruptPlayer) continue;
		const cap = p.strategy.maxAuctionBid(engine, p, sq);
		const affordable = mortgageableValue(engine, p);
		const bid = Math.min(cap, affordable);
		if (bid > bestBid) { bestBid = bid; bestBidder = p; }
	}
	if (bestBidder && bestBid > 0) {
		if (bestBidder.money < bestBid) {
			raiseCashViaMortgage(engine, bestBidder, bestBid);
		}
		bestBidder.money -= bestBid;
		sq.owner = bestBidder.index;
		log(engine, `  AUCTION: ${bestBidder.name} wins ${sq.name} for $${bestBid}${sq.mortgage ? ' (mortgaged)' : ''}`);
		return bestBid;
	}
	// Nobody bid — property returns to bank
	sq.mortgage = false;
	log(engine, `  ${sq.name} — no bids, returned to bank`);
	return 0;
}

// =============================================================
// 9. Turn loop
// =============================================================
function takeTurn(engine, player) {
	if (player.bankrupt) return;

	// Jail handling — at most one dice attempt
	if (player.inJail) {
		if (player.chanceJailCard || player.chestJailCard) {
			if (player.chanceJailCard) player.chanceJailCard = false;
			else player.chestJailCard = false;
			player.inJail = false;
			player.jailTurns = 0;
			log(engine, `${player.name} uses jail card`);
		} else {
			const d1 = rollDie(engine.rng), d2 = rollDie(engine.rng);
			player.firstRollThisTurn = d1 + d2;
			if (d1 === d2) {
				player.inJail = false;
				player.jailTurns = 0;
				log(engine, `${player.name} rolls doubles out of jail`);
				advanceSteps(engine, player, d1 + d2);
				if (player.bankrupt) return;
				if (player.position === GOTO_JAIL_POSITION) { sendToJail(engine, player); return; }
				handleLanding(engine, player, d1 + d2);
				endOfTurnActions(engine, player);
				return;
			}
			player.jailTurns++;
			if (player.jailTurns >= 3) {
				pay(engine, player, JAIL_BAIL, null);
				if (player.bankrupt) return;
				player.inJail = false;
				player.jailTurns = 0;
				log(engine, `${player.name} pays bail`);
				advanceSteps(engine, player, d1 + d2);
				if (player.bankrupt) return;
				if (player.position === GOTO_JAIL_POSITION) { sendToJail(engine, player); return; }
				handleLanding(engine, player, d1 + d2);
			}
			// else sit in jail this turn (no end-of-turn actions so strategies don't over-build)
			return;
		}
	}

	// Normal roll loop — up to 3 doubles → jail
	let doubles = 0;
	let firstRollCaptured = false;
	while (true) {
		const d1 = rollDie(engine.rng), d2 = rollDie(engine.rng);
		const sum = d1 + d2;
		if (!firstRollCaptured) {
			player.firstRollThisTurn = sum;
			firstRollCaptured = true;
		}
		if (d1 === d2) {
			doubles++;
			if (doubles === 3) { sendToJail(engine, player); return; }
		}
		advanceSteps(engine, player, sum);
		if (player.bankrupt) return;
		if (player.position === GOTO_JAIL_POSITION) { sendToJail(engine, player); return; }
		handleLanding(engine, player, sum);
		if (player.bankrupt) return;
		if (player.inJail) return;
		if (d1 !== d2) break;
	}
	endOfTurnActions(engine, player);
}

function endOfTurnActions(engine, player) {
	if (player.bankrupt) return;

	// 0. Play Tax Audit card if opponents are building ahead
	tryPlayTaxAudit(engine, player);
	if (player.bankrupt) return;

	// 1. Voluntary unmortgage
	const toUnmortgage = player.strategy.wantUnmortgage(engine, player) || [];
	for (const idx of toUnmortgage) {
		const sq = engine.squares[idx];
		if (sq.owner !== player.index || !sq.mortgage) continue;
		const cost = Math.round(sq.price * UNMORTGAGE_COST);
		if (player.money - cost >= 200) {        // keep a small reserve
			player.money -= cost;
			sq.mortgage = false;
			log(engine, `${player.name} UNMORTGAGES ${sq.name} for $${cost}`);
		}
	}

	// 2. Build houses — strategies propose indices, engine enforces legality
	const toBuild = player.strategy.wantBuildHouses(engine, player) || [];
	for (const idx of toBuild) {
		const sq = engine.squares[idx];
		if (sq.owner !== player.index) continue;
		if (sq.hotel || sq.house >= 5) continue;
		if (!ownsMonopoly(engine, player, sq.groupNumber)) continue;
		if (!groupAllUnmortgaged(engine, player, sq.groupNumber)) continue;

		// Even-build rule: cannot build unless this is the minimum in the group
		let minHouse = Infinity;
		for (const s of engine.squares) {
			if (s.groupNumber === sq.groupNumber && s.owner === player.index) {
				const effective = s.hotel ? 5 : s.house;
				if (effective < minHouse) minHouse = effective;
			}
		}
		const myCount = sq.hotel ? 5 : sq.house;
		if (myCount !== minHouse) continue;

		if (player.money < sq.houseprice) continue;
		player.money -= sq.houseprice;
		if (sq.house === 4) { sq.hotel = 1; sq.house = 0; }
		else sq.house++;
		player.housesBuilt++;
		log(engine, `${player.name} builds on ${sq.name} ($${sq.houseprice})`);
	}
}

// =============================================================
// 10. Strategies
// =============================================================
const strategies = {
	// ---------- SHARK ---------- aggressive, high-roller
	Shark: {
		name: 'Shark',
		wantToBuy(engine, player, sq) {
			// Shark wants any property they can afford via cash OR leverage
			return player.money >= sq.price || sq.price <= 400;
		},
		wantLeveragedBuy(engine, player, sq) {
			// Always try to leverage if cash is short — Shark's whole MO
			return true;
		},
		maxAuctionBid(engine, player, sq) {
			// Only mortgage to bid when completing a group
			const mine = countInGroup(engine, player.index, sq.groupNumber);
			const wallet = mine >= 1 ? mortgageableValue(engine, player) : player.money;
			return Math.min(sq.price, Math.max(0, wallet - 50));
		},
		wantBuildHouses(engine, player) {
			const out = [];
			for (const sq of engine.squares) {
				if (sq.owner !== player.index) continue;
				if (ownsMonopoly(engine, player, sq.groupNumber)) out.push(sq.index);
			}
			// Repeat list 4x so we go up to full houses in one end-of-turn pass
			return out.concat(out).concat(out).concat(out);
		},
		wantUnmortgage(engine, player) {
			return [];    // never voluntarily
		},
	},

	// ---------- CAREFUL ---------- conservative, interest-averse
	Careful: {
		name: 'Careful',
		wantToBuy(engine, player, sq) {
			return player.money - sq.price >= 300;
		},
		maxAuctionBid(engine, player, sq) {
			// Careful never mortgages to bid — cash only, big reserve
			const cap = Math.floor(sq.price * 0.75);
			return Math.max(0, Math.min(cap, player.money - 400));
		},
		wantBuildHouses(engine, player) {
			// Build one house at a time, only when flush
			if (player.money < 500) return [];
			for (const sq of engine.squares) {
				if (sq.owner !== player.index) continue;
				if (!ownsMonopoly(engine, player, sq.groupNumber)) continue;
				if (player.money - sq.houseprice < 400) continue;
				return [sq.index];
			}
			return [];
		},
		wantUnmortgage(engine, player) {
			if (player.money < 500) return [];
			const out = [];
			for (const sq of engine.squares) {
				if (sq.owner === player.index && sq.mortgage) out.push(sq.index);
			}
			// Sort cheapest first so we clear more mortgages per unit cash
			out.sort((a, b) => engine.squares[a].price - engine.squares[b].price);
			return out;
		},
	},

	// ---------- MONOPOLIST ---------- strategic, color-set focused
	Monopolist: {
		name: 'Monopolist',
		wantToBuy(engine, player, sq) {
			// Relaxed cash threshold for monopoly completion since leverage is now an option
			if (sq.groupNumber > 2) {
				const mine = countInGroup(engine, player.index, sq.groupNumber);
				// Completing a group: want it even if cash is short (will try leverage)
				if (mine >= GROUP_SIZE[sq.groupNumber] - 1) return true;
				// Already started group: want it if cash is reasonable
				if (mine >= 1) return player.money >= sq.price * 0.7;
			}
			if (player.money < sq.price + 100) return false;
			if (sq.groupNumber === 1) return player.money > 400;
			if (sq.groupNumber === 2) return player.money > 500;
			return sq.price <= 200 || player.money > 800;
		},
		wantLeveragedBuy(engine, player, sq) {
			// Monopolist only leverages when completing a group
			if (sq.groupNumber <= 2) return false;
			const mine = countInGroup(engine, player.index, sq.groupNumber);
			return mine >= GROUP_SIZE[sq.groupNumber] - 1;
		},
		maxAuctionBid(engine, player, sq) {
			const mine = countInGroup(engine, player.index, sq.groupNumber);
			// Only mortgage to bid when advancing toward a group
			const wallet = mine >= 1 ? mortgageableValue(engine, player) : player.money;
			if (wallet < 300) return 0;
			let mult = 0.9;
			if (sq.groupNumber > 2 && mine >= 1) {
				mult = 1.4;    // bid above face when it completes a set
			}
			const cap = Math.floor(sq.price * mult);
			return Math.max(0, Math.min(cap, wallet - 300));
		},
		wantBuildHouses(engine, player) {
			if (player.money < 350) return [];
			const out = [];
			for (const sq of engine.squares) {
				if (sq.owner !== player.index) continue;
				if (ownsMonopoly(engine, player, sq.groupNumber)) out.push(sq.index);
			}
			// Go up to 3 houses per group per turn — leave cash for rent shocks
			return out.concat(out).concat(out);
		},
		wantUnmortgage(engine, player) {
			const debt = getMortgageDebt(engine, player);
			if (player.money < 600 || debt < 200) return [];
			const out = [];
			for (const sq of engine.squares) {
				if (sq.owner === player.index && sq.mortgage) out.push(sq.index);
			}
			return out;
		},
	},

	// ---------- PASSIVE ---------- buys NOTHING, just hoards cash
	Passive: {
		name: 'Passive',
		wantToBuy()         { return false; },
		wantLeveragedBuy()  { return false; },
		maxAuctionBid()     { return 0; },
		wantBuildHouses()   { return []; },
		wantUnmortgage()    { return []; },
	},
};

// =============================================================
// 11. Game runner
// =============================================================
function playGame(template, rng, options, playerConfigs) {
	playerConfigs = playerConfigs || [
		{ name: 'Shark',      strategy: strategies.Shark },
		{ name: 'Careful',    strategy: strategies.Careful },
		{ name: 'Monopolist', strategy: strategies.Monopolist },
	];
	const engine = createEngine(template, playerConfigs, rng, options);

	// Optional: give player 1 a starting color group
	if (options.boostGroup) {
		var grp = parseInt(options.boostGroup);
		var p1 = engine.players[0];
		for (var si = 0; si < engine.squares.length; si++) {
			if (engine.squares[si].groupNumber === grp && engine.squares[si].owner === 0) {
				engine.squares[si].owner = p1.index;
				p1.money -= engine.squares[si].price;
			}
		}
	}

	const maxRounds = options.maxRounds || 200;

	for (engine.round = 1; engine.round <= maxRounds; engine.round++) {
		// Check bubble at start of each round
		checkBubble(engine);

		for (const player of engine.players) {
			if (player.bankrupt) continue;
			takeTurn(engine, player);
		}

		// End crisis after one round of elevated interest
		endCrisis(engine);

		// Snapshot timeline at end of each round
		snapshotTimeline(engine);

		const alive = engine.players.filter(p => !p.bankrupt);
		if (alive.length <= 1) break;
	}

	const alive = engine.players.filter(p => !p.bankrupt);
	let winner;
	if (alive.length === 1) {
		winner = alive[0];
	} else if (alive.length === 0) {
		// Everyone bankrupt (rare — catastrophe edge case). Pick last to go bankrupt.
		let latest = engine.players[0];
		for (const p of engine.players) {
			if ((p.bankruptRound || 0) > (latest.bankruptRound || 0)) latest = p;
		}
		winner = latest;
	} else {
		let best = -Infinity;
		for (const p of alive) {
			const nw = netWorth(engine, p);
			if (nw > best) { best = nw; winner = p; }
		}
	}

	return {
		winner: winner.name,
		winnerIndex: winner.index - 1,  // 0-based index into players array
		rounds: engine.round > maxRounds ? maxRounds : engine.round,
		capped: alive.length > 1,
		crises: engine.totalCrises,
		players: engine.players.map(p => ({
			name: p.name,
			bankrupt: p.bankrupt,
			bankruptRound: p.bankruptRound,
			finalCash: p.money,
			finalNetWorth: netWorth(engine, p),
			totalInterestPaid: p.totalInterestPaid,
			totalRentPaid: p.totalRentPaid,
			totalRentReceived: p.totalRentReceived,
			lapsCompleted: p.lapsCompleted,
			housesBuilt: p.housesBuilt,
			mortgagesTaken: p.mortgagesTaken,
			peakDebt: p.peakDebt,
			marginCallsReceived: p.marginCallsReceived,
			propertiesForeclosed: p.propertiesForeclosed,
			totalCostOfLivingPaid: p.totalCostOfLivingPaid,
			totalCatastrophePaid: p.totalCatastrophePaid || 0,
			totalPropertyTaxPaid: p.totalPropertyTaxPaid || 0,
			snipesUsed: p.snipesUsed || 0,
			casinoBets: p.casinoBets || 0,
			casinoWinnings: p.casinoWinnings || 0,
			casinoLosses: p.casinoLosses || 0,
		})),
		timeline: engine.timeline,
		events: engine.events,
	};
}

// =============================================================
// 12. Main — CLI + aggregate reporting
// =============================================================
function main() {
	const args = process.argv.slice(2);
	const opts = { games: 500, maxRounds: 200, seed: 12345, verbose: false };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--games') opts.games = parseInt(args[++i], 10);
		else if (args[i] === '--max-rounds') opts.maxRounds = parseInt(args[++i], 10);
		else if (args[i] === '--seed') opts.seed = parseInt(args[++i], 10);
		else if (args[i] === '--verbose') opts.verbose = true;
		else if (args[i] === '--interest') INTEREST_RATE = parseFloat(args[++i]);
		else if (args[i] === '--dscr-floor') DSCR_FLOOR = parseFloat(args[++i]);
		else if (args[i] === '--dscr-borrow') DSCR_BORROW = parseFloat(args[++i]);
		else if (args[i] === '--no-margin-call') MARGIN_CALL_ENABLED = false;
		else if (args[i] === '--no-leverage') LEVERAGE_ENABLED = false;
		else if (args[i] === '--no-cost-of-living') COST_OF_LIVING_ENABLED = false;
		else if (args[i] === '--no-events') EVENTS_ENABLED = false;
		else if (args[i] === '--no-casino') CASINO_ENABLED_SIM = false;
		else if (args[i] === '--bubble-threshold') BUBBLE_THRESHOLD = parseInt(args[++i], 10);
		else if (args[i] === '--crisis-mult') CRISIS_INTEREST_MULT = parseFloat(args[++i]);
		else if (args[i] === '--catastrophe-mult') CATASTROPHE_MULT = parseInt(args[++i], 10);
		else if (args[i] === '--tax-per-house') TAX_PER_HOUSE = parseInt(args[++i], 10);
		else if (args[i] === '--tax-per-hotel') TAX_PER_HOTEL = parseInt(args[++i], 10);
		else if (args[i] === '--passive') opts.passive = true;
		else if (args[i] === '--boost-group') opts.boostGroup = args[++i];
		else if (args[i] === '--four-mono') opts.fourMono = true;
		else if (args[i] === '--help' || args[i] === '-h') {
			console.log('Usage: node sim/tycoon-sim.js [--games N] [--max-rounds R] [--seed S] [--interest 0.10] [--dscr-floor 1.0] [--dscr-borrow 2.0] [--no-margin-call] [--no-leverage] [--no-cost-of-living] [--no-events] [--bubble-threshold 1500] [--crisis-mult 2.5] [--catastrophe-mult 5] [--tax-per-house 40] [--tax-per-hotel 115] [--verbose]');
			process.exit(0);
		}
	}

	var defaultPlayerConfigs;
	if (opts.fourMono) {
		defaultPlayerConfigs = [
			{ name: 'Mono-Orange', strategy: strategies.Monopolist },
			{ name: 'Mono-2',     strategy: strategies.Monopolist },
			{ name: 'Mono-3',     strategy: strategies.Monopolist },
			{ name: 'Mono-4',     strategy: strategies.Monopolist },
		];
	} else {
		defaultPlayerConfigs = [
			{ name: 'Shark',      strategy: strategies.Shark },
			{ name: 'Careful',    strategy: strategies.Careful },
			{ name: 'Monopolist', strategy: strategies.Monopolist },
		];
	}
	if (opts.passive) {
		defaultPlayerConfigs.push({ name: 'Passive', strategy: strategies.Passive });
	}

	const template = loadSquares();
	console.log('Tycoon Saigon — Headless Simulation');
	console.log(`Games: ${opts.games}, max rounds: ${opts.maxRounds}, seed: ${opts.seed}`);
	console.log('Strategies: Shark (aggressive) • Careful (conservative) • Monopolist (strategic)');
	console.log(`Interest rate: ${(INTEREST_RATE * 100).toFixed(0)}% on mortgage debt / lap`);
	console.log(`Margin call: ${MARGIN_CALL_ENABLED ? `ENABLED (floor DSCR ${DSCR_FLOOR.toFixed(2)})` : 'DISABLED'}`);
	console.log(`Cost of living: ${COST_OF_LIVING_ENABLED ? 'ENABLED (first_roll × lap, per pass-GO)' : 'DISABLED'}`);
	console.log(`Events: ${EVENTS_ENABLED ? `ENABLED (bubble threshold $${BUBBLE_THRESHOLD}, crisis ${CRISIS_INTEREST_MULT}× interest)` : 'DISABLED'}`);
	if (EVENTS_ENABLED) {
		console.log(`  Catastrophe: ${CATASTROPHE_MULT}× dice roll  |  Property Tax: $${TAX_PER_HOUSE}/house, $${TAX_PER_HOTEL}/hotel  |  Snipe card: 1 in Chance deck`);
	}
	console.log();

	const NAMES = defaultPlayerConfigs.map(function(c) { return c.name; });
	const agg = {};
	for (const n of NAMES) {
		agg[n] = {
			wins: 0, gamesPlayed: 0,
			totalInterest: 0, totalNetWorth: 0, totalRentReceived: 0, totalRentPaid: 0,
			totalHouses: 0, totalMortgages: 0, totalPeakDebt: 0,
			bankruptcies: 0, bankruptRounds: [],
			totalMarginCalls: 0, totalForeclosures: 0,
			totalCostOfLiving: 0,
			totalCatastrophe: 0, totalPropertyTax: 0, totalSnipes: 0,
			totalCasinoBets: 0, totalCasinoWinnings: 0, totalCasinoLosses: 0,
		};
	}
	let totalRounds = 0, cappedGames = 0, totalCrises = 0;

	const rng = makeRng(opts.seed);
	const progressEvery = Math.max(1, Math.floor(opts.games / 20));

	for (let g = 1; g <= opts.games; g++) {
		const result = playGame(template, rng, opts, defaultPlayerConfigs);
		agg[result.winner].wins++;
		totalRounds += result.rounds;
		if (result.capped) cappedGames++;
		totalCrises += result.crises || 0;
		for (const p of result.players) {
			const a = agg[p.name];
			a.gamesPlayed++;
			a.totalInterest += p.totalInterestPaid;
			a.totalNetWorth += p.finalNetWorth;
			a.totalRentReceived += p.totalRentReceived;
			a.totalRentPaid += p.totalRentPaid;
			a.totalHouses += p.housesBuilt;
			a.totalMortgages += p.mortgagesTaken;
			a.totalPeakDebt += p.peakDebt;
			a.totalMarginCalls += p.marginCallsReceived || 0;
			a.totalForeclosures += p.propertiesForeclosed || 0;
			a.totalCostOfLiving += p.totalCostOfLivingPaid || 0;
			a.totalCatastrophe += p.totalCatastrophePaid || 0;
			a.totalPropertyTax += p.totalPropertyTaxPaid || 0;
			a.totalSnipes += p.snipesUsed || 0;
			a.totalCasinoBets += p.casinoBets || 0;
			a.totalCasinoWinnings += p.casinoWinnings || 0;
			a.totalCasinoLosses += p.casinoLosses || 0;
			if (p.bankrupt) {
				a.bankruptcies++;
				a.bankruptRounds.push(p.bankruptRound);
			}
		}
		if (opts.verbose || g % progressEvery === 0 || g === opts.games) {
			process.stdout.write(`\rProgress: ${g}/${opts.games}  `);
		}
	}
	process.stdout.write('\n\n');

	console.log('='.repeat(100));
	console.log('AGGREGATE RESULTS');
	console.log('='.repeat(100));
	console.log(`Games played: ${opts.games}   •   Avg game length: ${(totalRounds / opts.games).toFixed(1)} rounds   •   ` +
	            `Hit round cap: ${cappedGames} (${(cappedGames / opts.games * 100).toFixed(1)}%)`);
	console.log();

	const pad = (s, w, left) => left ? String(s).padEnd(w) : String(s).padStart(w);
	const header =
		pad('Strategy', 12, true) +
		pad('Wins', 6) + '  ' +
		pad('Win%', 7) + '  ' +
		pad('AvgNetWorth', 13) + '  ' +
		pad('AvgInterest', 13) + '  ' +
		pad('AvgPeakDebt', 13) + '  ' +
		pad('Bankrupt%', 11) + '  ' +
		pad('AvgBRound', 11);
	console.log(header);
	console.log('-'.repeat(header.length));
	for (const name of NAMES) {
		const a = agg[name];
		const winPct = (a.wins / opts.games * 100).toFixed(1) + '%';
		const avgNw  = '$' + Math.round(a.totalNetWorth / a.gamesPlayed).toLocaleString();
		const avgInt = '$' + Math.round(a.totalInterest / a.gamesPlayed).toLocaleString();
		const avgPk  = '$' + Math.round(a.totalPeakDebt / a.gamesPlayed).toLocaleString();
		const brPct  = (a.bankruptcies / a.gamesPlayed * 100).toFixed(1) + '%';
		const avgBr  = a.bankruptRounds.length
			? (a.bankruptRounds.reduce((s, x) => s + x, 0) / a.bankruptRounds.length).toFixed(1)
			: '—';
		console.log(
			pad(name, 12, true) +
			pad(a.wins, 6) + '  ' +
			pad(winPct, 7) + '  ' +
			pad(avgNw, 13) + '  ' +
			pad(avgInt, 13) + '  ' +
			pad(avgPk, 13) + '  ' +
			pad(brPct, 11) + '  ' +
			pad(avgBr, 11)
		);
	}
	console.log();

	// Secondary table: economy
	console.log('Secondary metrics');
	console.log('-'.repeat(70));
	console.log(pad('Strategy', 12, true) + pad('AvgRentPaid', 14) + pad('AvgRentRcvd', 14) + pad('AvgHouses', 12) + pad('AvgMortgages', 16) + pad('AvgCOL', 12));
	for (const name of NAMES) {
		const a = agg[name];
		console.log(
			pad(name, 12, true) +
			pad('$' + Math.round(a.totalRentPaid / a.gamesPlayed).toLocaleString(), 14) +
			pad('$' + Math.round(a.totalRentReceived / a.gamesPlayed).toLocaleString(), 14) +
			pad((a.totalHouses / a.gamesPlayed).toFixed(1), 12) +
			pad((a.totalMortgages / a.gamesPlayed).toFixed(1), 16) +
			pad('$' + Math.round(a.totalCostOfLiving / a.gamesPlayed).toLocaleString(), 12)
		);
	}
	console.log();

	// Tertiary table: margin call activity
	console.log('Margin call activity');
	console.log('-'.repeat(70));
	console.log(pad('Strategy', 12, true) + pad('MarginCalls/game', 20) + pad('PropsForeclosed/game', 24) + pad('% games w/ margin call', 24));
	for (const name of NAMES) {
		const a = agg[name];
		const mcPerGame = (a.totalMarginCalls / a.gamesPlayed).toFixed(2);
		const fcPerGame = (a.totalForeclosures / a.gamesPlayed).toFixed(2);
		// Heuristic: games with at least one margin call ≈ totalMarginCalls / avg MCs per affected game
		// But we don't track per-game directly; report raw total rate instead.
		const mcRate = (a.totalMarginCalls / a.gamesPlayed * 100).toFixed(1) + '%';
		console.log(
			pad(name, 12, true) +
			pad(mcPerGame, 20) +
			pad(fcPerGame, 24) +
			pad(mcRate, 24)
		);
	}
	console.log();

	// Event cards table
	if (EVENTS_ENABLED) {
		console.log('Event card impact');
		console.log('-'.repeat(80));
		console.log(pad('Strategy', 12, true) + pad('AvgCatastrophe', 16) + pad('AvgPropTax', 14) + pad('SnipesUsed', 14));
		for (const name of NAMES) {
			const a = agg[name];
			console.log(
				pad(name, 12, true) +
				pad('$' + Math.round(a.totalCatastrophe / a.gamesPlayed).toLocaleString(), 16) +
				pad('$' + Math.round(a.totalPropertyTax / a.gamesPlayed).toLocaleString(), 14) +
				pad((a.totalSnipes / a.gamesPlayed).toFixed(2), 14)
			);
		}
		console.log();
		console.log(`Financial crises triggered: ${totalCrises} total (${(totalCrises / opts.games).toFixed(2)} per game avg)`);
		console.log();
	}

	// Casino stats
	if (CASINO_ENABLED_SIM) {
		console.log('Casino activity');
		console.log('-'.repeat(80));
		console.log(pad('Strategy', 12, true) + pad('AvgBets', 12) + pad('AvgWinnings', 14) + pad('AvgLosses', 12) + pad('Net/game', 12));
		for (const name of NAMES) {
			const a = agg[name];
			const avgBets = Math.round(a.totalCasinoBets / a.gamesPlayed);
			const avgWin = Math.round(a.totalCasinoWinnings / a.gamesPlayed);
			const avgLoss = Math.round(a.totalCasinoLosses / a.gamesPlayed);
			console.log(
				pad(name, 12, true) +
				pad('$' + avgBets, 12) +
				pad('$' + avgWin, 14) +
				pad('$' + avgLoss, 12) +
				pad('$' + (avgWin - avgLoss), 12)
			);
		}
		console.log();
	}
}

if (require.main === module) {
	main();
}

// Allow external scripts to override module-level config variables.
function configure(overrides) {
	if ('EVENTS_ENABLED' in overrides) EVENTS_ENABLED = overrides.EVENTS_ENABLED;
	if ('LEVERAGE_ENABLED' in overrides) LEVERAGE_ENABLED = overrides.LEVERAGE_ENABLED;
	if ('COST_OF_LIVING_ENABLED' in overrides) COST_OF_LIVING_ENABLED = overrides.COST_OF_LIVING_ENABLED;
	if ('MARGIN_CALL_ENABLED' in overrides) MARGIN_CALL_ENABLED = overrides.MARGIN_CALL_ENABLED;
	if ('BUBBLE_THRESHOLD' in overrides) BUBBLE_THRESHOLD = overrides.BUBBLE_THRESHOLD;
	if ('INTEREST_RATE' in overrides) INTEREST_RATE = overrides.INTEREST_RATE;
	if ('CRISIS_INTEREST_MULT' in overrides) CRISIS_INTEREST_MULT = overrides.CRISIS_INTEREST_MULT;
	if ('CASINO_ENABLED_SIM' in overrides) CASINO_ENABLED_SIM = overrides.CASINO_ENABLED_SIM;
}

module.exports = { loadSquares, playGame, strategies, makeRng, configure };
