#!/usr/bin/env node
/**
 * 4-Monopolist simulation
 * Question: If a player achieves at least 1 monopoly, what is their win rate?
 *
 * Uses housesBuilt > 0 as proxy for "achieved a monopoly" (you can only
 * build houses once you own all properties in a color group).
 *
 * Usage: node sim/four-monopolist-sim.js [games] [seed]
 */

const { loadSquares, playGame, strategies, makeRng, configure } = require('./tycoon-sim.js');

const args = process.argv.slice(2);
const VANILLA = args.includes('--vanilla');
const GAMES = parseInt(args.find(a => /^\d+$/.test(a)) || '3000', 10);
const SEED  = parseInt(args.filter(a => /^\d+$/.test(a))[1] || '42', 10);

if (VANILLA) {
	configure({
		EVENTS_ENABLED: false,
		LEVERAGE_ENABLED: false,
		COST_OF_LIVING_ENABLED: false,
		MARGIN_CALL_ENABLED: false,
	});
}

const template = loadSquares();
const rng = makeRng(SEED);

const playerConfigs = [
	{ name: 'Monopolist 1', strategy: strategies.Monopolist },
	{ name: 'Monopolist 2', strategy: strategies.Monopolist },
	{ name: 'Monopolist 3', strategy: strategies.Monopolist },
	{ name: 'Monopolist 4', strategy: strategies.Monopolist },
];

const MODE = VANILLA ? 'VANILLA (no events, no leverage, no COL)' : 'TYCOON SAIGON (all mechanics)';
console.log(`4-Monopolist Simulation — ${GAMES} games, seed ${SEED}`);
console.log(`Mode: ${MODE}\n`);

// Tracking
let withMono_total = 0, withMono_wins = 0;
let noMono_total = 0, noMono_wins = 0;

// How many monopoly-holders per game distribution
const monoHoldersPerGame = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };

// Houses-built distribution for winners vs losers
let winnerHousesTotal = 0, loserHousesTotal = 0, loserCount = 0;

// Win rate by house count bucket
const houseBuckets = { '0': { total: 0, wins: 0 }, '1-3': { total: 0, wins: 0 }, '4-8': { total: 0, wins: 0 }, '9+': { total: 0, wins: 0 } };

function houseBucket(h) {
	if (h === 0) return '0';
	if (h <= 3) return '1-3';
	if (h <= 8) return '4-8';
	return '9+';
}

for (let g = 1; g <= GAMES; g++) {
	const result = playGame(template, rng, { maxRounds: 200 }, playerConfigs);
	const wi = result.winnerIndex;

	let monoHolders = 0;
	for (let i = 0; i < result.players.length; i++) {
		const p = result.players[i];
		const hadMonopoly = p.housesBuilt > 0;
		const isWinner = (i === wi);

		if (hadMonopoly) {
			monoHolders++;
			withMono_total++;
			if (isWinner) withMono_wins++;
		} else {
			noMono_total++;
			if (isWinner) noMono_wins++;
		}

		if (isWinner) {
			winnerHousesTotal += p.housesBuilt;
		} else {
			loserHousesTotal += p.housesBuilt;
			loserCount++;
		}

		const bucket = houseBucket(p.housesBuilt);
		houseBuckets[bucket].total++;
		if (isWinner) houseBuckets[bucket].wins++;
	}

	monoHoldersPerGame[monoHolders]++;

	if (g % 500 === 0 || g === GAMES) {
		process.stdout.write(`\rProgress: ${g}/${GAMES}  `);
	}
}

const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : '—';
const pad = (s, w, left) => left ? String(s).padEnd(w) : String(s).padStart(w);

console.log('\n');
console.log('='.repeat(70));
console.log('4 MONOPOLISTS — MONOPOLY ACHIEVEMENT vs WIN RATE');
console.log('='.repeat(70));
console.log(`Games: ${GAMES}  |  Player-games: ${GAMES * 4}  |  Baseline win rate: 25.0%\n`);

console.log('KEY FINDING:');
console.log('─'.repeat(50));
console.log(`  Got ≥1 monopoly  →  Win rate: ${pct(withMono_wins, withMono_total)}   (${withMono_wins} wins / ${withMono_total} player-games)`);
console.log(`  Got 0 monopolies →  Win rate: ${pct(noMono_wins, noMono_total)}   (${noMono_wins} wins / ${noMono_total} player-games)`);
console.log();

console.log('HOW MANY PLAYERS GET A MONOPOLY PER GAME?');
console.log('─'.repeat(50));
for (let n = 0; n <= 4; n++) {
	const bar = '█'.repeat(Math.round(monoHoldersPerGame[n] / GAMES * 40));
	console.log(`  ${n} players: ${pad(monoHoldersPerGame[n], 5)} games (${pct(monoHoldersPerGame[n], GAMES)})  ${bar}`);
}
console.log();

console.log('WIN RATE BY HOUSES BUILT:');
console.log('─'.repeat(50));
console.log(`  ${pad('Houses', 8, true)}  ${pad('Player-games', 14)}  ${pad('Wins', 6)}  ${pad('Win Rate', 10)}`);
for (const [bucket, data] of Object.entries(houseBuckets)) {
	console.log(`  ${pad(bucket, 8, true)}  ${pad(data.total, 14)}  ${pad(data.wins, 6)}  ${pad(pct(data.wins, data.total), 10)}`);
}
console.log();

console.log('WINNER vs LOSER — AVG HOUSES BUILT:');
console.log('─'.repeat(50));
console.log(`  Winners: ${(winnerHousesTotal / GAMES).toFixed(1)} houses avg`);
console.log(`  Losers:  ${(loserHousesTotal / loserCount).toFixed(1)} houses avg`);
console.log();
