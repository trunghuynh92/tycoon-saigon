// The purpose of this AI is not to be a relistic opponant, but to give an example of a vaild AI player.
function AITest(p) {
	this.alertList = "";

	// This variable is static, it is not related to each instance.
	this.constructor.count++;

	p.name = "AI Test " + this.constructor.count;

	// Decide whether to buy a property the AI landed on.
	// Return: boolean (true to buy).
	// Arguments:
	// index: the property's index (0-39).
	this.buyProperty = function(index) {
		console.log("buyProperty");
		var s = square[index];

		if (p.money > s.price + 50) {
			return true;
		} else {
			return false;
		}

	}

	// Determine the response to an offered trade.
	// Return: boolean/instanceof Trade: a valid Trade object to counter offer (with the AI as the recipient); false to decline; true to accept.
	// Arguments:
	// tradeObj: the proposed trade, an instanceof Trade, has the AI as the recipient.
	this.acceptTrade = function(tradeObj) {
		console.log("acceptTrade");

		var tradeValue = 0;
		var money = tradeObj.getMoney();
		var initiator = tradeObj.getInitiator();
		var recipient = tradeObj.getRecipient();
		var property = [];

		tradeValue += 10 * tradeObj.getCommunityChestJailCard();
		tradeValue += 10 * tradeObj.getChanceJailCard();

		tradeValue += money;

		for (var i = 0; i < 40; i++) {
			property[i] = tradeObj.getProperty(i);
			tradeValue += tradeObj.getProperty(i) * square[i].price * (square[i].mortgage ? 0.5 : 1);
		}

		console.log(tradeValue);

		var proposedMoney = 25 - tradeValue + money;

		if (tradeValue > 25) {
			return true;
		} else if (tradeValue >= -50 && initiator.money > proposedMoney) {

			return new Trade(initiator, recipient, proposedMoney, property, tradeObj.getCommunityChestJailCard(), tradeObj.getChanceJailCard());
		}

		return false;
	}

	// This function is called at the beginning of the AI's turn, before any dice are rolled. The purpose is to allow the AI to manage property and/or initiate trades.
	// Return: boolean: Must return true if and only if the AI proposed a trade.
	this.beforeTurn = function() {
		console.log("beforeTurn");
		var s;
		var allGroupOwned;
		var max;
		var leastHouseProperty;
		var leastHouseNumber;

		// Buy houses.
		for (var i = 0; i < 40; i++) {
			s = square[i];

			if (s.owner === p.index && s.groupNumber >= 3) {
				max = s.group.length;
				allGroupOwned = true;
				leastHouseNumber = 6; // No property will ever have 6 houses.

				for (var j = max - 1; j >= 0; j--) {
					if (square[s.group[j]].owner !== p.index) {
						allGroupOwned = false;
						break;
					}

					if (square[s.group[j]].house < leastHouseNumber) {
						leastHouseProperty = square[s.group[j]];
						leastHouseNumber = leastHouseProperty.house;
					}
				}

				if (!allGroupOwned) {
					continue;
				}

				if (p.money > leastHouseProperty.houseprice + 100) {
					buyHouse(leastHouseProperty.index);
				}


			}
		}

		// Unmortgage property
		for (var i = 39; i >= 0; i--) {
			s = square[i];

			if (s.owner === p.index && s.mortgage && p.money > s.price) {
				unmortgage(i);
			}
		}

		return false;
	}

	var utilityForRailroadFlag = true; // Don't offer this trade more than once.


	// This function is called every time the AI lands on a square. The purpose is to allow the AI to manage property and/or initiate trades.
	// Return: boolean: Must return true if and only if the AI proposed a trade.
	this.onLand = function() {
		console.log("onLand");
		var proposedTrade;
		var property = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		var railroadIndexes = [5, 15, 25, 35];
		var requestedRailroad;
		var offeredUtility;
		var s;

		// If AI owns exactly one utility, try to trade it for a railroad.
		for (var i = 0; i < 4; i++) {
			s = square[railroadIndexes[i]];

			if (s.owner !== 0 && s.owner !== p.index) {
				requestedRailroad = s.index;
				break;
			}
		}

		if (square[12].owner === p.index && square[28].owner !== p.index) {
			offeredUtility = 12;
		} else if (square[28].owner === p.index && square[12].owner !== p.index) {
			offeredUtility = 28;
		}

		if (utilityForRailroadFlag && game.getDie(1) !== game.getDie(2) && requestedRailroad && offeredUtility) {
			utilityForRailroadFlag = false;
			property[requestedRailroad] = -1;
			property[offeredUtility] = 1;

			proposedTrade = new Trade(p, player[square[requestedRailroad].owner], 0, property, 0, 0)

			game.trade(proposedTrade);
			return true;
		}

		return false;
	}

	// Determine whether to post bail/use get out of jail free card (if in possession).
	// Return: boolean: true to post bail/use card.
	this.postBail = function() {
		console.log("postBail");

		// p.jailroll === 2 on third turn in jail.
		if ((p.communityChestJailCard || p.chanceJailCard) && p.jailroll === 2) {
			return true;
		} else {
			return false;
		}
	}

	// Mortgage enough properties to pay debt.
	// Return: void: don't return anything, just call the functions mortgage()/sellhouse()
	this.payDebt = function() {
		console.log("payDebt");
		for (var i = 39; i >= 0; i--) {
			s = square[i];

			if (s.owner === p.index && !s.mortgage && s.house === 0) {
				mortgage(i);
				console.log(s.name);
			}

			if (p.money >= 0) {
				return;
			}
		}

	}

	// Determine what to bid during an auction.
	// Return: integer: -1 for exit auction, 0 for pass, a positive value for the bid.
	this.bid = function(property, currentBid) {
		var bid = currentBid + (Math.floor(Math.random() * 3) + 1) * 10;
		var reserve = 50;
		// During fire sales, be more aggressive — properties go cheap
		if (typeof game !== "undefined" && game.getLiquidation && game.getLiquidation()) reserve = 10;
		if (p.money < bid + reserve || bid > square[property].price * 1.5) {
			return -1;
		} else {
			return bid;
		}
	}

	this.casinoBet = function() { return aiCasinoBet(p); };
}

// ============================================================================
// Tycoon Saigon — Smarter AI strategies (Shark / Careful / Monopolist)
// ============================================================================
// Emergent-evaluation approach: each turn, every color group is scored for
// expected ROI given ownership, contested state, and remaining acquisition
// cost. Each personality applies different weights and thresholds to the same
// underlying scoring machinery.
// ============================================================================

// Per-lap landing frequency multipliers by group. Derived from the classic
// Monopoly Markov-chain result that Orange is the most-landed group thanks to
// the Jail→roll-7 peak, with Red just behind. Values are approximate per-square
// landings per lap per opponent — used only as relative weights in scoring.
var GROUP_LANDING_FREQ = {
	1:  0.110, // transit hubs (railroads)
	2:  0.085, // utilities
	3:  0.085, // brown
	4:  0.100, // light blue
	5:  0.110, // pink
	6:  0.130, // ORANGE — post-jail sweet spot
	7:  0.115, // RED
	8:  0.108, // yellow
	9:  0.100, // green
	10: 0.090  // dark blue
};

// Expected group size (how many squares make up a monopoly).
var GROUP_SIZE_MAP = {
	1: 4, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 2
};

// --------------------------------------------------------------------------
// Helpers shared by all personality AIs.
// --------------------------------------------------------------------------

// Count how many squares of a given group a player owns.
function aiCountInGroup(playerIndex, groupNumber) {
	var count = 0;
	for (var i = 0; i < 40; i++) {
		if (square[i].groupNumber === groupNumber && square[i].owner === playerIndex) count++;
	}
	return count;
}

// Does a player own the complete monopoly for this group?
function aiOwnsMonopoly(playerIndex, groupNumber) {
	return aiCountInGroup(playerIndex, groupNumber) === GROUP_SIZE_MAP[groupNumber];
}

// Count opponents that hold at least one square in a group.
function aiOpponentsInGroup(playerIndex, groupNumber) {
	var opponents = {};
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.groupNumber === groupNumber && s.owner > 0 && s.owner !== playerIndex) {
			opponents[s.owner] = true;
		}
	}
	return Object.keys(opponents).length;
}

// List unowned squares in a group.
function aiUnownedInGroup(groupNumber) {
	var list = [];
	for (var i = 0; i < 40; i++) {
		if (square[i].groupNumber === groupNumber && square[i].owner === 0) list.push(i);
	}
	return list;
}

// Estimate a group's long-run rent per lap assuming current ownership AND
// current development. This is the emergent "what is this group worth to me".
function aiEstimateGroupRentPerLap(playerIndex, groupNumber, numOpponents) {
	var freq = GROUP_LANDING_FREQ[groupNumber] || 0.10;
	var total = 0;
	var mono = aiOwnsMonopoly(playerIndex, groupNumber);
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.groupNumber !== groupNumber || s.owner !== playerIndex || s.mortgage) continue;
		var rent;
		if (groupNumber === 1) {
			var n = aiCountInGroup(playerIndex, 1);
			rent = 25 * Math.pow(2, n - 1);
		} else if (groupNumber === 2) {
			var u = aiCountInGroup(playerIndex, 2);
			rent = 7 * (u === 2 ? 10 : 4);
		} else if (s.hotel) {
			rent = s.rent5;
		} else if (s.house >= 1 && s.house <= 4) {
			rent = s['rent' + s.house];
		} else {
			rent = s.baserent * (mono ? 2 : 1);
		}
		total += rent * freq * numOpponents;
	}
	return total;
}

// Score a group's acquisition potential. Higher = more desirable to pursue.
// Factors in landing frequency, ownership progress, contest level, and cost.
function aiScoreGroup(playerIndex, groupNumber, numOpponents) {
	var size = GROUP_SIZE_MAP[groupNumber];
	var mine = aiCountInGroup(playerIndex, groupNumber);
	var opps = aiOpponentsInGroup(playerIndex, groupNumber);
	var freq = GROUP_LANDING_FREQ[groupNumber] || 0.10;

	// Base value = frequency × representative rent for the group
	// (we use the most expensive square as a proxy for group upside).
	var maxBaseRent = 0;
	var totalPrice = 0;
	var squaresInGroup = [];
	for (var i = 0; i < 40; i++) {
		if (square[i].groupNumber === groupNumber) {
			squaresInGroup.push(i);
			totalPrice += square[i].price;
			if (square[i].baserent > maxBaseRent) maxBaseRent = square[i].baserent;
		}
	}
	var base = maxBaseRent * freq * numOpponents * 40; // scale factor to ~per-game value

	// Ownership factor — exponential near completion.
	var ownership = mine / size;
	var ownershipMultiplier = Math.pow(ownership + 0.2, 2);

	// Contest penalty — each opponent with a piece drags the score down.
	// If a single opponent holds a blocking square, the penalty is moderate.
	// If multiple opponents are split across, the group is basically dead.
	var contestPenalty = 1;
	if (opps === 1 && mine < size - 1) contestPenalty = 0.5;
	else if (opps === 1 && mine === size - 1) contestPenalty = 0.35;  // single blocker — hard to pry
	else if (opps >= 2) contestPenalty = 0.15;

	// Cost penalty — more expensive groups take longer to build out.
	var costPenalty = 300 / (300 + totalPrice);

	return base * ownershipMultiplier * contestPenalty * costPenalty;
}

// Rank all 10 groups by score, return sorted array of {group, score}.
function aiRankGroups(playerIndex, numOpponents) {
	var ranked = [];
	for (var g = 1; g <= 10; g++) {
		ranked.push({ group: g, score: aiScoreGroup(playerIndex, g, numOpponents) });
	}
	ranked.sort(function(a, b) { return b.score - a.score; });
	return ranked;
}

// The group a player is closest to completing (most owned pieces), used by
// trade logic to decide what to request.
function aiBestProgressGroup(playerIndex) {
	var best = null;
	var bestOwned = 0;
	for (var g = 3; g <= 10; g++) {
		var owned = aiCountInGroup(playerIndex, g);
		var size = GROUP_SIZE_MAP[g];
		if (owned >= size) continue;                // already complete
		if (owned > bestOwned) {
			bestOwned = owned;
			best = g;
		}
	}
	return best;
}

// Find an opponent who holds exactly the piece we need for best-progress group.
// Returns {playerIndex, squareIndex} or null.
function aiFindMissingPieceOwner(playerIndex, groupNumber) {
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.groupNumber === groupNumber && s.owner !== 0 && s.owner !== playerIndex) {
			return { playerIndex: s.owner, squareIndex: i };
		}
	}
	return null;
}

// Total unmortgaged value of a player's undeveloped properties — useful for
// knowing how much cash a player could raise via voluntary mortgaging.
function aiRaisableCash(player) {
	var total = 0;
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner === player.index && !s.mortgage && s.house === 0 && s.hotel === 0) {
			total += Math.round(s.price * MORTGAGE_VALUE);
		}
	}
	return total;
}

// Count active opponents (not bankrupt).
function aiCountActiveOpponents(player) {
	var n = 0;
	for (var i = 1; i <= pcount; i++) {
		if (player && i === player.index) continue;
		// A bankrupt player has money set < 0 and usually creditor -1 post-settle.
		// Safest check: they still hold no properties AND money < 0.
		var hasAnything = false;
		for (var j = 0; j < 40; j++) {
			if (square[j].owner === i) { hasAnything = true; break; }
		}
		if (hasAnything || player[i] && player[i].money >= 0) n++;
	}
	if (n === 0) n = 1; // avoid divide-by-zero
	return n;
}

// Smart payDebt — sell houses first (preserves monopolies longest), then
// mortgage from least-valuable group upward. Used by all smart AIs.
function aiSmartPayDebt(p) {
	// Step 1: sell houses evenly across monopolies, most-developed groups first.
	var safety = 50;
	while (p.money < 0 && safety-- > 0) {
		var bestSquare = null;
		var bestHouses = 0;
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			if (s.owner !== p.index) continue;
			var h = s.house + (s.hotel ? 5 : 0);
			if (h > bestHouses) {
				bestHouses = h;
				bestSquare = i;
			}
		}
		if (!bestSquare || bestHouses === 0) break;
		sellHouse(bestSquare);
	}

	// Step 2: mortgage non-monopoly, undeveloped squares first (smallest price).
	if (p.money < 0) {
		var candidates = [];
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			if (s.owner !== p.index || s.mortgage) continue;
			if (s.house > 0 || s.hotel > 0) continue;
			candidates.push(i);
		}
		// Sort: non-monopoly first, then ascending price.
		candidates.sort(function(a, b) {
			var sa = square[a], sb = square[b];
			var ma = aiOwnsMonopoly(p.index, sa.groupNumber) ? 1 : 0;
			var mb = aiOwnsMonopoly(p.index, sb.groupNumber) ? 1 : 0;
			if (ma !== mb) return ma - mb;
			return sa.price - sb.price;
		});
		for (var k = 0; k < candidates.length && p.money < 0; k++) {
			mortgage(candidates[k]);
		}
	}

	// Step 3: last resort — mortgage monopolies too.
	if (p.money < 0) {
		for (var i = 0; i < 40 && p.money < 0; i++) {
			var s = square[i];
			if (s.owner !== p.index || s.mortgage) continue;
			if (s.house > 0 || s.hotel > 0) continue;
			mortgage(i);
		}
	}
}

// Voluntary mortgage helper — raise up to targetCash by mortgaging from
// lowest-value non-monopoly squares. Used by Shark/Monopolist for leverage.
function aiRaiseCashByMortgaging(p, targetCash) {
	if (p.money >= targetCash) return true;
	var candidates = [];
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner !== p.index || s.mortgage) continue;
		if (s.house > 0 || s.hotel > 0) continue;
		// Monopoly rule: can't mortgage if any property in the color group has buildings.
		var groupHasBuildings = false;
		if (s.group && s.group.length > 0) {
			for (var g = 0; g < s.group.length; g++) {
				var gs = square[s.group[g]];
				if (gs.house > 0 || gs.hotel > 0) { groupHasBuildings = true; break; }
			}
		}
		if (groupHasBuildings) continue;
		// Don't mortgage a square that IS in a monopoly we own (protects income).
		if (aiOwnsMonopoly(p.index, s.groupNumber)) continue;
		candidates.push(i);
	}
	candidates.sort(function(a, b) { return square[a].price - square[b].price; });
	for (var k = 0; k < candidates.length && p.money < targetCash; k++) {
		mortgage(candidates[k]);
	}
	return p.money >= targetCash;
}

// Rough net worth: cash + property face values - mortgage debt.
// Used for Casino and other strategic decisions.
function aiNetWorth(playerIndex) {
	var total = player[playerIndex].money;
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner !== playerIndex) continue;
		total += s.price;
		total += s.house * s.houseprice;
		total += s.hotel * s.houseprice;
		if (s.mortgage) total -= Math.round(s.price * 0.55); // unmortgage cost
	}
	return total;
}

// Player's net worth rank (1 = richest). Used for Casino AI.
function aiWealthRank(playerIndex) {
	var myNW = aiNetWorth(playerIndex);
	var rank = 1;
	for (var i = 1; i <= pcount; i++) {
		if (i === playerIndex || player[i].bankrupt) continue;
		if (aiNetWorth(i) > myNW) rank++;
	}
	return rank;
}

// Tax Audit AI: play the card if opponents have more buildings than you
function aiPlayTaxAudit(p) {
	if (!p.taxAuditCard) return false;
	var myBuildings = 0, oppBuildings = 0;
	for (var i = 0; i < 40; i++) {
		if (square[i].owner === p.index) {
			myBuildings += square[i].hotel ? 5 : square[i].house;
		} else if (square[i].owner > 0) {
			oppBuildings += square[i].hotel ? 5 : square[i].house;
		}
	}
	if (oppBuildings > myBuildings + 3) {
		playTaxAuditCard();
		return true;
	}
	return false;
}

// Casino AI: returns tier index (0-5), or -1 to skip.
// Trailing players bet big, leading players don't gamble.
function aiCasinoBet(p) {
	if (typeof CASINO_ENABLED === 'undefined' || !CASINO_ENABLED) return -1;
	var rank = aiWealthRank(p.index);
	var alive = 0;
	for (var i = 1; i <= pcount; i++) {
		if (!player[i].bankrupt) alive++;
	}
	// Leading player: don't gamble
	if (rank === 1) return -1;
	// Last place: go big or go home
	if (rank === alive) {
		if (p.money >= 60) return 5;      // $60 — double 6
		if (p.money >= 50) return 4;      // $50 — double 5+
		if (p.money >= 40) return 3;      // $40 — double 4+
		if (p.money >= 30) return 2;
		if (p.money >= 20) return 1;
		if (p.money >= 10) return 0;
		return -1;
	}
	// Middle of the pack: moderate bet
	if (p.money >= 30) return 2;          // $30 — double 3+
	if (p.money >= 20) return 1;
	if (p.money >= 10) return 0;
	return -1;
}

// Calculate how much cash a player could have after mortgaging non-monopoly,
// un-housed properties.  DSCR-aware: simulates mortgages cumulatively and
// checks each one wouldn't breach the bank's lending threshold.
function aiMortgageableValue(playerIndex) {
	var p = player[playerIndex];
	var candidates = [];
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner !== playerIndex || s.mortgage) continue;
		if (s.house > 0 || s.hotel > 0) continue;
		// Can't mortgage if any property in the color group has buildings.
		var groupHasBuildings = false;
		if (s.group && s.group.length > 0) {
			for (var g = 0; g < s.group.length; g++) {
				var gs = square[s.group[g]];
				if (gs.house > 0 || gs.hotel > 0) { groupHasBuildings = true; break; }
			}
		}
		if (groupHasBuildings) continue;
		if (aiOwnsMonopoly(playerIndex, s.groupNumber)) continue;
		candidates.push(i);
	}
	// Sort cheapest first (minimise collateral usage)
	candidates.sort(function(a, b) { return square[a].price - square[b].price; });

	// Simulate mortgaging cumulatively, check DSCR each step
	var extra = 0;
	var simulated = [];
	for (var k = 0; k < candidates.length; k++) {
		var s = square[candidates[k]];
		s.mortgage = true;
		simulated.push(s);
		var postDSCR = getDSCR(p);
		if (postDSCR < DSCR_BORROW) {
			s.mortgage = false;
			simulated.pop();
			break; // bank would refuse — stop here
		}
		extra += Math.floor(s.price / 2);
	}
	// Undo all simulated mortgages
	for (var k = 0; k < simulated.length; k++) {
		simulated[k].mortgage = false;
	}
	return p.money + extra;
}

// Build a property request array for a Trade object.
function aiMakePropertyArray() {
	var arr = [];
	for (var i = 0; i < 40; i++) arr[i] = 0;
	return arr;
}

// Find a "throwaway" property to sweeten a trade — a low-value square NOT in
// a group the AI is building toward, and not part of a monopoly.
function aiFindSweetener(playerIndex, excludeGroup) {
	var candidates = [];
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner !== playerIndex) continue;
		if (s.mortgage || s.house > 0 || s.hotel) continue;
		if (s.groupNumber === excludeGroup) continue;
		if (s.groupNumber <= 2) continue;  // don't trade rails/utilities as sweetener
		if (aiOwnsMonopoly(playerIndex, s.groupNumber)) continue;
		// Don't trade away if we own size-1 (almost monopoly)
		if (aiCountInGroup(playerIndex, s.groupNumber) >= GROUP_SIZE_MAP[s.groupNumber] - 1) continue;
		candidates.push(i);
	}
	// Sort by price ascending — offer cheapest as sweetener
	candidates.sort(function(a, b) { return square[a].price - square[b].price; });
	return candidates.length > 0 ? candidates[0] : -1;
}

// Build a counter-offer: "I'll sell you X, but I want $Y for it."
// Used by AIs when rejecting a trade that asks for their property.
function aiBuildCounterOffer(me, them, tradeObj, minAcceptCash) {
	// Find what they're asking for (flag === -1 means they want it from me)
	var requestedSquare = -1;
	for (var i = 0; i < 40; i++) {
		if (tradeObj.getProperty(i) === -1) { requestedSquare = i; break; }
	}
	if (requestedSquare < 0) return false;

	var s = square[requestedSquare];
	// Only counter-offer if they can afford the ask
	if (them.money < minAcceptCash) return false;
	// Cap the counter at what the initiator can pay
	var counterCash = Math.min(minAcceptCash, them.money - 100);
	if (counterCash <= 0) return false;

	// Build counter: I'll give you the property for $counterCash
	var propArr = aiMakePropertyArray();
	propArr[requestedSquare] = -1; // they still want it
	return new Trade(them, me, counterCash, propArr, 0, 0);
}

// ============================================================================
// AI Personality: SHARK — aggressive, leveraged, Orange-biased, quick to trade
// ============================================================================
function AIShark(p) {
	this.alertList = "";
	this.constructor.count = (this.constructor.count || 0) + 1;
	p.name = "Shark " + this.constructor.count;
	var tradedThisTurn = false;

	this.buyProperty = function(index) {
		var s = square[index];
		// Shark buys anything it can afford outright, and leverages for
		// groups it's already building toward.
		if (p.money >= s.price + 20) return true;

		// Leveraged buy: raise cash by mortgaging if the group is valuable.
		var mine = aiCountInGroup(p.index, s.groupNumber);
		if (mine >= 1 || s.groupNumber === 6 || s.groupNumber === 7) {
			if (aiRaiseCashByMortgaging(p, s.price + 20)) {
				return true;
			}
		}
		return false;
	};

	this.beforeTurn = function() {
		tradedThisTurn = false;
		if (aiPlayTaxAudit(p)) return true;

		// 1. Build houses on any completed monopoly, cheapest square first,
		//    evenly across the group (respects even-build).
		for (var g = 3; g <= 10; g++) {
			if (!aiOwnsMonopoly(p.index, g)) continue;
			var groupSquares = [];
			for (var i = 0; i < 40; i++) {
				if (square[i].groupNumber === g) groupSquares.push(i);
			}
			// Sort by current house count ascending, then price ascending.
			groupSquares.sort(function(a, b) {
				var sa = square[a], sb = square[b];
				if (sa.house !== sb.house) return sa.house - sb.house;
				return sa.price - sb.price;
			});
			// Build until out of cash or group is maxed.
			for (var k = 0; k < groupSquares.length; k++) {
				var s = square[groupSquares[k]];
				if (s.hotel) continue;
				if (s.house >= 4) continue;
				// Shark willing to leverage up to buy houses.
				if (p.money < s.houseprice + 50) {
					aiRaiseCashByMortgaging(p, s.houseprice + 50);
				}
				if (p.money >= s.houseprice + 20) {
					buyHouse(s.index);
				}
			}
		}

		// 2. Unmortgage high-value squares when flush with cash (keeps income up).
		if (p.money > 800) {
			for (var i = 0; i < 40; i++) {
				var s = square[i];
				if (s.owner === p.index && s.mortgage) {
					var cost = Math.round(s.price * UNMORTGAGE_COST);
					if (p.money - cost > 500) {
						unmortgage(i);
					}
				}
			}
		}

		// 3. Proactive trade — offer cash (+ a sweetener property) for the missing
		//    piece. Shark will mortgage low-value properties to fund the trade.
		var targetGroup = aiBestProgressGroup(p.index);
		if (targetGroup && aiCountInGroup(p.index, targetGroup) === GROUP_SIZE_MAP[targetGroup] - 1) {
			var miss = aiFindMissingPieceOwner(p.index, targetGroup);
			if (miss && !tradedThisTurn) {
				var offerSquare = square[miss.squareIndex];
				var idealOffer = Math.round(offerSquare.price * 1.5);

				// Shark mortgages to fund the trade if needed
				if (p.money - 100 < idealOffer) {
					aiRaiseCashByMortgaging(p, idealOffer + 100);
				}

				var cashAvailable = p.money - 100;
				var propArr = aiMakePropertyArray();
				propArr[miss.squareIndex] = -1;

				if (cashAvailable >= idealOffer) {
					var trade = new Trade(p, player[miss.playerIndex], idealOffer, propArr, 0, 0);
					tradedThisTurn = true;
					game.trade(trade);
					return true;
				} else if (cashAvailable >= offerSquare.price * 0.8) {
					// Cash-short even after mortgage — add a sweetener
					var sweetener = aiFindSweetener(p.index, targetGroup);
					if (sweetener >= 0) {
						propArr[sweetener] = 1;
						var trade = new Trade(p, player[miss.playerIndex], cashAvailable, propArr, 0, 0);
						tradedThisTurn = true;
						game.trade(trade);
						return true;
					}
				}
			}
		}
		return false;
	};

	this.onLand = function() {
		return false;
	};

	// Shark accepts any trade with positive immediate value OR that unlocks a
	// monopoly completion for them. If rejecting, counter-offers with a higher price.
	this.acceptTrade = function(tradeObj) {
		var netValue = tradeObj.getMoney();
		var completesMonopolyForMe = false;
		var breaksMyMonopoly = false;
		var requestedSquareIdx = -1;

		for (var i = 0; i < 40; i++) {
			var s = square[i];
			var flag = tradeObj.getProperty(i);
			if (flag === 1) {
				netValue += s.price * (s.mortgage ? 0.45 : 1.0);
				var willOwn = aiCountInGroup(p.index, s.groupNumber) + 1;
				if (willOwn === GROUP_SIZE_MAP[s.groupNumber]) completesMonopolyForMe = true;
			} else if (flag === -1) {
				netValue -= s.price * (s.mortgage ? 0.5 : 1.1);
				requestedSquareIdx = i;
				if (aiOwnsMonopoly(p.index, s.groupNumber)) breaksMyMonopoly = true;
			}
		}

		if (completesMonopolyForMe) return true;
		if (breaksMyMonopoly && netValue < 200) {
			// Counter: demand premium to break our monopoly
			if (requestedSquareIdx >= 0) {
				var counter = aiBuildCounterOffer(p, tradeObj.getInitiator(), tradeObj, Math.round(square[requestedSquareIdx].price * 2.0));
				if (counter) return counter;
			}
			return false;
		}
		if (netValue >= 0) return true;
		if (p.lapsCompleted >= 10 && netValue >= -100) return true;

		// Reject but counter-offer: tell them what we'd actually accept
		if (requestedSquareIdx >= 0) {
			var minAccept = Math.round(square[requestedSquareIdx].price * 1.2);
			var counter = aiBuildCounterOffer(p, tradeObj.getInitiator(), tradeObj, minAccept);
			if (counter) return counter;
		}
		return false;
	};

	this.postBail = function() {
		// Shark leaves jail early — wants to be earning/spending.
		if ((p.communityChestJailCard || p.chanceJailCard) && p.jailroll >= 1) return true;
		return p.jailroll >= 2;
	};

	this.payDebt = function() {
		aiSmartPayDebt(p);
	};

	this.bid = function(propertyIndex, currentBid) {
		var s = square[propertyIndex];
		var mine = aiCountInGroup(p.index, s.groupNumber);
		var isFireSale = typeof game !== "undefined" && game.getLiquidation && game.getLiquidation();
		var maxBid = s.price + (mine >= 1 ? Math.round(s.price * 0.5) : 0);
		// During fire sales, always willing to mortgage and bid aggressively
		var reserve = isFireSale ? 20 : 100;
		var affordable = (mine >= 1 || isFireSale ? aiMortgageableValue(p.index) : p.money) - reserve;
		var nextBid = currentBid + (Math.floor(Math.random() * 3) + 1) * 10;
		if (nextBid > maxBid || nextBid > affordable) return -1;
		return nextBid;
	};

	this.casinoBet = function() { return aiCasinoBet(p); };
}
AIShark.count = 0;

// ============================================================================
// AI Personality: CAREFUL — conservative, no leverage, rarely trades
// ============================================================================
function AICareful(p) {
	this.alertList = "";
	this.constructor.count = (this.constructor.count || 0) + 1;
	p.name = "Careful " + this.constructor.count;

	this.buyProperty = function(index) {
		var s = square[index];
		// Only buy if cash stays comfortable afterward.
		return p.money >= s.price + 400;
	};

	this.beforeTurn = function() {
		if (aiPlayTaxAudit(p)) return true;
		// Build houses, but only when very flush AND only on completed monopolies.
		for (var g = 3; g <= 10; g++) {
			if (!aiOwnsMonopoly(p.index, g)) continue;
			var groupSquares = [];
			for (var i = 0; i < 40; i++) {
				if (square[i].groupNumber === g) groupSquares.push(i);
			}
			groupSquares.sort(function(a, b) {
				var sa = square[a], sb = square[b];
				if (sa.house !== sb.house) return sa.house - sb.house;
				return sa.price - sb.price;
			});
			for (var k = 0; k < groupSquares.length; k++) {
				var s = square[groupSquares[k]];
				if (s.hotel || s.house >= 4) continue;
				// Careful requires a big cushion — 5× house price.
				if (p.money >= s.houseprice * 5) {
					buyHouse(s.index);
				}
			}
		}

		// Unmortgage when very safe.
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			if (s.owner === p.index && s.mortgage) {
				var cost = Math.round(s.price * UNMORTGAGE_COST);
				if (p.money - cost >= 600) unmortgage(i);
			}
		}

		// Careful never proposes trades.
		return false;
	};

	this.onLand = function() { return false; };

	this.acceptTrade = function(tradeObj) {
		// Careful only accepts trades where they come out clearly ahead in cash
		// AND where they aren't giving up a developed/monopoly square.
		var netValue = tradeObj.getMoney();
		var requestedSquareIdx = -1;
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			var flag = tradeObj.getProperty(i);
			if (flag === 1) {
				netValue += s.price * (s.mortgage ? 0.4 : 0.9);
			} else if (flag === -1) {
				netValue -= s.price * (s.mortgage ? 0.5 : 1.3);
				requestedSquareIdx = i;
				if (aiOwnsMonopoly(p.index, s.groupNumber)) {
					// Counter with extreme premium — Careful doesn't easily sell monopoly
					var counter = aiBuildCounterOffer(p, tradeObj.getInitiator(), tradeObj, Math.round(s.price * 3.5));
					if (counter) return counter;
					return false;
				}
				if (s.house > 0 || s.hotel) return false; // never sell developed
			}
		}
		if (netValue >= 75) return true;

		// Counter: Careful demands a generous premium
		if (requestedSquareIdx >= 0) {
			var minAccept = Math.round(square[requestedSquareIdx].price * 1.5);
			var counter = aiBuildCounterOffer(p, tradeObj.getInitiator(), tradeObj, minAccept);
			if (counter) return counter;
		}
		return false;
	};

	this.postBail = function() {
		// Careful prefers to stay in jail — safe, cheap, no rent exposure.
		if ((p.communityChestJailCard || p.chanceJailCard) && p.jailroll === 2) return true;
		return false;
	};

	this.payDebt = function() {
		aiSmartPayDebt(p);
	};

	this.bid = function(propertyIndex, currentBid) {
		var s = square[propertyIndex];
		var isFireSale = typeof game !== "undefined" && game.getLiquidation && game.getLiquidation();
		var maxBid = Math.round(s.price * (isFireSale ? 0.9 : 0.7));
		var nextBid = currentBid + (Math.floor(Math.random() * 2) + 1) * 10;
		// During fire sales, Careful loosens up — keeps only $50 reserve and will mortgage
		var reserve = isFireSale ? 50 : 500;
		var affordable = isFireSale ? aiMortgageableValue(p.index) - reserve : p.money - reserve;
		if (nextBid > maxBid || nextBid > affordable) return -1;
		return nextBid;
	};

	// Careful NEVER gambles at the casino
	this.casinoBet = function() { return -1; };
}
AICareful.count = 0;

// ============================================================================
// AI Personality: MONOPOLIST — emergent group-score driven, pivots away from
// contested groups, tries to complete the highest-score available monopoly.
// ============================================================================
function AIMonopolist(p) {
	this.alertList = "";
	this.constructor.count = (this.constructor.count || 0) + 1;
	p.name = "Monopolist " + this.constructor.count;
	var tradedThisTurn = false;

	// Helper: what's my current top-scored group target?
	function topTargetGroup() {
		var numOpp = 3; // approximate — we re-score per lap anyway
		var ranked = aiRankGroups(p.index, numOpp);
		return ranked.length ? ranked[0].group : null;
	}

	this.buyProperty = function(index) {
		var s = square[index];
		if (s.groupNumber === 0) return false;

		var mine = aiCountInGroup(p.index, s.groupNumber);
		var size = GROUP_SIZE_MAP[s.groupNumber];

		// Completion buy: mortgage to fund if this completes a monopoly!
		if (mine === size - 1 && s.groupNumber >= 3) {
			if (p.money < s.price + 100) {
				aiRaiseCashByMortgaging(p, s.price + 100);
			}
			if (p.money >= s.price + 50) return true;
		}

		// Always buy if it adds to an existing position.
		if (mine >= 1 && p.money >= s.price + 100) return true;

		// Buy unowned squares in the top-scored group if affordable.
		var target = topTargetGroup();
		if (s.groupNumber === target && p.money >= s.price + 100) return true;

		// Defensive buy: if an opponent is close to completing, deny them.
		var oppCount = 0;
		for (var pi = 1; pi <= pcount; pi++) {
			if (pi === p.index) continue;
			if (aiCountInGroup(pi, s.groupNumber) >= size - 1) oppCount++;
		}
		if (oppCount > 0 && p.money >= s.price + 200) return true;

		// Otherwise only buy if very affordable and decent group.
		return p.money >= s.price + 300;
	};

	this.beforeTurn = function() {
		tradedThisTurn = false;
		if (aiPlayTaxAudit(p)) return true;

		// 1. Build houses on completed monopolies — aggressively, within reason.
		for (var g = 3; g <= 10; g++) {
			if (!aiOwnsMonopoly(p.index, g)) continue;
			var groupSquares = [];
			for (var i = 0; i < 40; i++) {
				if (square[i].groupNumber === g) groupSquares.push(i);
			}
			groupSquares.sort(function(a, b) {
				var sa = square[a], sb = square[b];
				if (sa.house !== sb.house) return sa.house - sb.house;
				return sa.price - sb.price;
			});
			for (var k = 0; k < groupSquares.length; k++) {
				var s = square[groupSquares[k]];
				if (s.hotel || s.house >= 4) continue;
				// Monopolist is willing to leverage for houses, but more
				// carefully than Shark — keeps a $200 cushion.
				if (p.money < s.houseprice + 200) {
					aiRaiseCashByMortgaging(p, s.houseprice + 200);
				}
				if (p.money >= s.houseprice + 150) {
					buyHouse(s.index);
				}
			}
		}

		// 2. Unmortgage selectively — prefer squares that belong to a group
		//    we're building toward.
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			if (s.owner !== p.index || !s.mortgage) continue;
			var cost = Math.round(s.price * UNMORTGAGE_COST);
			if (p.money - cost > 400) {
				unmortgage(i);
			}
		}

		// 3. Proactive trade — use score-based targeting. Find the highest-
		//    ranked group we can potentially COMPLETE via a single trade.
		//    Monopolist will mortgage to fund trade if needed (more cautious than Shark).
		var ranked = aiRankGroups(p.index, pcount - 1);
		for (var r = 0; r < ranked.length && !tradedThisTurn; r++) {
			var g = ranked[r].group;
			if (g === 1 || g === 2) continue;
			var mine = aiCountInGroup(p.index, g);
			var size = GROUP_SIZE_MAP[g];
			if (mine !== size - 1) continue;
			var miss = aiFindMissingPieceOwner(p.index, g);
			if (!miss) continue;
			var offerSquare = square[miss.squareIndex];
			var idealOffer = Math.round(offerSquare.price * 1.75);

			// Monopolist mortgages to fund trade, but keeps a bigger reserve than Shark
			if (p.money - 200 < idealOffer) {
				aiRaiseCashByMortgaging(p, idealOffer + 200);
			}

			var cashAvailable = p.money - 200;
			var propArr = aiMakePropertyArray();
			propArr[miss.squareIndex] = -1;

			if (cashAvailable >= idealOffer) {
				var trade = new Trade(p, player[miss.playerIndex], idealOffer, propArr, 0, 0);
				tradedThisTurn = true;
				game.trade(trade);
				return true;
			} else if (cashAvailable >= offerSquare.price * 0.7) {
				var sweetener = aiFindSweetener(p.index, g);
				if (sweetener >= 0) {
					propArr[sweetener] = 1;
					var trade = new Trade(p, player[miss.playerIndex], cashAvailable, propArr, 0, 0);
					tradedThisTurn = true;
					game.trade(trade);
					return true;
				}
			}
		}
		return false;
	};

	this.onLand = function() { return false; };

	this.acceptTrade = function(tradeObj) {
		var netValue = tradeObj.getMoney();
		var completesMonopolyForMe = false;
		var completesMonopolyForThem = false;
		var initiator = tradeObj.getInitiator();
		var requestedSquareIdx = -1;

		for (var i = 0; i < 40; i++) {
			var s = square[i];
			var flag = tradeObj.getProperty(i);
			if (flag === 1) {
				netValue += s.price * (s.mortgage ? 0.45 : 1.0);
				var willOwn = aiCountInGroup(p.index, s.groupNumber) + 1;
				if (willOwn === GROUP_SIZE_MAP[s.groupNumber]) completesMonopolyForMe = true;
			} else if (flag === -1) {
				netValue -= s.price * (s.mortgage ? 0.45 : 1.1);
				requestedSquareIdx = i;
				if (aiOwnsMonopoly(p.index, s.groupNumber)) {
					// Never give up monopoly — counter with extreme premium
					var counter = aiBuildCounterOffer(p, initiator, tradeObj, Math.round(s.price * 3.0));
					if (counter) return counter;
					return false;
				}
				var theirCount = aiCountInGroup(initiator.index, s.groupNumber) + 1;
				if (theirCount === GROUP_SIZE_MAP[s.groupNumber]) completesMonopolyForThem = true;
			}
		}

		if (completesMonopolyForMe && !completesMonopolyForThem) return true;
		if (completesMonopolyForThem && netValue < 300) {
			// They're completing a monopoly — demand big premium via counter
			if (requestedSquareIdx >= 0) {
				var counter = aiBuildCounterOffer(p, initiator, tradeObj, Math.round(square[requestedSquareIdx].price * 2.0));
				if (counter) return counter;
			}
			return false;
		}
		if (completesMonopolyForThem && netValue >= 300) return true;
		if (netValue >= 50) return true;

		// Reject but counter with what we'd accept
		if (requestedSquareIdx >= 0) {
			var minAccept = Math.round(square[requestedSquareIdx].price * 1.3);
			var counter = aiBuildCounterOffer(p, initiator, tradeObj, minAccept);
			if (counter) return counter;
		}
		return false;
	};

	this.postBail = function() {
		// Mid-game: post bail to keep earning. Late game (COL > salary): camp.
		if (p.lapsCompleted >= 28) return false;
		if ((p.communityChestJailCard || p.chanceJailCard) && p.jailroll >= 1) return true;
		return p.jailroll >= 2;
	};

	this.payDebt = function() {
		aiSmartPayDebt(p);
	};

	this.bid = function(propertyIndex, currentBid) {
		var s = square[propertyIndex];
		var mine = aiCountInGroup(p.index, s.groupNumber);
		var size = GROUP_SIZE_MAP[s.groupNumber];
		var isFireSale = typeof game !== "undefined" && game.getLiquidation && game.getLiquidation();
		var maxBid;
		if (mine === size - 1) maxBid = Math.round(s.price * 1.75);     // premium for completion
		else if (mine >= 1)     maxBid = Math.round(s.price * 1.1);
		else                    maxBid = Math.round(s.price * (isFireSale ? 1.0 : 0.9));
		// During fire sales, always willing to mortgage for deals
		var reserve = isFireSale ? 30 : 200;
		var affordable = (mine >= 1 || isFireSale ? aiMortgageableValue(p.index) : p.money) - reserve;
		var nextBid = currentBid + (Math.floor(Math.random() * 3) + 1) * 10;
		if (nextBid > maxBid || nextBid > affordable) return -1;
		return nextBid;
	};

	this.casinoBet = function() { return aiCasinoBet(p); };
}
AIMonopolist.count = 0;

// ============================================================
// AIClaude — Uses Claude API for trade negotiation decisions.
// Falls back to AIMonopolist-style rule-based logic for all
// non-trade decisions (buy, build, mortgage, etc.).
// ============================================================

var CLAUDE_API_KEY = ""; // Set from setup screen

// Serialize the full game state into a concise text block for Claude's context.
function serializeGameState(myPlayer) {
	var lines = [];
	lines.push("=== TYCOON SAIGON — GAME STATE ===");
	lines.push("You are: " + myPlayer.name + " (index " + myPlayer.index + ")");
	lines.push("Your cash: $" + myPlayer.money);

	// Calculate my debt
	var myDebt = 0;
	for (var i = 0; i < 40; i++) {
		if (square[i].owner === myPlayer.index && square[i].mortgage) {
			myDebt += Math.round(square[i].price * MORTGAGE_VALUE);
		}
	}
	lines.push("Your debt: $" + myDebt);
	if (myDebt > 0) lines.push("Your DSCR: " + getDSCR(myPlayer).toFixed(2));

	// My properties
	var myProps = [];
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner === myPlayer.index) {
			var desc = s.name + " (group " + s.groupNumber + ", price $" + s.price;
			if (s.mortgage) desc += ", MORTGAGED";
			if (s.hotel) desc += ", HOTEL";
			else if (s.house > 0) desc += ", " + s.house + " houses";
			desc += ", rent $" + s.baserent + ")";
			myProps.push(desc);
		}
	}
	lines.push("\nYour properties (" + myProps.length + "):");
	if (myProps.length === 0) lines.push("  (none)");
	else for (var i = 0; i < myProps.length; i++) lines.push("  " + myProps[i]);

	// My monopolies
	var myMonopolies = [];
	for (var g = 3; g <= 10; g++) {
		if (aiOwnsMonopoly(myPlayer.index, g)) myMonopolies.push(g);
	}
	if (myMonopolies.length > 0) lines.push("Your completed color groups: " + myMonopolies.join(", "));

	// Other players
	lines.push("\n--- OTHER PLAYERS ---");
	for (var pi = 1; pi <= pcount; pi++) {
		if (pi === myPlayer.index) continue;
		var op = player[pi];
		var oppDebt = 0, oppProps = [], oppMonopolies = [];
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			if (s.owner === pi) {
				oppDebt += s.mortgage ? Math.round(s.price * MORTGAGE_VALUE) : 0;
				var desc = s.name + " (g" + s.groupNumber + ", $" + s.price;
				if (s.mortgage) desc += ", MTG";
				if (s.hotel) desc += ", HTL";
				else if (s.house > 0) desc += ", " + s.house + "H";
				desc += ")";
				oppProps.push(desc);
			}
		}
		for (var g = 3; g <= 10; g++) {
			if (aiOwnsMonopoly(pi, g)) oppMonopolies.push(g);
		}
		lines.push(op.name + ": cash $" + op.money + ", debt $" + oppDebt +
			", props: " + (oppProps.length > 0 ? oppProps.join("; ") : "none") +
			(oppMonopolies.length > 0 ? ", monopolies: " + oppMonopolies.join(",") : ""));
	}

	// Group completion info — who is close to completing what
	lines.push("\n--- GROUP COMPLETION STATUS ---");
	for (var g = 3; g <= 10; g++) {
		var size = GROUP_SIZE_MAP[g];
		var owners = {};
		var groupNames = [];
		for (var i = 0; i < 40; i++) {
			if (square[i].groupNumber === g) {
				groupNames.push(square[i].name);
				var ow = square[i].owner;
				if (ow > 0) owners[ow] = (owners[ow] || 0) + 1;
			}
		}
		var parts = [];
		for (var ow in owners) {
			parts.push(player[ow].name + " owns " + owners[ow] + "/" + size);
		}
		if (parts.length > 0) {
			lines.push("Group " + g + " (" + groupNames.join(", ") + "): " + parts.join(", "));
		}
	}

	// Financial crisis status
	if (typeof crisisActive !== "undefined" && crisisActive) {
		lines.push("\n*** FINANCIAL CRISIS IS ACTIVE — interest rates are 2.5x normal! ***");
	}

	return lines.join("\n");
}

// Serialize a trade proposal into readable text for Claude.
function serializeTradeForClaude(tradeObj, perspective) {
	// perspective: "recipient" (you're being offered) or "initiator" (you proposed)
	var initiator = tradeObj.getInitiator();
	var recipient = tradeObj.getRecipient();
	var money = tradeObj.getMoney();
	var lines = [];

	lines.push("=== TRADE PROPOSAL ===");
	lines.push("From: " + initiator.name + " → To: " + recipient.name);

	var offered = [], requested = [];
	for (var i = 0; i < 40; i++) {
		var flag = tradeObj.getProperty(i);
		if (flag === 1) offered.push(square[i].name + " (g" + square[i].groupNumber + ", $" + square[i].price + (square[i].mortgage ? ", MTG" : "") + ")");
		if (flag === -1) requested.push(square[i].name + " (g" + square[i].groupNumber + ", $" + square[i].price + (square[i].mortgage ? ", MTG" : "") + ")");
	}

	if (money > 0) lines.push("Cash offered: $" + money);
	if (money < 0) lines.push("Cash requested: $" + Math.abs(money));
	if (offered.length > 0) lines.push("Properties offered: " + offered.join(", "));
	if (requested.length > 0) lines.push("Properties requested: " + requested.join(", "));
	if (tradeObj.getCommunityChestJailCard() === 1) lines.push("Offering: Community Chest jail card");
	if (tradeObj.getCommunityChestJailCard() === -1) lines.push("Requesting: Community Chest jail card");
	if (tradeObj.getChanceJailCard() === 1) lines.push("Offering: Chance jail card");
	if (tradeObj.getChanceJailCard() === -1) lines.push("Requesting: Chance jail card");

	return lines.join("\n");
}

// Call Claude API. Returns a Promise resolving to the response text.
// If CLAUDE_API_KEY is set (local dev via apikey.local.js), calls Anthropic directly.
// Otherwise routes through /api/claude-trade (Vercel Function proxy).
function callClaudeAPI(systemPrompt, userMessage) {
	if (CLAUDE_API_KEY) {
		return fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": CLAUDE_API_KEY,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-20250514",
				max_tokens: 512,
				system: systemPrompt,
				messages: [{ role: "user", content: userMessage }]
			})
		}).then(function(response) {
			if (!response.ok) {
				return response.text().then(function(t) {
					throw new Error("Claude API error " + response.status + ": " + t);
				});
			}
			return response.json();
		}).then(function(data) {
			return data.content[0].text;
		});
	}

	return fetch("/api/claude-trade", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ system: systemPrompt, userMessage: userMessage })
	}).then(function(response) {
		if (!response.ok) {
			return response.text().then(function(t) {
				throw new Error("Claude API error " + response.status + ": " + t);
			});
		}
		return response.json();
	}).then(function(data) {
		return data.text;
	});
}

function AIClaude(p) {
	this.alertList = "";
	this.constructor.count = (this.constructor.count || 0) + 1;
	p.name = "Claude " + this.constructor.count;
	var tradedThisTurn = false;

	// ---- Rule-based decisions (delegated to Monopolist-style logic) ----

	this.buyProperty = function(index) {
		var s = square[index];
		if (s.groupNumber === 0) return false;
		var mine = aiCountInGroup(p.index, s.groupNumber);
		var size = GROUP_SIZE_MAP[s.groupNumber];

		// Completion buy
		if (mine === size - 1 && s.groupNumber >= 3) {
			if (p.money < s.price + 100) aiRaiseCashByMortgaging(p, s.price + 100);
			if (p.money >= s.price + 50) return true;
		}
		if (mine >= 1 && p.money >= s.price + 100) return true;
		// Defensive buy
		for (var pi = 1; pi <= pcount; pi++) {
			if (pi === p.index) continue;
			if (aiCountInGroup(pi, s.groupNumber) >= size - 1 && p.money >= s.price + 200) return true;
		}
		return p.money >= s.price + 300;
	};

	this.beforeTurn = function() {
		tradedThisTurn = false;
		if (aiPlayTaxAudit(p)) return true;

		// 1. Build houses on monopolies
		for (var g = 3; g <= 10; g++) {
			if (!aiOwnsMonopoly(p.index, g)) continue;
			var groupSquares = [];
			for (var i = 0; i < 40; i++) {
				if (square[i].groupNumber === g) groupSquares.push(i);
			}
			groupSquares.sort(function(a, b) {
				return square[a].house - square[b].house || square[a].price - square[b].price;
			});
			for (var k = 0; k < groupSquares.length; k++) {
				var s = square[groupSquares[k]];
				if (s.hotel || s.house >= 4) continue;
				if (p.money < s.houseprice + 200) aiRaiseCashByMortgaging(p, s.houseprice + 200);
				if (p.money >= s.houseprice + 150) buyHouse(s.index);
			}
		}

		// 2. Unmortgage
		for (var i = 0; i < 40; i++) {
			var s = square[i];
			if (s.owner !== p.index || !s.mortgage) continue;
			var cost = Math.round(s.price * UNMORTGAGE_COST);
			if (p.money - cost > 400) unmortgage(i);
		}

		// 3. Proactive trade (rule-based, same as Monopolist)
		var ranked = aiRankGroups(p.index, pcount - 1);
		for (var r = 0; r < ranked.length && !tradedThisTurn; r++) {
			var g = ranked[r].group;
			if (g === 1 || g === 2) continue;
			var mine = aiCountInGroup(p.index, g);
			var size = GROUP_SIZE_MAP[g];
			if (mine !== size - 1) continue;
			var miss = aiFindMissingPieceOwner(p.index, g);
			if (!miss) continue;
			var offerSquare = square[miss.squareIndex];
			var idealOffer = Math.round(offerSquare.price * 1.75);
			if (p.money - 200 < idealOffer) aiRaiseCashByMortgaging(p, idealOffer + 200);
			var cashAvailable = p.money - 200;
			var propArr = aiMakePropertyArray();
			propArr[miss.squareIndex] = -1;
			if (cashAvailable >= idealOffer) {
				var trade = new Trade(p, player[miss.playerIndex], idealOffer, propArr, 0, 0);
				tradedThisTurn = true;
				game.trade(trade);
				return true;
			} else if (cashAvailable >= offerSquare.price * 0.7) {
				var sweetener = aiFindSweetener(p.index, g);
				if (sweetener >= 0) {
					propArr[sweetener] = 1;
					var trade = new Trade(p, player[miss.playerIndex], cashAvailable, propArr, 0, 0);
					tradedThisTurn = true;
					game.trade(trade);
					return true;
				}
			}
		}
		return false;
	};

	this.onLand = function() { return false; };

	// ---- Claude-powered trade evaluation (ASYNC) ----

	this.acceptTrade = function(tradeObj) {
		// Return "pending" to signal async handling.
		// The trade resolution is handled via claudeEvaluateTrade().
		return "pending";
	};

	// Called by the async trade handler in monopoly.js
	this.evaluateTradeAsync = function(tradeObj) {
		var gameState = serializeGameState(p);
		var tradeSummary = serializeTradeForClaude(tradeObj, "recipient");

		var systemPrompt = [
			"You are an expert Monopoly/Tycoon Saigon player evaluating a trade offer.",
			"Your goal is to WIN the game (last player standing). Consider:",
			"- Does this trade help you complete a color group (monopoly)?",
			"- Does it help your opponent complete a monopoly more than it helps you?",
			"- Is the cash fair relative to the property values and strategic position?",
			"- Your debt/DSCR situation — can you afford this?",
			"- If Financial Crisis is active, cash is king — be more conservative.",
			"",
			"You MUST respond with EXACTLY one of these JSON formats:",
			'{"decision": "accept", "reason": "brief reason"}',
			'{"decision": "reject", "reason": "brief reason"}',
			'{"decision": "counter", "cash": <number>, "reason": "brief reason"}',
			"",
			"For counter: specify the MINIMUM cash you'd accept for the requested property.",
			"If they offered property + cash, counter with the cash amount you want instead.",
			"Only respond with the JSON object, nothing else."
		].join("\n");

		var userMessage = gameState + "\n\n" + tradeSummary + "\n\nShould you accept, reject, or counter this trade?";

		return callClaudeAPI(systemPrompt, userMessage).then(function(responseText) {
			try {
				// Extract JSON from response (Claude sometimes wraps in markdown)
				var jsonMatch = responseText.match(/\{[\s\S]*\}/);
				if (!jsonMatch) throw new Error("No JSON found");
				var result = JSON.parse(jsonMatch[0]);
				return result;
			} catch (e) {
				console.error("Claude response parse error:", e, responseText);
				// Fallback: reject if we can't parse
				return { decision: "reject", reason: "Could not parse AI response" };
			}
		}).catch(function(err) {
			console.error("Claude API call failed:", err);
			// Fallback to simple rule-based evaluation
			return claudeFallbackAcceptTrade(p, tradeObj);
		});
	};

	this.payDebt = function() {
		aiRaiseCashByMortgaging(p, 1);
		if (p.money >= 0) return true;
		return false;
	};

	this.postBail = function() {
		if (p.lapsCompleted >= 28) return false;
		if ((p.communityChestJailCard || p.chanceJailCard) && p.jailroll >= 1) return true;
		return p.jailroll >= 2;
	};

	this.bid = function(propertyIndex, currentBid) {
		var s = square[propertyIndex];
		var mine = aiCountInGroup(p.index, s.groupNumber);
		var size = GROUP_SIZE_MAP[s.groupNumber];
		var isFireSale = typeof game !== "undefined" && game.getLiquidation && game.getLiquidation();
		var maxBid;
		if (mine === size - 1) maxBid = Math.round(s.price * 1.75);
		else if (mine >= 1)     maxBid = Math.round(s.price * 1.1);
		else                    maxBid = Math.round(s.price * (isFireSale ? 1.0 : 0.9));
		var reserve = isFireSale ? 30 : 200;
		var affordable = (mine >= 1 || isFireSale ? aiMortgageableValue(p.index) : p.money) - reserve;
		var nextBid = currentBid + (Math.floor(Math.random() * 3) + 1) * 10;
		if (nextBid > maxBid || nextBid > affordable) return -1;
		return nextBid;
	};

	this.casinoBet = function() { return aiCasinoBet(p); };
}
AIClaude.count = 0;

// Simple rule-based fallback for when Claude API fails.
function claudeFallbackAcceptTrade(me, tradeObj) {
	var netValue = tradeObj.getMoney();
	var requestedSquareIdx = -1;
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		var flag = tradeObj.getProperty(i);
		if (flag === 1) netValue += s.price * (s.mortgage ? 0.45 : 1.0);
		if (flag === -1) {
			netValue -= s.price * 1.2;
			requestedSquareIdx = i;
		}
	}
	if (netValue >= 0) return { decision: "accept", reason: "Fallback: positive value" };
	if (requestedSquareIdx >= 0) {
		return { decision: "counter", cash: Math.round(square[requestedSquareIdx].price * 1.5), reason: "Fallback: counter-offer" };
	}
	return { decision: "reject", reason: "Fallback: negative value" };
}
