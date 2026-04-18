// ============================================================
// Tycoon Saigon — Analytics
// ============================================================
function trackEvent(name, data) {
	try { if (window.va) window.va("event", { name: name, data: data }); } catch(e) {}
}

// ============================================================
// Tycoon Saigon — Game Balance Constants
// Tune these during playtesting.
// ============================================================
var INTEREST_RATE = 0.10;       // 10% of outstanding mortgage debt per pass-GO
var GO_SALARY = 200;            // Salary collected for passing GO
var MORTGAGE_VALUE = 0.50;      // Mortgage pays 50% of property price
var UNMORTGAGE_COST = 0.55;     // Unmortgage costs 55% of property price (10% premium)
var COST_OF_LIVING_ENABLED = true; // Tycoon Saigon inflation tax: first_roll × lap count at each pass-GO

// ---- Tycoon Saigon Event System ----
var EVENTS_ENABLED = true;
var BUBBLE_THRESHOLD = 1000;     // Total system mortgage debt that triggers a financial crisis
var CRISIS_INTEREST_MULT = 2.5;  // Interest multiplier during crisis lap
var CATASTROPHE_MULT = 5;        // Catastrophe card: all players pay this × dice roll
var TAX_PER_HOUSE = 40;          // Property Tax Reassessment: per house
var TAX_PER_HOTEL = 115;         // Property Tax Reassessment: per hotel
// ---- Gameplay Timeline Log ----
var gameLog = [];                // Array of snapshots, one per turn
var turnCounter = 0;             // Global turn counter across all players
var originalPlayers = [];        // Saved at game start — never mutated
var eliminatedPlayers = {};      // playerName → last snapshot before elimination

var crisisActive = false;        // True during a bubble-pop round
var crisisRound = 0;             // Round the current crisis started
var lastCrisisRound = 0;         // Cooldown tracking
var gameRound = 0;               // Incremented each full player cycle

// ---- DSCR (Debt Service Coverage Ratio) & Margin Call ----
var DSCR_BORROW = 2.0;          // Bank refuses new mortgages if DSCR would drop below this
var DSCR_FLOOR = 1.0;           // Margin call fires when DSCR drops below this
var MARGIN_CALL_ENABLED = true;  // Master toggle for the margin call system

// ---- Casino (replaces Free Parking at position 20) ----
// ---- Trade Abuse Prevention ----
var TRADES_PER_TURN_LIMIT = 2;        // Max trade proposals per player per turn
var TRADE_COOLDOWN_TURNS = 3;         // Turns before you can re-propose to the same player after rejection
var humanTradesThisTurn = 0;          // Counter reset each turn
var tradeCooldowns = {};              // Key: "initiatorIdx-recipientIdx", value: turn number when cooldown expires
var lastRejectedTrade = null;         // Fingerprint of the last rejected trade for duplicate detection
var lastProposedFingerprint = null;   // Fingerprint of the current proposal (set in proposeTrade, used in cancelTrade)

var CASINO_ENABLED = true;
// Bet tiers: [bet amount, minimum double needed, payout multiplier]
var CASINO_TIERS = [
	{ bet: 10,  minDouble: 1, payout: 50,   pct: "16.7" },
	{ bet: 20,  minDouble: 2, payout: 120,  pct: "13.9" },
	{ bet: 30,  minDouble: 3, payout: 210,  pct: "11.1" },
	{ bet: 40,  minDouble: 4, payout: 320,  pct: "8.3" },
	{ bet: 50,  minDouble: 5, payout: 500,  pct: "5.6" },
	{ bet: 60,  minDouble: 6, payout: 1000, pct: "2.8" },
];
function getCasinoTierLabel(tier) {
	var key = tier.minDouble === 1 ? 'casino_tier_any' : (tier.minDouble === 6 ? 'casino_tier_only' : 'casino_tier_plus');
	return t(key, {bet: tier.bet, min: tier.minDouble, pct: tier.pct, payout: tier.payout});
}

// ------------------------------------------------------------
// Calculate a player's total outstanding mortgage debt.
// Mortgage debt = sum of (price * MORTGAGE_VALUE) for all
// mortgaged properties owned by the player.
// ------------------------------------------------------------
function getMortgageDebt(p) {
	var total = 0;
	for (var i = 0; i < 40; i++) {
		if (square[i].owner === p.index && square[i].mortgage) {
			total += Math.round(square[i].price * MORTGAGE_VALUE);
		}
	}
	return total;
}

// ------------------------------------------------------------
// Estimate a player's rent income per lap from all owned,
// unmortgaged properties. Uses base rent × monopoly mult,
// house rents, and dice-7 proxy for utilities.
// ------------------------------------------------------------
function getRentIncomePerLap(p) {
	var total = 0;
	for (var i = 0; i < 40; i++) {
		var sq = square[i];
		if (sq.owner !== p.index || sq.mortgage) continue;

		if (sq.groupNumber === 1) {
			// Hubs (railroads): 25, 50, 100, 200 based on count owned
			var n = 0;
			for (var j = 0; j < 40; j++) {
				if (square[j].groupNumber === 1 && square[j].owner === p.index) n++;
			}
			total += 25 * Math.pow(2, n - 1);
		} else if (sq.groupNumber === 2) {
			// Utilities: 4× or 10× dice, use 7 as average
			var n = 0;
			for (var j = 0; j < 40; j++) {
				if (square[j].groupNumber === 2 && square[j].owner === p.index) n++;
			}
			total += 7 * (n === 2 ? 10 : 4);
		} else if (sq.hotel) {
			total += sq.rent5;
		} else if (sq.house >= 1 && sq.house <= 4) {
			total += sq["rent" + sq.house];
		} else {
			// Unimproved: check for monopoly
			var groupOwned = true;
			for (var j = 0; j < 40; j++) {
				if (square[j].groupNumber === sq.groupNumber && square[j].owner !== p.index) {
					groupOwned = false;
					break;
				}
			}
			total += groupOwned ? sq.baserent * 2 : sq.baserent;
		}
	}
	return total;
}

// DSCR = (Salary + Rent Income) / Interest Expense
// Higher = safer. Below DSCR_FLOOR triggers margin call.
// Below DSCR_BORROW means bank refuses new mortgages.
function getDSCR(p) {
	var debt = getMortgageDebt(p);
	if (debt === 0) return Infinity;
	var interest = debt * INTEREST_RATE;
	if (interest === 0) return Infinity;
	return (GO_SALARY + getRentIncomePerLap(p)) / interest;
}

// ------------------------------------------------------------
// Margin call: fires at pass-GO when DSCR < DSCR_FLOOR.
// Bank forecloses the cheapest properties until DSCR recovers.
// Foreclosed properties go back to unowned (available for
// purchase by anyone who lands on them).
// ------------------------------------------------------------
function triggerMarginCall(p) {
	if (!MARGIN_CALL_ENABLED) return;

	var fired = false;
	var guard = 60;
	var foreclosedNames = [];

	while (guard-- > 0) {
		var dscr = getDSCR(p);
		if (dscr >= DSCR_FLOOR) break;

		// Priority 1: foreclose mortgaged properties (zero income loss)
		var mortgaged = [];
		for (var i = 0; i < 40; i++) {
			if (square[i].owner === p.index && square[i].mortgage) {
				mortgaged.push(i);
			}
		}
		if (mortgaged.length > 0) {
			mortgaged.sort(function(a, b) { return square[a].price - square[b].price; });
			var sq = square[mortgaged[0]];
			if (!fired) {
				addAlert(t('msg_margin_call', {name: p.name}));
				fired = true;
			}
			var clearedDebt = Math.round(sq.price * MORTGAGE_VALUE);
			addAlert(t('msg_foreclosure', {prop: sq.name, amount: clearedDebt}));
			foreclosedNames.push(sq.name);
			sq.owner = 0;
			sq.mortgage = false;
			sq.house = 0;
			sq.hotel = 0;
			continue;
		}

		// Priority 2: foreclose unmortgaged, undeveloped properties
		var unmortgaged = [];
		for (var i = 0; i < 40; i++) {
			var sq = square[i];
			if (sq.owner !== p.index) continue;
			if (sq.mortgage || sq.house > 0 || sq.hotel > 0) continue;
			unmortgaged.push(i);
		}
		if (unmortgaged.length > 0) {
			unmortgaged.sort(function(a, b) { return square[a].price - square[b].price; });
			var sq = square[unmortgaged[0]];
			if (!fired) {
				addAlert(t('msg_margin_call', {name: p.name}));
				fired = true;
			}
			addAlert(t('msg_foreclosure_unmortgaged', {prop: sq.name, amount: sq.price}));
			foreclosedNames.push(sq.name);
			sq.owner = 0;
			sq.mortgage = false;
			continue;
		}

		// Nothing left to foreclose — only built monopolies remain.
		// Let the interest payment push player into bankruptcy.
		break;
	}

	if (fired && typeof boardMsg === "function") {
		boardMsg(
			"<div style='background:#cc0000;color:white;padding:15px;border-radius:8px;'>"
			+ "<h3 style='margin-top:0;'>" + t('pop_margin_title') + "</h3>"
			+ "<p>" + t('pop_margin_desc', {name: p.name}) + "</p>"
			+ "<p>" + t('pop_margin_dscr') + "</p>"
			+ "<p><strong>" + t('pop_margin_foreclosed', {list: foreclosedNames.join(", ")}) + "</strong></p>"
			+ "</div>"
		);
	}

	if (fired) {
		updateOwned();
		updateMoney();
	}
}

// ------------------------------------------------------------
// Called at every pass-GO site. Pays salary, then deducts
// mortgage interest. If cash goes negative, sets creditor=0
// so the existing sell/mortgage/bankruptcy flow kicks in.
// ------------------------------------------------------------
function collectSalaryAndPayInterest(p, onDoneCallback) {
	p.money += GO_SALARY;
	p.lapsCompleted = (p.lapsCompleted || 0) + 1;
	addAlert(t('msg_salary', {name: p.name, amount: GO_SALARY}));

	// ---- Cost of living (Tycoon Saigon inflation tax) ----
	var costOfLiving = 0;
	if (COST_OF_LIVING_ENABLED) {
		var firstRoll = (typeof p.firstRollThisTurn === "number") ? p.firstRollThisTurn : 7;
		costOfLiving = firstRoll * p.lapsCompleted;
		p.money -= costOfLiving;
		addAlert(t('msg_col', {name: p.name, amount: costOfLiving, roll: firstRoll, lap: p.lapsCompleted}));

		if (typeof boardMsg === "function" && p.human) {
			boardMsg(
				"<div class='interest-alert'>"
				+ "<h3>" + t('pop_col_title') + "</h3>"
				+ "<p>" + t('pop_col_desc', {name: p.name}) + "</p>"
				+ "<p>" + t('pop_col_roll', {roll: firstRoll}) + "</p>"
				+ "<p>" + t('pop_col_lap', {lap: p.lapsCompleted}) + "</p>"
				+ "<p style='font-size:16px;font-weight:bold;color:#ff6666;'>" + t('pop_col_cost', {cost: costOfLiving}) + "</p>"
				+ "</div>",
				function() { collectSalaryAndPayInterest_phase2(p, costOfLiving, onDoneCallback); }
			);
			return true; // signals: showing blocking message, caller should NOT proceed
		}

		if (typeof updateMoney === "function") {
			updateMoney();
		}

		if (p.money < 0) {
			p.creditor = 0;
			addAlert(t('msg_col_debt', {name: p.name}));
		}
	}

	collectSalaryAndPayInterest_phase2(p, costOfLiving, onDoneCallback);
	return false; // no blocking message shown
}

function collectSalaryAndPayInterest_phase2(p, costOfLiving, onDoneCallback) {
	// ---- Margin call check (BEFORE interest) ----
	triggerMarginCall(p);

	// ---- Mortgage interest ----
	var totalMortgageDebt = getMortgageDebt(p);

	if (totalMortgageDebt > 0) {
		var effectiveRate = (crisisActive && EVENTS_ENABLED) ? INTEREST_RATE * CRISIS_INTEREST_MULT : INTEREST_RATE;
		var interest = Math.round(totalMortgageDebt * effectiveRate);
		p.money -= interest;
		var rateLabel = crisisActive ? Math.round(effectiveRate * 100) + "% (CRISIS!)" : Math.round(INTEREST_RATE * 100) + "%";
		addAlert(t('msg_interest', {name: p.name, interest: interest, debt: totalMortgageDebt, crisis: crisisActive ? t('msg_interest_crisis') : ''}));

		if (typeof boardMsg === "function" && p.human) {
			boardMsg(
				"<div class='interest-alert'" + (crisisActive ? " style='background:#ff4444;color:white;'" : "") + ">"
				+ "<h3>" + (crisisActive ? t('pop_interest_crisis_title') : t('pop_interest_title')) + "</h3>"
				+ "<p>" + t('pop_interest_desc', {name: p.name}) + "</p>"
				+ "<p>" + t('pop_interest_debt', {debt: totalMortgageDebt}) + "</p>"
				+ "<p style='font-size:16px;font-weight:bold;color:#ff6666;'>" + t('pop_interest_amount', {rate: rateLabel, interest: interest}) + "</p>"
				+ "<p>" + t('pop_interest_net', {net: (GO_SALARY - costOfLiving - interest)}) + "</p>"
				+ "</div>",
				onDoneCallback || function() {}
			);
			return;
		}

		if (typeof updateMoney === "function") {
			updateMoney();
		}

		if (p.money < 0) {
			p.creditor = 0;
			addAlert(t('msg_interest_debt', {name: p.name}));
		}
	}

	// No blocking message — call done callback immediately
	if (onDoneCallback) onDoneCallback();
}

function Game() {
	var die1;
	var die2;
	var areDiceRolled = false;

	var auctionQueue = [];
	var highestbidder;
	var highestbid;
	var currentbidder = 1;
	var auctionproperty;

	// === LIQUIDATION STATE ===
	// When a player can't pay a debt, ALL their properties go to auction.
	// Proceeds go directly to the player's cash. After all auctions,
	// if the player can cover the debt → pay & survive. Otherwise → eliminated.
	var liquidation = null;  // null when no liquidation active
	// Shape: { playerIndex, playerName, creditorIndex, creditorName, rentOwed }

	this.rollDice = function() {
		die1 = Math.floor(Math.random() * 6) + 1;
		die2 = Math.floor(Math.random() * 6) + 1;
		areDiceRolled = true;
	};

	this.resetDice = function() {
		areDiceRolled = false;
	};

	this.next = function() {
		if (!p.human && p.money < 0) {
			p.AI.payDebt();

			if (p.money < 0) {
				boardMsg("<p>" + t('pop_bankrupt', {name: p.name}) + "</p>", game.bankruptcy);
			} else {
				roll();
			}
		} else if (areDiceRolled && doublecount === 0) {
			play();
		} else {
			roll();
		}
	};

	this.getDie = function(die) {
		if (die === 1) {

			return die1;
		} else {

			return die2;
		}

	};



	// Auction functions:



	var finalizeAuction = function() {
		var p = player[highestbidder];
		var sq = square[auctionproperty];

		if (highestbid > 0) {
			// Winner may have bid beyond pocket cash — mortgage to cover.
			if (!p.human && p.money < highestbid) {
				aiRaiseCashByMortgaging(p, highestbid);
			}
			p.pay(highestbid, 0);
			sq.owner = highestbidder;
			addAlert(t('msg_auction_win', {name: p.name, prop: sq.name, amount: highestbid}));

			// During liquidation, auction proceeds go to the bankrupt player
			if (liquidation) {
				for (var li = 1; li <= pcount; li++) {
					if (player[li].name === liquidation.playerName) {
						player[li].money += highestbid;
						break;
					}
				}
			}
		}

		for (var i = 1; i <= pcount; i++) {
			player[i].bidding = true;
		}

		$("#popupbackground").hide();
		$("#popupwrap").hide();
		// Hide auction bar
		var aBar = document.getElementById("auction-bar");
		if (aBar) aBar.style.display = "none";

		// During liquidation, check if bankrupt player is now solvent
		if (liquidation && game.checkLiquidationSolvent()) {
			return; // remaining props returned, settlement called
		}

		if (!game.auction()) {
			if (liquidation) {
				game.settleLiquidation();
			} else {
				play();
			}
		}
	};

	this.addPropertyToAuctionQueue = function(propertyIndex) {
		auctionQueue.push(propertyIndex);
	};

	this.auction = function() {
		if (auctionQueue.length === 0) {
			return false;
		}

		index = auctionQueue.shift();

		var s = square[index];

		if (s.price === 0 || s.owner !== 0) {
			return game.auction();
		}

		// === SNIPE CARD CHECK ===
		// During fire sales, snipe cherry-pick already happened in bankruptcy().
		// Only check snipe for non-liquidation auctions (foreclosures, unowned landings).
		if (EVENTS_ENABLED && !liquidation) {
			for (var si = 1; si <= pcount; si++) {
				var sp = player[si];
				if (sp.bankrupt || !sp.snipeCard) continue;

				if (sp.human) {
					// Show Snipe popup for human player
					auctionproperty = index;
					popup(
						"<div class='interest-alert' style='background:#006633;color:white;'>"
						+ "<h3>" + t('pop_snipe_prompt') + "</h3>"
						+ "<p>" + t('pop_snipe_desc', {prop: s.name, price: s.price}) + "</p>"
						+ "<p>" + t('pop_snipe_cash', {amount: sp.money}) + "</p>"
						+ (sp.money >= s.price
							? "<input type='button' value='SNIPE IT! ($" + s.price + ")' onclick='executeSnipe(" + si + ", " + index + ");' style='background:#006633;color:white;font-weight:bold;padding:10px;margin:5px;' />"
							: "<p style='color:#ffaaaa;'>" + t('pop_snipe_cant_afford') + "</p>")
						+ "<input type='button' value='Skip — proceed to auction' onclick='skipSnipe(" + index + ");' style='padding:10px;margin:5px;' />"
						+ "</div>",
						"blank"
					);
					return true; // Block — waiting for player choice
				} else if (sp.AI) {
					// AI auto-decides: use Snipe if affordable and property is in a group they have, or is high-value
					var aiMine = 0;
					for (var si2 = 0; si2 < 40; si2++) {
						if (square[si2].groupNumber === s.groupNumber && square[si2].owner === si) aiMine++;
					}
					var aiValuable = s.groupNumber >= 6 && s.groupNumber <= 8;
					if ((aiMine >= 1 || aiValuable) && sp.money >= s.price) {
						sp.snipeCard = false;
						sp.money -= s.price;
						s.owner = si;
						addAlert(t('msg_snipe', {name: sp.name, prop: s.name, amount: s.price}));
						// During liquidation, snipe proceeds go to bankrupt player
						if (liquidation) {
							for (var li = 1; li <= pcount; li++) {
								if (player[li].name === liquidation.playerName) {
									player[li].money += s.price;
									break;
								}
							}
						}
						if (typeof boardMsg === "function") {
							boardMsg(
								"<div class='interest-alert' style='background:#006633;color:white;'>"
								+ "<h3>SNIPED!</h3>"
								+ "<p>" + t('msg_snipe', {name: sp.name, prop: s.name, amount: s.price}) + "</p>"
								+ "</div>"
							);
						}
						updateMoney();
						updateOwned();
						// During liquidation, check if bankrupt player is now solvent
						if (liquidation && game.checkLiquidationSolvent()) {
							return true;
						}
						// Skip this auction, proceed to next or play
						if (!game.auction()) {
							if (liquidation) {
								game.settleLiquidation();
							} else {
								play();
							}
						}
						return true;
					}
				}
			}
		}

		auctionproperty = index;
		highestbidder = 0;
		highestbid = 0;
		currentbidder = turn + 1;

		if (currentbidder > pcount) {
			currentbidder -= pcount;
		}

		var mtgLabel = s.mortgage ? " <span style='color:#ff6666;font-size:11px;'>(MORTGAGED)</span>" : "";
		var startBid = highestbid > 0 ? highestbid + 10 : 10;
		var auctionHTML = "<div style='font-weight:bold;font-size:15px;margin-bottom:4px;'>"
			+ t('pop_auction_title', {prop: ''}) + " <span id='propertyname'></span>" + mtgLabel + "</div>"
			+ "<div style='font-size:12px;'>" + t('pop_auction_highest', {amount: "<span id='highestbid'></span>", name: "<span id='highestbidder'></span>"}) + "</div>"
			+ "<div style='font-size:12px;'>" + t('pop_auction_your_turn', {name: "<span id='currentbidder'></span>"})
			+ " <span id='auction-cash' style='color:#66cc66;font-weight:bold;'></span></div>"
			+ "<div style='font-size:10px;color:#aaa;margin-bottom:6px;'>(" + (turn > 0 && player[turn] ? player[turn].name : '') + "'s turn — all players bid)</div>"
			+ "<div style='display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:8px;'>"
			+ "<input type='button' value='\u25BC' onclick='auctionStepBid(-10);' style='padding:6px 12px;font-size:16px;cursor:pointer;border-radius:4px;' />"
			+ "<span id='bid' style='display:inline-block;min-width:80px;text-align:center;font-size:20px;font-weight:bold;color:#DAA520;'>$" + startBid + "</span>"
			+ "<input type='hidden' id='bidvalue' value='" + startBid + "' />"
			+ "<input type='button' value='\u25B2' onclick='auctionStepBid(10);' style='padding:6px 12px;font-size:16px;cursor:pointer;border-radius:4px;' />"
			+ "</div>"
			+ "<div>"
			+ "<input type='button' value='" + t('btn_bid') + "' onclick='game.auctionBid();' style='margin:2px;padding:5px 16px;cursor:pointer;font-size:13px;' />"
			+ "<input type='button' value='" + t('btn_pass') + "' onclick='game.auctionPass();' style='margin:2px;padding:5px 16px;cursor:pointer;font-size:13px;' />"
			+ "<input type='button' value='" + t('btn_exit_auction') + "' onclick='confirmAuctionExit();' style='margin:2px;padding:5px 16px;cursor:pointer;font-size:13px;' />"
			+ " <input type='button' id='auction-raise-btn' value='💰 " + t('btn_raise_money') + "' onclick='auctionRaiseMoney();' style='margin:2px;padding:5px 12px;cursor:pointer;font-size:12px;background:#DAA520;color:#333;border:1px solid #b8860b;border-radius:4px;font-weight:bold;' />"
			+ "</div>";

		// Show auction in floating bar (doesn't replace game controls)
		var auctionBar = document.getElementById("auction-bar");
		if (auctionBar) {
			auctionBar.innerHTML = auctionHTML;
			auctionBar.style.display = "block";
		}

		document.getElementById("propertyname").innerHTML = "<a href='javascript:void(0);' onmouseover='showdeed(" + auctionproperty + ");' onmouseout='hidedeed();' style='color:#DAA520;'>" + s.name + "</a>";
		document.getElementById("highestbid").innerHTML = "0";
		document.getElementById("highestbidder").innerHTML = t('pop_auction_na');
		document.getElementById("currentbidder").innerHTML = player[currentbidder].name;
		var cashEl = document.getElementById("auction-cash");
		if (cashEl) cashEl.textContent = "($" + player[currentbidder].money + ")";

		updateMoney();

		if (!player[currentbidder].human) {
			currentbidder = turn; // auctionPass advances currentbidder.
			this.auctionPass();
		}
		return true;
	};

	this.auctionPass = function() {
		if (highestbidder === 0) {
			highestbidder = currentbidder;
		}

		while (true) {
			currentbidder++;

			if (currentbidder > pcount) {
				currentbidder -= pcount;
			}

			if (currentbidder == highestbidder) {
				finalizeAuction();
				return;
			} else if (player[currentbidder].bidding) {
				var p = player[currentbidder];

				if (!p.human) {
					var bid = p.AI.bid(auctionproperty, highestbid);

					if (bid === -1) {
						p.bidding = false;
						addAlert(t('pop_auction_exit', {name: p.name}));
						continue;

					} else if (bid === 0) {
						addAlert(t('pop_auction_pass', {name: p.name}));
						continue;

					} else if (bid > 0) {
						this.auctionBid(bid);
						addAlert(t('pop_auction_bid', {name: p.name, amount: bid}));
						continue;
					}
					return;
				} else {
					break;
				}
			}

		}

		document.getElementById("currentbidder").innerHTML = player[currentbidder].name;
		// Show current bidder's cash
		var cashEl = document.getElementById("auction-cash");
		if (cashEl) cashEl.textContent = "($" + player[currentbidder].money + ")";
		// Reset bid stepper for next human bidder
		var nextBid = highestbid + 10;
		var bidVal = document.getElementById("bidvalue");
		var bidDisp = document.getElementById("bid");
		if (bidVal) bidVal.value = nextBid;
		if (bidDisp) { bidDisp.textContent = "$" + nextBid; bidDisp.style.color = "#DAA520"; }
	};

	this.auctionBid = function(bid) {
		var bidEl = document.getElementById("bidvalue");
		bid = bid || (bidEl ? parseInt(bidEl.value, 10) : 0);

		if (!bid || isNaN(bid) || bid <= 0) {
			return;
		}

		if (bid > player[currentbidder].money) {
			// Flash the display red briefly
			var dispEl = document.getElementById("bid");
			if (dispEl) { dispEl.style.color = "#ff4444"; setTimeout(function() { dispEl.style.color = "#DAA520"; }, 600); }
		} else if (bid > highestbid) {
			highestbid = bid;
			document.getElementById("highestbid").innerHTML = parseInt(bid, 10);
			highestbidder = currentbidder;
			document.getElementById("highestbidder").innerHTML = player[highestbidder].name;

			if (player[currentbidder].human) {
				this.auctionPass();
			}
		} else {
			// Bid too low — auto-step up to minimum
			var bidVal = document.getElementById("bidvalue");
			if (bidVal) {
				bidVal.value = highestbid + 10;
				var dispEl = document.getElementById("bid");
				if (dispEl) dispEl.textContent = "$" + bidVal.value;
			}
		}
	};

	this.auctionExit = function() {
		player[currentbidder].bidding = false;
		this.auctionPass();
	};



	// Trade functions:



	var currentInitiator;
	var currentRecipient;

	// Define event handlers:

	var tradeMoneyOnKeyDown = function (e) {
		var key = 0;
		var isCtrl = false;
		var isShift = false;

		if (window.event) {
			key = window.event.keyCode;
			isCtrl = window.event.ctrlKey;
			isShift = window.event.shiftKey;
		} else if (e) {
			key = e.keyCode;
			isCtrl = e.ctrlKey;
			isShift = e.shiftKey;
		}

		if (isNaN(key)) {
			return true;
		}

		if (key === 13) {
			return false;
		}

		// Allow backspace, tab, delete, arrow keys, or if control was pressed, respectively.
		if (key === 8 || key === 9 || key === 46 || (key >= 35 && key <= 40) || isCtrl) {
			return true;
		}

		if (isShift) {
			return false;
		}

		// Only allow number keys.
		return (key >= 48 && key <= 57) || (key >= 96 && key <= 105);
	};

	var tradeMoneyOnFocus = function () {
		this.style.color = "black";
		if (isNaN(this.value) || this.value === "0") {
			this.value = "";
		}
	};

	var tradeMoneyOnChange = function(e) {
		$("#proposetradebutton").show();
		$("#canceltradebutton").show();
		$("#accepttradebutton").hide();
		$("#rejecttradebutton").hide();

		var amount = this.value;

		if (isNaN(amount)) {
			this.value = "This value must be a number.";
			this.style.color = "red";
			return false;
		}

		amount = Math.round(amount) || 0;
		this.value = amount;

		if (amount < 0) {
			this.value = "This value must be greater than 0.";
			this.style.color = "red";
			return false;
		}

		return true;
	};

	document.getElementById("trade-leftp-money").onkeydown = tradeMoneyOnKeyDown;
	document.getElementById("trade-rightp-money").onkeydown = tradeMoneyOnKeyDown;
	document.getElementById("trade-leftp-money").onfocus = tradeMoneyOnFocus;
	document.getElementById("trade-rightp-money").onfocus = tradeMoneyOnFocus;
	document.getElementById("trade-leftp-money").onchange = tradeMoneyOnChange;
	document.getElementById("trade-rightp-money").onchange = tradeMoneyOnChange;

	var resetTrade = function(initiator, recipient, allowRecipientToBeChanged) {
		var currentSquare;
		var currentTableRow;
		var currentTableCell;
		var currentTableCellCheckbox;
		var nameSelect;
		var currentOption;
		var allGroupUninproved;
		var currentName;

		var tableRowOnClick = function(e) {
			var checkboxElement = this.firstChild.firstChild;

			if (checkboxElement !== e.srcElement) {
				checkboxElement.checked = !checkboxElement.checked;
			}

			$("#proposetradebutton").show();
			$("#canceltradebutton").show();
			$("#accepttradebutton").hide();
			$("#rejecttradebutton").hide();
		};

		var initiatorProperty = document.getElementById("trade-leftp-property");
		var recipientProperty = document.getElementById("trade-rightp-property");

		currentInitiator = initiator;
		currentRecipient = recipient;

		// Empty elements.
		while (initiatorProperty.lastChild) {
			initiatorProperty.removeChild(initiatorProperty.lastChild);
		}

		while (recipientProperty.lastChild) {
			recipientProperty.removeChild(recipientProperty.lastChild);
		}

		var initiatorSideTable = document.createElement("table");
		var recipientSideTable = document.createElement("table");


		for (var i = 0; i < 40; i++) {
			currentSquare = square[i];

			// A property cannot be traded if any properties in its group have been improved.
			if (currentSquare.house > 0 || currentSquare.groupNumber === 0) {
				continue;
			}

			allGroupUninproved = true;
			var max = currentSquare.group.length;
			for (var j = 0; j < max; j++) {

				if (square[currentSquare.group[j]].house > 0) {
					allGroupUninproved = false;
					break;
				}
			}

			if (!allGroupUninproved) {
				continue;
			}

			// Offered properties.
			if (currentSquare.owner === initiator.index) {
				currentTableRow = initiatorSideTable.appendChild(document.createElement("tr"));
				currentTableRow.onclick = tableRowOnClick;

				currentTableCell = currentTableRow.appendChild(document.createElement("td"));
				currentTableCell.className = "propertycellcheckbox";
				currentTableCellCheckbox = currentTableCell.appendChild(document.createElement("input"));
				currentTableCellCheckbox.type = "checkbox";
				currentTableCellCheckbox.id = "tradeleftcheckbox" + i;
				currentTableCellCheckbox.title = "Check this box to include " + currentSquare.name + " in the trade.";

				currentTableCell = currentTableRow.appendChild(document.createElement("td"));
				currentTableCell.className = "propertycellcolor";
				currentTableCell.style.backgroundColor = currentSquare.color;

				if (currentSquare.groupNumber == 1 || currentSquare.groupNumber == 2) {
					currentTableCell.style.borderColor = "grey";
				} else {
					currentTableCell.style.borderColor = currentSquare.color;
				}

				currentTableCell.propertyIndex = i;
				currentTableCell.onmouseover = function() {showdeed(this.propertyIndex);};
				currentTableCell.onmouseout = hidedeed;

				currentTableCell = currentTableRow.appendChild(document.createElement("td"));
				currentTableCell.className = "propertycellname";
				if (currentSquare.mortgage) {
					currentTableCell.title = "Mortgaged";
					currentTableCell.style.color = "grey";
				}
				currentTableCell.textContent = currentSquare.name;

			// Requested properties.
			} else if (currentSquare.owner === recipient.index) {
				currentTableRow = recipientSideTable.appendChild(document.createElement("tr"));
				currentTableRow.onclick = tableRowOnClick;

				currentTableCell = currentTableRow.appendChild(document.createElement("td"));
				currentTableCell.className = "propertycellcheckbox";
				currentTableCellCheckbox = currentTableCell.appendChild(document.createElement("input"));
				currentTableCellCheckbox.type = "checkbox";
				currentTableCellCheckbox.id = "traderightcheckbox" + i;
				currentTableCellCheckbox.title = "Check this box to include " + currentSquare.name + " in the trade.";

				currentTableCell = currentTableRow.appendChild(document.createElement("td"));
				currentTableCell.className = "propertycellcolor";
				currentTableCell.style.backgroundColor = currentSquare.color;

				if (currentSquare.groupNumber == 1 || currentSquare.groupNumber == 2) {
					currentTableCell.style.borderColor = "grey";
				} else {
					currentTableCell.style.borderColor = currentSquare.color;
				}

				currentTableCell.propertyIndex = i;
				currentTableCell.onmouseover = function() {showdeed(this.propertyIndex);};
				currentTableCell.onmouseout = hidedeed;

				currentTableCell = currentTableRow.appendChild(document.createElement("td"));
				currentTableCell.className = "propertycellname";
				if (currentSquare.mortgage) {
					currentTableCell.title = "Mortgaged";
					currentTableCell.style.color = "grey";
				}
				currentTableCell.textContent = currentSquare.name;
			}
		}

		if (initiator.communityChestJailCard) {
			currentTableRow = initiatorSideTable.appendChild(document.createElement("tr"));
			currentTableRow.onclick = tableRowOnClick;

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcheckbox";
			currentTableCellCheckbox = currentTableCell.appendChild(document.createElement("input"));
			currentTableCellCheckbox.type = "checkbox";
			currentTableCellCheckbox.id = "tradeleftcheckbox40";
			currentTableCellCheckbox.title = "Check this box to include this Get Out of Jail Free Card in the trade.";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcolor";
			currentTableCell.style.backgroundColor = "white";
			currentTableCell.style.borderColor = "grey";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellname";

			currentTableCell.textContent = "Get Out of Jail Free Card";
		} else if (recipient.communityChestJailCard) {
			currentTableRow = recipientSideTable.appendChild(document.createElement("tr"));
			currentTableRow.onclick = tableRowOnClick;

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcheckbox";
			currentTableCellCheckbox = currentTableCell.appendChild(document.createElement("input"));
			currentTableCellCheckbox.type = "checkbox";
			currentTableCellCheckbox.id = "traderightcheckbox40";
			currentTableCellCheckbox.title = "Check this box to include this Get Out of Jail Free Card in the trade.";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcolor";
			currentTableCell.style.backgroundColor = "white";
			currentTableCell.style.borderColor = "grey";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellname";

			currentTableCell.textContent = "Get Out of Jail Free Card";
		}

		if (initiator.chanceJailCard) {
			currentTableRow = initiatorSideTable.appendChild(document.createElement("tr"));
			currentTableRow.onclick = tableRowOnClick;

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcheckbox";
			currentTableCellCheckbox = currentTableCell.appendChild(document.createElement("input"));
			currentTableCellCheckbox.type = "checkbox";
			currentTableCellCheckbox.id = "tradeleftcheckbox41";
			currentTableCellCheckbox.title = "Check this box to include this Get Out of Jail Free Card in the trade.";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcolor";
			currentTableCell.style.backgroundColor = "white";
			currentTableCell.style.borderColor = "grey";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellname";

			currentTableCell.textContent = "Get Out of Jail Free Card";
		} else if (recipient.chanceJailCard) {
			currentTableRow = recipientSideTable.appendChild(document.createElement("tr"));
			currentTableRow.onclick = tableRowOnClick;

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcheckbox";
			currentTableCellCheckbox = currentTableCell.appendChild(document.createElement("input"));
			currentTableCellCheckbox.type = "checkbox";
			currentTableCellCheckbox.id = "traderightcheckbox41";
			currentTableCellCheckbox.title = "Check this box to include this Get Out of Jail Free Card in the trade.";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellcolor";
			currentTableCell.style.backgroundColor = "white";
			currentTableCell.style.borderColor = "grey";

			currentTableCell = currentTableRow.appendChild(document.createElement("td"));
			currentTableCell.className = "propertycellname";

			currentTableCell.textContent = "Get Out of Jail Free Card";
		}

		if (initiatorSideTable.lastChild) {
			initiatorProperty.appendChild(initiatorSideTable);
		} else {
			initiatorProperty.textContent = initiator.name + " has no properties to trade.";
		}

		if (recipientSideTable.lastChild) {
			recipientProperty.appendChild(recipientSideTable);
		} else {
			recipientProperty.textContent = recipient.name + " has no properties to trade.";
		}

		document.getElementById("trade-leftp-name").textContent = initiator.name;

		currentName = document.getElementById("trade-rightp-name");

		if (allowRecipientToBeChanged && pcount > 2) {
			// Empty element.
			while (currentName.lastChild) {
				currentName.removeChild(currentName.lastChild);
			}

			nameSelect = currentName.appendChild(document.createElement("select"));
			for (var i = 1; i <= pcount; i++) {
				if (i === initiator.index) {
					continue;
				}

				currentOption = nameSelect.appendChild(document.createElement("option"));
				currentOption.value = i + "";
				currentOption.style.color = player[i].color;
				currentOption.textContent = player[i].name;

				if (i === recipient.index) {
					currentOption.selected = "selected";
				}
			}

			nameSelect.onchange = function() {
				resetTrade(currentInitiator, player[parseInt(this.value, 10)], true);
			};

			nameSelect.title = "Select a player to trade with.";
		} else {
			currentName.textContent = recipient.name;
		}

		document.getElementById("trade-leftp-money").value = "0";
		document.getElementById("trade-rightp-money").value = "0";

	};

	var readTrade = function() {
		var initiator = currentInitiator;
		var recipient = currentRecipient;
		var property = new Array(40);
		var money;
		var communityChestJailCard;
		var chanceJailCard;

		for (var i = 0; i < 40; i++) {

			if (document.getElementById("tradeleftcheckbox" + i) && document.getElementById("tradeleftcheckbox" + i).checked) {
				property[i] = 1;
			} else if (document.getElementById("traderightcheckbox" + i) && document.getElementById("traderightcheckbox" + i).checked) {
				property[i] = -1;
			} else {
				property[i] = 0;
			}
		}

		if (document.getElementById("tradeleftcheckbox40") && document.getElementById("tradeleftcheckbox40").checked) {
			communityChestJailCard = 1;
		} else if (document.getElementById("traderightcheckbox40") && document.getElementById("traderightcheckbox40").checked) {
			communityChestJailCard = -1;
		} else {
			communityChestJailCard = 0;
		}

		if (document.getElementById("tradeleftcheckbox41") && document.getElementById("tradeleftcheckbox41").checked) {
			chanceJailCard = 1;
		} else if (document.getElementById("traderightcheckbox41") && document.getElementById("traderightcheckbox41").checked) {
			chanceJailCard = -1;
		} else {
			chanceJailCard = 0;
		}

		money = parseInt(document.getElementById("trade-leftp-money").value, 10) || 0;
		money -= parseInt(document.getElementById("trade-rightp-money").value, 10) || 0;

		var trade = new Trade(initiator, recipient, money, property, communityChestJailCard, chanceJailCard);

		return trade;
	};

	var writeTrade = function(tradeObj) {
		resetTrade(tradeObj.getInitiator(), tradeObj.getRecipient(), false);

		for (var i = 0; i < 40; i++) {

			if (document.getElementById("tradeleftcheckbox" + i)) {
				document.getElementById("tradeleftcheckbox" + i).checked = false;
				if (tradeObj.getProperty(i) === 1) {
					document.getElementById("tradeleftcheckbox" + i).checked = true;
				}
			}

			if (document.getElementById("traderightcheckbox" + i)) {
				document.getElementById("traderightcheckbox" + i).checked = false;
				if (tradeObj.getProperty(i) === -1) {
					document.getElementById("traderightcheckbox" + i).checked = true;
				}
			}
		}

		if (document.getElementById("tradeleftcheckbox40")) {
			if (tradeObj.getCommunityChestJailCard() === 1) {
				document.getElementById("tradeleftcheckbox40").checked = true;
			} else {
				document.getElementById("tradeleftcheckbox40").checked = false;
			}
		}

		if (document.getElementById("traderightcheckbox40")) {
			if (tradeObj.getCommunityChestJailCard() === -1) {
				document.getElementById("traderightcheckbox40").checked = true;
			} else {
				document.getElementById("traderightcheckbox40").checked = false;
			}
		}

		if (document.getElementById("tradeleftcheckbox41")) {
			if (tradeObj.getChanceJailCard() === 1) {
				document.getElementById("tradeleftcheckbox41").checked = true;
			} else {
				document.getElementById("tradeleftcheckbox41").checked = false;
			}
		}

		if (document.getElementById("traderightcheckbox41")) {
			if (tradeObj.getChanceJailCard() === -1) {
				document.getElementById("traderightcheckbox41").checked = true;
			} else {
				document.getElementById("traderightcheckbox41").checked = false;
			}
		}

		if (tradeObj.getMoney() > 0) {
			document.getElementById("trade-leftp-money").value = tradeObj.getMoney() + "";
		} else {
			document.getElementById("trade-rightp-money").value = (-tradeObj.getMoney()) + "";
		}

	};

	this.trade = function(tradeObj) {
		var hl = document.getElementById("trade-headline");
		if (hl) { hl.style.display = "none"; hl.innerHTML = ""; }
		showCenterPanel('center-trade');
		$("#proposetradebutton").show();
		$("#canceltradebutton").show();
		$("#accepttradebutton").hide();
		$("#rejecttradebutton").hide();

		if (tradeObj instanceof Trade) {
			writeTrade(tradeObj);
			this.proposeTrade();
		} else {
			var initiator = player[turn];
			var recipient = turn === 1 ? player[2] : player[1];

			currentInitiator = initiator;
			currentRecipient = recipient;

			resetTrade(initiator, recipient, true);
		}
	};


	this.cancelTrade = function() {
		showCenterPanel('center-game');

		// Set cooldown and duplicate fingerprint on rejection
		if (currentInitiator && currentRecipient) {
			var ck = currentInitiator.index + "-" + currentRecipient.index;
			tradeCooldowns[ck] = turnCounter + TRADE_COOLDOWN_TURNS;
			lastRejectedTrade = lastProposedFingerprint;
		}

		if (!player[turn].human) {
			player[turn].AI.alertList = "";
			game.next();
		}

	};

	this.acceptTrade = function(tradeObj) {
		if (isNaN(document.getElementById("trade-leftp-money").value)) {
			document.getElementById("trade-leftp-money").value = "This value must be a number.";
			document.getElementById("trade-leftp-money").style.color = "red";
			return false;
		}

		if (isNaN(document.getElementById("trade-rightp-money").value)) {
			document.getElementById("trade-rightp-money").value = "This value must be a number.";
			document.getElementById("trade-rightp-money").style.color = "red";
			return false;
		}

		var showAlerts = true;
		var money;
		var initiator;
		var recipient;

		if (tradeObj) {
			showAlerts = false;
		} else {
			tradeObj = readTrade();
		}

		money = tradeObj.getMoney();
		initiator = tradeObj.getInitiator();
		recipient = tradeObj.getRecipient();


		if (money > 0 && money > initiator.money) {
			document.getElementById("trade-leftp-money").value = initiator.name + " does not have $" + money + ".";
			document.getElementById("trade-leftp-money").style.color = "red";
			return false;
		} else if (money < 0 && -money > recipient.money) {
			document.getElementById("trade-rightp-money").value = recipient.name + " does not have $" + (-money) + ".";
			document.getElementById("trade-rightp-money").style.color = "red";
			return false;
		}

		var isAPropertySelected = 0;

		// Ensure that some properties are selected.
		for (var i = 0; i < 40; i++) {
			isAPropertySelected |= tradeObj.getProperty(i);
		}

		isAPropertySelected |= tradeObj.getCommunityChestJailCard();
		isAPropertySelected |= tradeObj.getChanceJailCard();

		if (isAPropertySelected === 0) {
			boardMsg("<p>" + t('pop_trade_must_select') + "</p>");

			return false;
		}

		// Trade acceptance proceeds directly — player already clicked "Accept"

		// Exchange properties
		for (var i = 0; i < 40; i++) {

			if (tradeObj.getProperty(i) === 1) {
				square[i].owner = recipient.index;
				addAlert(t('msg_trade_recv_prop', {name: recipient.name, prop: square[i].name, other: initiator.name}));
			} else if (tradeObj.getProperty(i) === -1) {
				square[i].owner = initiator.index;
				addAlert(t('msg_trade_recv_prop', {name: initiator.name, prop: square[i].name, other: recipient.name}));
			}

		}

		if (tradeObj.getCommunityChestJailCard() === 1) {
			initiator.communityChestJailCard = false;
			recipient.communityChestJailCard = true;
			addAlert(t('msg_trade_recv_card', {name: recipient.name, other: initiator.name}));
		} else if (tradeObj.getCommunityChestJailCard() === -1) {
			initiator.communityChestJailCard = true;
			recipient.communityChestJailCard = false;
			addAlert(t('msg_trade_recv_card', {name: initiator.name, other: recipient.name}));
		}

		if (tradeObj.getChanceJailCard() === 1) {
			initiator.chanceJailCard = false;
			recipient.chanceJailCard = true;
			addAlert(t('msg_trade_recv_card', {name: recipient.name, other: initiator.name}));
		} else if (tradeObj.getChanceJailCard() === -1) {
			initiator.chanceJailCard = true;
			recipient.chanceJailCard = false;
			addAlert(t('msg_trade_recv_card', {name: initiator.name, other: recipient.name}));
		}

		// Exchange money.
		if (money > 0) {
			initiator.pay(money, recipient.index);
			recipient.money += money;

			addAlert(t('msg_trade_recv_money', {name: recipient.name, amount: money, other: initiator.name}));
		} else if (money < 0) {
			money = -money;

			recipient.pay(money, initiator.index);
			initiator.money += money;

			addAlert(t('msg_trade_recv_money', {name: initiator.name, amount: money, other: recipient.name}));
		}

		updateOwned();
		updateMoney();

		showCenterPanel('center-game');

		lastRejectedTrade = null;

		if (!player[turn].human) {
			player[turn].AI.alertList = "";
			game.next();
		}
	};

	this.proposeTrade = function() {
		if (isNaN(document.getElementById("trade-leftp-money").value)) {
			document.getElementById("trade-leftp-money").value = "This value must be a number.";
			document.getElementById("trade-leftp-money").style.color = "red";
			return false;
		}

		if (isNaN(document.getElementById("trade-rightp-money").value)) {
			document.getElementById("trade-rightp-money").value = "This value must be a number.";
			document.getElementById("trade-rightp-money").style.color = "red";
			return false;
		}

		var tradeObj = readTrade();
		var initiator = tradeObj.getInitiator();
		var recipient = tradeObj.getRecipient();

		// Per-turn trade limit (human players only)
		if (initiator.human && humanTradesThisTurn >= TRADES_PER_TURN_LIMIT) {
			boardMsg("<p>" + t('pop_trade_limit') + "</p>");
			return false;
		}

		// Cooldown after rejection
		var cooldownKey = initiator.index + "-" + recipient.index;
		if (tradeCooldowns[cooldownKey] && turnCounter < tradeCooldowns[cooldownKey]) {
			var remaining = tradeCooldowns[cooldownKey] - turnCounter;
			boardMsg("<p>" + t('pop_trade_cooldown', {name: recipient.name, turns: remaining}) + "</p>");
			return false;
		}

		// Duplicate trade detection
		var fingerprint = initiator.index + "-" + recipient.index + "-";
		for (var fi = 0; fi < 40; fi++) fingerprint += tradeObj.getProperty(fi);
		fingerprint += "-" + tradeObj.getMoney();
		if (lastRejectedTrade === fingerprint) {
			boardMsg("<p>" + t('pop_trade_duplicate') + "</p>");
			return false;
		}
		lastProposedFingerprint = fingerprint;

		if (initiator.human) humanTradesThisTurn++;
		var money = tradeObj.getMoney();
		var initiator = tradeObj.getInitiator();
		var recipient = tradeObj.getRecipient();
		var reversedTradeProperty = [];

		if (money > 0 && money > initiator.money) {
			document.getElementById("trade-leftp-money").value = initiator.name + " does not have $" + money + ".";
			document.getElementById("trade-leftp-money").style.color = "red";
			return false;
		} else if (money < 0 && -money > recipient.money) {
			document.getElementById("trade-rightp-money").value = recipient.name + " does not have $" + (-money) + ".";
			document.getElementById("trade-rightp-money").style.color = "red";
			return false;
		}

		var isAPropertySelected = 0;

		// Ensure that some properties are selected.
		for (var i = 0; i < 40; i++) {
			reversedTradeProperty[i] = -tradeObj.getProperty(i);
			isAPropertySelected |= tradeObj.getProperty(i);
		}

		isAPropertySelected |= tradeObj.getCommunityChestJailCard();
		isAPropertySelected |= tradeObj.getChanceJailCard();

		if (isAPropertySelected === 0) {
			boardMsg("<p>" + t('pop_trade_must_select') + "</p>");

			return false;
		}

		// Trade proposal proceeds directly — player already clicked "Propose"

		var reversedTrade = new Trade(recipient, initiator, -money, reversedTradeProperty, -tradeObj.getCommunityChestJailCard(), -tradeObj.getChanceJailCard());

		// Build trade summary for log (works for both human and AI recipients)
		var offered = [], requested = [];
		for (var ti = 0; ti < 40; ti++) {
			if (tradeObj.getProperty(ti) === -1) offered.push(square[ti].name);
			else if (tradeObj.getProperty(ti) === 1) requested.push(square[ti].name);
		}
		var tradeSummary = "";
		if (offered.length > 0) tradeSummary += offered.join(", ");
		if (money < 0) tradeSummary += (tradeSummary ? " + " : "") + "$" + (-money);
		tradeSummary += " → ";
		if (requested.length > 0) tradeSummary += requested.join(", ");
		if (money > 0) tradeSummary += (requested.length > 0 ? " + " : "") + "$" + money;

		trackEvent("trade_proposed", { initiator: initiator.name, recipient: recipient.name, human: initiator.human });
		addAlert(t('msg_trade_init', {name: initiator.name, other: recipient.name}) + " " + tradeSummary);

		if (recipient.human) {
			var hl = document.getElementById("trade-headline");
			if (hl && !initiator.human) {
				hl.innerHTML = t('pop_trade_proposed', {initiator: initiator.name, recipient: recipient.name});
				hl.style.display = "block";
			}
			writeTrade(reversedTrade);
			$("#proposetradebutton").hide();
			$("#canceltradebutton").hide();
			$("#accepttradebutton").show();
			$("#rejecttradebutton").show();
			showCenterPanel('center-trade');
		} else {
			var tradeResponse = recipient.AI.acceptTrade(tradeObj);
			var gameRef = this;

			if (tradeResponse === "pending" && recipient.AI.evaluateTradeAsync) {
				// AIClaude async path — show thinking indicator, await Claude's decision
				addAlert(t('msg_trade_thinking', {name: recipient.name}));
				boardMsg("<p style='text-align:center;'><strong>" + t('pop_trade_claude_thinking', {name: recipient.name}) + "</strong><br/><span style='font-size:24px;'>🤔</span></p>");

				recipient.AI.evaluateTradeAsync(tradeObj).then(function(result) {
					addAlert(recipient.name + " (Claude): " + (result.reason || ""));

					if (result.decision === "accept") {
						boardMsg("<p>" + t('msg_trade_accepted', {name: recipient.name}) + "</p>"
							+ "<p style='font-size:11px;color:#888;'>Reason: " + (result.reason || "") + "</p>");
						gameRef.acceptTrade(reversedTrade);
					} else if (result.decision === "counter" && result.cash) {
						// Build counter-offer: Claude wants more cash
						var counterMoney = result.cash;
						var counterProp = [];
						for (var ci = 0; ci < 40; ci++) counterProp[ci] = tradeObj.getProperty(ci);
						// Flip property direction and set the cash Claude demands
						var counterFromRecipient = new Trade(
							recipient, initiator, -counterMoney, counterProp,
							tradeObj.getCommunityChestJailCard(), tradeObj.getChanceJailCard()
						);

						if (initiator.human) {
							boardMsg("<p>" + t('msg_trade_counter', {name: recipient.name, amount: counterMoney}) + "</p>"
								+ "<p style='font-size:11px;color:#888;'>Reason: " + (result.reason || "") + "</p>");
							writeTrade(counterFromRecipient);
							showCenterPanel('center-trade');
							$("#proposetradebutton, #canceltradebutton").hide();
							$("#accepttradebutton").show();
							$("#rejecttradebutton").show();
						} else {
							// Both AIs — let initiator evaluate the counter
							var counterForInit = new Trade(initiator, recipient, counterMoney, counterProp,
								tradeObj.getCommunityChestJailCard(), tradeObj.getChanceJailCard());
							var initResponse = initiator.AI.acceptTrade(counterForInit);
							if (initResponse === true) {
								addAlert(t('msg_trade_counter_accepted', {name: initiator.name, other: recipient.name, amount: counterMoney}));
								boardMsg("<p>" + t('msg_trade_counter_accepted', {name: initiator.name, other: recipient.name, amount: counterMoney}) + "</p>");
								var counterRevProp = [];
								for (var cj = 0; cj < 40; cj++) counterRevProp[cj] = -counterProp[cj];
								var counterRev = new Trade(recipient, initiator, -counterMoney, counterRevProp,
									-tradeObj.getCommunityChestJailCard(), -tradeObj.getChanceJailCard());
								gameRef.acceptTrade(counterRev);
							} else {
								addAlert(t('msg_trade_counter_rejected', {name: initiator.name, other: recipient.name}));
								boardMsg("<p>" + t('msg_trade_counter_rejected', {name: initiator.name, other: recipient.name}) + "</p>");
								gameRef.cancelTrade();
							}
						}
					} else {
						// Reject
						boardMsg("<p>" + t('msg_trade_declined', {name: recipient.name}) + "</p>"
							+ "<p style='font-size:11px;color:#888;'>Reason: " + (result.reason || "") + "</p>", function() {
							gameRef.cancelTrade();
						});
					}
				});
				return; // Don't fall through — async will resolve
			}

			// Synchronous path (non-Claude AIs)
			var self = this;
			if (tradeResponse === true) {
				boardMsg("<p>" + t('msg_trade_accepted', {name: recipient.name}) + "</p>", function() {
					self.acceptTrade(reversedTrade);
				});
			} else if (tradeResponse === false) {
				boardMsg("<p>" + t('msg_trade_declined', {name: recipient.name}) + "</p>", function() {
					self.cancelTrade();
				});
				return;
			} else if (tradeResponse instanceof Trade) {
				// Counter-offer from the recipient AI.
				if (initiator.human) {
					// Show counter-offer to the human player for decision.
					var counterAmt = tradeResponse.getMoney ? tradeResponse.getMoney() : 0;
					addAlert(t('msg_trade_counter', {name: recipient.name, amount: counterAmt}));
					showCenterPanel('center-trade');
					writeTrade(tradeResponse);

					$("#proposetradebutton, #canceltradebutton").hide();
					$("#accepttradebutton").show();
					$("#rejecttradebutton").show();
				} else {
					// Both sides are AI — auto-resolve the counter-offer.
					var counterMoney = tradeResponse.getMoney();
					var counterProp = [];
					for (var ci = 0; ci < 40; ci++) counterProp[ci] = tradeResponse.getProperty(ci);
					var counterForInitiator = new Trade(
						tradeResponse.getInitiator(),
						tradeResponse.getRecipient(),
						counterMoney,
						counterProp,
						tradeResponse.getCommunityChestJailCard(),
						tradeResponse.getChanceJailCard()
					);
					var initiatorResponse = initiator.AI.acceptTrade(counterForInitiator);

					if (initiatorResponse === true) {
						addAlert(t('msg_trade_counter_accepted', {name: initiator.name, other: recipient.name, amount: counterMoney}));
						boardMsg("<p>" + t('msg_trade_counter_accepted', {name: initiator.name, other: recipient.name, amount: counterMoney}) + "</p>");
						var counterReversedProp = [];
						for (var cj = 0; cj < 40; cj++) counterReversedProp[cj] = -counterProp[cj];
						var counterReversed = new Trade(
							tradeResponse.getRecipient(),
							tradeResponse.getInitiator(),
							-counterMoney,
							counterReversedProp,
							-tradeResponse.getCommunityChestJailCard(),
							-tradeResponse.getChanceJailCard()
						);
						this.acceptTrade(counterReversed);
					} else {
						addAlert(t('msg_trade_counter_rejected', {name: initiator.name, other: recipient.name}));
						boardMsg("<p>" + t('msg_trade_counter_rejected', {name: initiator.name, other: recipient.name}) + "</p>");
						this.cancelTrade();
						return;
					}
				}
			}
		}
	};



	// Bankrupcy functions:




	this.eliminatePlayer = function() {
		var p = player[turn];

		for (var i = p.index; i < pcount; i++) {
			player[i] = player[i + 1];
			player[i].index = i;

		}

		for (var i = 0; i < 40; i++) {
			if (square[i].owner >= p.index) {
				square[i].owner--;
			}
		}

		pcount--;
		turn--;

		if (pcount === 2) {
			document.getElementById("stats").style.width = "454px";
		} else if (pcount === 3) {
			document.getElementById("stats").style.width = "686px";
		}

		if (pcount === 1) {
			updateMoney();
			$("#board-center-overlay").hide();
			$("#board").hide();
			$("#refresh").show();

			// // Display land counts for survey purposes.
			// var text;
			// for (var i = 0; i < 40; i++) {
				// if (i === 0)
					// text = square[i].landcount;
				// else
					// text += " " + square[i].landcount;
			// }
			// document.getElementById("refresh").innerHTML += "<br><br><div><textarea type='text' style='width: 980px;' onclick='javascript:select();' />" + text + "</textarea></div>";

			trackEvent("game_completed", { winner: player[1].name, human: player[1].human, rounds: gameRound });
			boardMsg("<p>" + t('pop_win', {name: player[1].name}) + "</p><div>", null, 3000);

		} else {
			play();
		}
	};

	this.bankruptcyUnmortgage = function() {
		// LEGACY — no longer used in new liquidation flow.
		// Kept as safety fallback; redirects to eliminatePlayer.
		game.eliminatePlayer();
	};

	this.resign = function() {
		popup("<p>" + t('pop_resign') + "</p>", game.bankruptcy, "yes/no");
	};

	// getLiquidation accessor for use by executeSnipe (outside Game closure)
	this.getLiquidation = function() { return liquidation; };

	// Auction queue accessor for fire-sale snipe (outside Game closure)
	this.getAuctionQueue = function() { return auctionQueue; };

	// Check if bankrupt player raised enough during fire sale.
	// If solvent: return remaining queued properties, go to settlement.
	this.checkLiquidationSolvent = function() {
		if (!liquidation) return false;
		// Find the bankrupt player
		var bp = null;
		for (var li = 1; li <= pcount; li++) {
			if (player[li].name === liquidation.playerName) { bp = player[li]; break; }
		}
		if (!bp || bp.money < liquidation.rentOwed) return false;

		// Solvent! Return remaining queued properties to the player
		var returned = 0;
		while (auctionQueue.length > 0) {
			var sqIdx = auctionQueue.shift();
			if (square[sqIdx].owner === 0 && square[sqIdx].price > 0) {
				square[sqIdx].owner = bp.index;
				returned++;
			}
		}
		if (returned > 0) {
			addAlert(t('msg_raised_enough', {name: bp.name, count: returned}));
		}
		updateMoney();
		updateOwned();
		game.settleLiquidation();
		return true;
	};

	// ================================================================
	// BANKRUPTCY — Fire Sale (Tycoon Saigon)
	// ================================================================
	// When a player can't pay, they must raise cash:
	//   1. Sell houses/hotels back at 50%
	//   2. ALL remaining properties go to auction (beggar can't choose)
	//   3. Auction proceeds go to the player's cash
	//   4. After all auctions: if player can cover debt → pay & survive
	//      Otherwise → default, creditor eats the shortfall
	//
	// NOTE: When this fires, the creditor has ALREADY been paid the
	// full rent (pay() deducted from payer, caller added to creditor).
	// We claw back the shortfall first so the books are clean.
	// ================================================================
	this.bankruptcy = function() {
		var p = player[turn];

		if (p.money >= 0) {
			return;
		}

		var shortfall = -p.money; // positive: how much they're short

		// Claw back overpayment from creditor (they got paid in full but player couldn't afford it)
		if (p.creditor !== 0) {
			player[p.creditor].money -= shortfall;
			addAlert(t('msg_bankrupt_pays', {name: player[p.creditor].name, amount: shortfall, creditor: p.name}));
		}
		p.money = 0;
		var rentOwed = shortfall;

		trackEvent("fire_sale", { player: p.name, shortfall: rentOwed, round: gameRound });
		addAlert(p.name + " can't pay $" + rentOwed + " — fire sale!");

		// Phase 1: Sell all houses/hotels at 50%
		var houseSaleProceeds = 0;
		for (var i = 0; i < 40; i++) {
			var sq = square[i];
			if (sq.owner == p.index) {
				if (sq.hotel) {
					houseSaleProceeds += Math.round(sq.houseprice * 0.5 * 5);
					sq.hotel = 0;
					sq.house = 0;
				} else if (sq.house > 0) {
					houseSaleProceeds += Math.round(sq.houseprice * 0.5 * sq.house);
					sq.house = 0;
				}
			}
		}
		p.money += houseSaleProceeds;
		if (houseSaleProceeds > 0) {
			addAlert(t('msg_bankrupt_sold', {name: p.name, amount: houseSaleProceeds}));
		}

		// Check: house sales alone might cover it
		if (p.money >= rentOwed) {
			p.money -= rentOwed;
			if (p.creditor !== 0) {
				player[p.creditor].money += rentOwed;
				addAlert(t('msg_bankrupt_pays', {name: p.name, amount: rentOwed, creditor: player[p.creditor].name}));
			}
			updateMoney();
			updateOwned();
			boardMsg("<p>" + t('msg_bankrupt_survives', {name: p.name, amount: p.money}) + "</p>");
			return;
		}

		// Phase 2: ALL properties on the block — most valuable first.
		// Other players snatch the best ones; auction stops once player is solvent.
		var propsForAuction = [];
		for (var i = 0; i < 40; i++) {
			var sq = square[i];
			if (sq.owner == p.index) {
				propsForAuction.push(i);
			}
		}
		// Sort most expensive first — other players grab the valuable ones
		propsForAuction.sort(function(a, b) { return square[b].price - square[a].price; });
		var propCount = propsForAuction.length;
		for (var pi = 0; pi < propsForAuction.length; pi++) {
			var sq = square[propsForAuction[pi]];
			// Keep mortgage status — buyer gets it mortgaged and must unmortgage
			sq.owner = 0;
			game.addPropertyToAuctionQueue(propsForAuction[pi]);
		}

		// Discard jail cards
		p.chanceJailCard = false;
		p.communityChestJailCard = false;

		updateMoney();
		updateOwned();

		// Set up liquidation tracking
		liquidation = {
			playerIndex: p.index,
			playerName: p.name,
			creditorIndex: p.creditor,
			creditorName: p.creditor !== 0 ? player[p.creditor].name : "Bank",
			rentOwed: rentOwed
		};

		if (propCount === 0) {
			// Nothing to auction — straight to settlement
			game.settleLiquidation();
			return;
		}

		var creditorLabel = p.creditor !== 0 ? player[p.creditor].name : "the bank";

		// === SNIPE FIRST PICK ===
		// Before auctions begin, any snipe card holder gets to browse ALL
		// fire-sale properties and cherry-pick one at face value.
		var snipeHolder = null;
		if (EVENTS_ENABLED) {
			for (var si = 1; si <= pcount; si++) {
				if (player[si].bankrupt || si == p.index || !player[si].snipeCard) continue;
				snipeHolder = player[si];
				break;
			}
		}

		if (snipeHolder && snipeHolder.human) {
			// Human snipe holder — show picker popup
			var snipeHtml = "<div class='interest-alert' style='background:#006633;color:white;'>"
				+ "<h3>" + t('pop_snipe_first_pick', {name: snipeHolder.name}) + "</h3>"
				+ "<p>" + t('pop_snipe_firesale_desc', {name: p.name}) + "</p>"
				+ "<p>" + t('pop_snipe_pick_one') + "</p>"
				+ "<div style='max-height:300px;overflow-y:auto;'>";
			for (var qi = 0; qi < auctionQueue.length; qi++) {
				var qs = square[auctionQueue[qi]];
				var canAfford = snipeHolder.money >= qs.price;
				var mtgNote = qs.mortgage ? " <span style='color:#ffaaaa;'>(" + t('pop_snipe_mortgaged') + ")</span>" : "";
				snipeHtml += "<div style='margin:4px 0;'>"
					+ (canAfford
						? "<input type='button' value='SNIPE $" + qs.price + "' onclick='executeFireSaleSnipe(" + snipeHolder.index + "," + auctionQueue[qi] + ");' style='background:#004d26;color:white;font-weight:bold;padding:6px 12px;margin-right:8px;cursor:pointer;' />"
						: "<span style='color:#999;padding:6px 12px;margin-right:8px;'>" + t('pop_snipe_cant_afford_short') + "</span>")
					+ "<strong>" + qs.name + "</strong> — $" + qs.price + mtgNote
					+ "</div>";
			}
			snipeHtml += "</div>"
				+ "<input type='button' value='" + t('pop_snipe_skip_auction') + "' onclick='skipFireSaleSnipe();' style='padding:10px;margin-top:10px;' />"
				+ "</div>";
			popup(snipeHtml, "blank");
			return;
		} else if (snipeHolder && snipeHolder.AI) {
			// AI snipe holder — pick best property (group completion > value)
			var bestIdx = -1, bestScore = -1;
			for (var qi = 0; qi < auctionQueue.length; qi++) {
				var qs = square[auctionQueue[qi]];
				if (snipeHolder.money < qs.price) continue;
				var aiMine = 0;
				for (var si2 = 0; si2 < 40; si2++) {
					if (square[si2].groupNumber === qs.groupNumber && square[si2].owner === snipeHolder.index) aiMine++;
				}
				var score = qs.price;
				if (aiMine >= ((GROUP_SIZE_MAP || {})[qs.groupNumber] || 3) - 1) score += 10000;
				else if (aiMine >= 1) score += 5000;
				if (qs.groupNumber >= 6) score += 1000;
				if (score > bestScore) { bestScore = score; bestIdx = qi; }
			}
			if (bestIdx >= 0) {
				var snipeSq = square[auctionQueue[bestIdx]];
				snipeHolder.snipeCard = false;
				snipeHolder.money -= snipeSq.price;
				snipeSq.owner = snipeHolder.index;
				// Proceeds to bankrupt player
				p.money += snipeSq.price;
				addAlert(t('msg_snipe', {name: snipeHolder.name, prop: snipeSq.name, amount: snipeSq.price}));
				auctionQueue.splice(bestIdx, 1);
				propCount--;
				updateMoney();
				updateOwned();
				// Check if snipe alone made player solvent
				if (game.checkLiquidationSolvent()) return;
			}
		}

		if (auctionQueue.length === 0) {
			game.settleLiquidation();
			return;
		}

		addAlert(t('msg_auction_count', {count: auctionQueue.length, name: p.name}));

		boardMsg(
			"<div class='interest-alert' style='background:#cc3300;color:white;'>"
			+ "<h3>FIRE SALE — " + p.name + "</h3>"
			+ "<p>Owes $" + rentOwed + " to " + creditorLabel + ".</p>"
			+ "<p>Cash after house sales: <strong>$" + p.money + "</strong></p>"
			+ "<p><strong>" + auctionQueue.length + " properties</strong> going to auction!</p>"
			+ "</div>",
			function() { game.auction(); }
		);
	};

	// ================================================================
	// SETTLE LIQUIDATION — after all fire-sale auctions complete
	// ================================================================
	// Player's cash now = house sales + auction proceeds.
	// If they can cover the debt → pay creditor, survive.
	// Otherwise → default, creditor eats the loss, player eliminated.
	// ================================================================
	this.settleLiquidation = function() {
		if (!liquidation) return;
		var liq = liquidation;
		liquidation = null;

		// Find the bankrupt player
		var bankruptPlayer = null;
		for (var pi = 1; pi <= pcount; pi++) {
			if (player[pi].name === liq.playerName) {
				bankruptPlayer = player[pi];
				break;
			}
		}
		if (!bankruptPlayer) { game.eliminatePlayer(); return; }

		var cash = bankruptPlayer.money;
		var summary = [];
		summary.push("<h3>Fire Sale Result — " + liq.playerName + "</h3>");
		summary.push("<p>Cash raised: <strong>$" + cash + "</strong></p>");
		summary.push("<p>Debt owed: <strong>$" + liq.rentOwed + "</strong></p>");

		if (cash >= liq.rentOwed) {
			// SOLVENT — pay the debt, keep the change
			bankruptPlayer.money -= liq.rentOwed;
			if (liq.creditorIndex !== 0) {
				// Pay the player creditor
				for (var ci = 1; ci <= pcount; ci++) {
					if (player[ci].name === liq.creditorName) {
						player[ci].money += liq.rentOwed;
						break;
					}
				}
				addAlert(t('msg_bankrupt_pays', {name: liq.playerName, amount: liq.rentOwed, creditor: liq.creditorName}));
			} else {
				addAlert(t('msg_bankrupt_pays', {name: liq.playerName, amount: liq.rentOwed, creditor: 'the bank'}));
			}
			summary.push("<p style='color:#00cc00;font-weight:bold;'>" + liq.playerName
				+ " survives with $" + bankruptPlayer.money + "! No properties, but still playing.</p>");
			addAlert(t('msg_bankrupt_survives', {name: liq.playerName, amount: bankruptPlayer.money}));

			updateMoney();
			updateOwned();
			boardMsg("<div class='interest-alert' style='background:#1a1a2e;color:white;'>" + summary.join("") + "</div>", play);
		} else {
			// DEFAULT — can't cover the debt
			var paid = cash;
			var deficit = liq.rentOwed - paid;
			bankruptPlayer.money = 0;

			// Creditor gets whatever the player managed to raise
			if (liq.creditorIndex !== 0 && paid > 0) {
				for (var ci = 1; ci <= pcount; ci++) {
					if (player[ci].name === liq.creditorName) {
						player[ci].money += paid;
						break;
					}
				}
				addAlert(t('msg_bankrupt_short', {creditor: liq.creditorName, paid: paid, deficit: deficit}));
			}

			summary.push("<p style='color:#ff4444;font-weight:bold;'>" + liq.playerName
				+ " defaulted. " + (liq.creditorIndex !== 0 ? liq.creditorName + " absorbs $" + deficit + " loss." : "Bank writes off $" + deficit + ".") + "</p>");
			addAlert(t('msg_eliminated', {name: liq.playerName}));

			updateMoney();
			boardMsg("<div class='interest-alert' style='background:#660000;color:white;'>" + summary.join("") + "</div>", game.eliminatePlayer);
		}
	};

}

var game;


function Player(name, color) {
	this.name = name;
	this.color = color;
	this.position = 0;
	this.money = 1500;
	this.creditor = -1;
	this.jail = false;
	this.jailroll = 0;
	this.communityChestJailCard = false;
	this.chanceJailCard = false;
	this.snipeCard = false;       // Tycoon Saigon holdable card — grab foreclosed property at face value
	this.bidding = true;
	this.human = true;
	// Tycoon Saigon — cost of living mechanic
	this.lapsCompleted = 0;      // this player's lap counter, advances per pass-GO
	this.firstRollThisTurn = 7;  // captured at the first dice roll of the turn, read at pass-GO
	// this.AI = null;

	this.pay = function (amount, creditor) {
		if (amount <= this.money) {
			this.money -= amount;

			updateMoney();

			return true;
		} else {
			this.money -= amount;
			this.creditor = creditor;

			updateMoney();

			return false;
		}
	};
}

// paramaters:
// initiator: object Player
// recipient: object Player
// money: integer, positive for offered, negative for requested
// property: array of integers, length: 40
// communityChestJailCard: integer, 1 means offered, -1 means requested, 0 means neither
// chanceJailCard: integer, 1 means offered, -1 means requested, 0 means neither
function Trade(initiator, recipient, money, property, communityChestJailCard, chanceJailCard) {
	// For each property and get out of jail free cards, 1 means offered, -1 means requested, 0 means neither.

	this.getInitiator = function() {
		return initiator;
	};

	this.getRecipient = function() {
		return recipient;
	};

	this.getProperty = function(index) {
		return property[index];
	};

	this.getMoney = function() {
		return money;
	};

	this.getCommunityChestJailCard = function() {
		return communityChestJailCard;
	};

	this.getChanceJailCard = function() {
		return chanceJailCard;
	};
}

var player = [];
var pcount;
var turn = 0, doublecount = 0;
// Overwrite an array with numbers from one to the array's length in a random order.
Array.prototype.randomize = function(length) {
	length = (length || this.length);
	var num;
	var indexArray = [];

	for (var i = 0; i < length; i++) {
		indexArray[i] = i;
	}

	for (var i = 0; i < length; i++) {
		// Generate random number between 0 and indexArray.length - 1.
		num = Math.floor(Math.random() * indexArray.length);
		this[i] = indexArray[num] + 1;

		indexArray.splice(num, 1);
	}
};

// function show(element) {
	// // Element may be an HTML element or the id of one passed as a string.
	// if (element.constructor == String) {
		// element = document.getElementById(element);
	// }

	// if (element.tagName == "INPUT" || element.tagName == "SPAN" || element.tagName == "LABEL") {
		// element.style.display = "inline";
	// } else {
		// element.style.display = "block";
	// }
// }

// function hide(element) {
	// // Element may be an HTML element or the id of one passed as a string.
	// if (element.constructor == String) {
		// document.getElementById(element).style.display = "none";
	// } else {
		// element.style.display = "none";
	// }
// }

function addAlert(alertText) {
	$alert = $("#alert");

	$(document.createElement("div")).text(alertText).appendTo($alert);

	// Animate scrolling down alert element.
	$alert.stop().animate({"scrollTop": $alert.prop("scrollHeight")}, 1000);

	if (!player[turn].human) {
		player[turn].AI.alertList += "<div>" + alertText + "</div>";
	}
}

function popup(HTML, action, option) {
	document.getElementById("popuptext").innerHTML = HTML;
	document.getElementById("popup").style.width = "300px";
	document.getElementById("popup").style.top = "0px";
	document.getElementById("popup").style.left = "0px";

	if (!option && typeof action === "string") {
		option = action;
	}

	option = option ? option.toLowerCase() : "";

	if (typeof action !== "function") {
		action = null;
	}

	// Yes/No
	if (option === "yes/no") {
		document.getElementById("popuptext").innerHTML += "<div><input type=\"button\" value=\"" + t('btn_yes') + "\" id=\"popupyes\" /><input type=\"button\" value=\"" + t('btn_no') + "\" id=\"popupno\" /></div>";

		$("#popupyes, #popupno").on("click", function() {
			$("#popupwrap").hide();
			$("#popupbackground").fadeOut(400);
		});

		$("#popupyes").on("click", action);

	// Ok
	} else if (option !== "blank") {
		$("#popuptext").append("<div><input type='button' value='" + t('btn_ok') + "' id='popupclose' /></div>");
		$("#popupclose").focus();

		$("#popupclose").on("click", function() {
			$("#popupwrap").hide();
			$("#popupbackground").fadeOut(400);
		}).on("click", action);

	}

	// Show using animation.
	$("#popupbackground").fadeIn(400, function() {
		$("#popupwrap").show();
	});

}

// ---- Landed message helper ----
function setLanded(html) {
	$("#landed").show();
	document.getElementById("landed").innerHTML = html;
}
function clearLanded() {
	document.getElementById("landed").innerHTML = "";
	$("#landed").hide();
}

// ---- Center panel switching ----
function showCenterPanel(panelId) {
	var panels = document.querySelectorAll('.center-panel');
	for (var i = 0; i < panels.length; i++) {
		panels[i].style.display = 'none';
	}
	var target = document.getElementById(panelId);
	if (target) target.style.display = '';
}

// ---- Non-blocking board message (inside center) ----
var _boardMsgTimer = null;
var _boardMsgCallback = null;

function boardMsg(html, callback, duration) {
	var textEl = document.getElementById("board-msg-text");
	var btnWrap = document.getElementById("board-msg-btn");
	if (!textEl) { if (callback) callback(); return; }

	if (_boardMsgTimer) { clearTimeout(_boardMsgTimer); _boardMsgTimer = null; }
	_boardMsgCallback = callback || null;

	textEl.innerHTML = html;
	btnWrap.style.display = callback ? "block" : "none";

	// Switch to message panel
	showCenterPanel('center-msg');

	// Auto-dismiss if no callback
	if (!callback) {
		var dur = duration || 2500;
		_boardMsgTimer = setTimeout(function() {
			// Only switch back if we're still on the message panel
			var msgPanel = document.getElementById('center-msg');
			if (msgPanel && msgPanel.style.display !== 'none') {
				showCenterPanel('center-game');
			}
			_boardMsgTimer = null;
		}, dur);
	}
}

function dismissBoardMsg() {
	showCenterPanel('center-game');
	if (_boardMsgTimer) { clearTimeout(_boardMsgTimer); _boardMsgTimer = null; }
	var cb = _boardMsgCallback;
	_boardMsgCallback = null;
	if (cb) cb();
}


function updatePosition() {
	// Reset borders
	document.getElementById("jail").style.border = "1px solid #666";
	document.getElementById("jailpositionholder").innerHTML = "";
	for (var i = 0; i < 40; i++) {
		document.getElementById("cell" + i).style.borderColor = "#2a6e3f";
		document.getElementById("cell" + i + "positionholder").innerHTML = "";

	}

	var sq, left, top;
	var tokenSize = 22; // circle token width + gap

	for (var x = 0; x < 40; x++) {
		sq = square[x];
		left = 0;
		top = 0;

		for (var y = turn; y <= pcount; y++) {

			if (player[y].position == x && !player[y].jail) {
				var cls = 'cell-position' + (y === turn ? ' active-token' : '');
				document.getElementById("cell" + x + "positionholder").innerHTML += "<div class='" + cls + "' data-pnum='" + y + "' title='" + player[y].name + "' style='background-color: " + player[y].color + "; left: " + left + "px; top: " + top + "px;'></div>";
				if (left >= tokenSize * 2) {
					left = 0;
					top += tokenSize;
				} else
					left += tokenSize;
			}
		}

		for (var y = 1; y < turn; y++) {

			if (player[y].position == x && !player[y].jail) {
				var cls = 'cell-position' + (y === turn ? ' active-token' : '');
				document.getElementById("cell" + x + "positionholder").innerHTML += "<div class='" + cls + "' data-pnum='" + y + "' title='" + player[y].name + "' style='background-color: " + player[y].color + "; left: " + left + "px; top: " + top + "px;'></div>";
				if (left >= tokenSize * 2) {
					left = 0;
					top += tokenSize;
				} else
					left += tokenSize;
			}
		}
	}

	left = 0;
	top = 42;
	for (var i = turn; i <= pcount; i++) {
		if (player[i].jail) {
			var cls = 'cell-position' + (i === turn ? ' active-token' : '');
			document.getElementById("jailpositionholder").innerHTML += "<div class='" + cls + "' data-pnum='" + i + "' title='" + player[i].name + "' style='background-color: " + player[i].color + "; left: " + left + "px; top: " + top + "px;'></div>";

			if (left >= tokenSize * 2) {
				left = 0;
				top -= tokenSize;
			} else {
				left += tokenSize;
			}
		}
	}

	for (var i = 1; i < turn; i++) {
		if (player[i].jail) {
			var cls = 'cell-position' + (i === turn ? ' active-token' : '');
			document.getElementById("jailpositionholder").innerHTML += "<div class='" + cls + "' data-pnum='" + i + "' title='" + player[i].name + "' style='background-color: " + player[i].color + "; left: " + left + "px; top: " + top + "px;'></div>";
			if (left >= tokenSize * 2) {
				left = 0;
				top -= tokenSize;
			} else
				left += tokenSize;
		}
	}

	p = player[turn];

	if (p.jail) {
		document.getElementById("jail").style.border = "2px solid " + p.color;
	} else {
		document.getElementById("cell" + p.position).style.borderColor = p.color;
	}

	// for (var i=1; i <= pcount; i++) {
	// document.getElementById("enlarge"+player[i].position+"token").innerHTML+="<img src='"+tokenArray[i].src+"' height='30' width='30' />";
	// }
}

function updateMoney() {
	var p = player[turn];

	document.getElementById("pmoney").innerHTML = "$" + p.money;

	// Debt dashboard: total mortgage debt and interest per pass-GO.
	var debtEl = document.getElementById("pdebt");
	if (debtEl) {
		var debt = getMortgageDebt(p);
		var interest = debt > 0 ? Math.round(debt * INTEREST_RATE) : 0;
		if (debt > 0) {
			var debtHTML = "<span style='color:red;'>Debt: $" + debt + "</span> &nbsp;|&nbsp; "
				+ "<span style='color:red;'>Interest/lap: $" + interest + "</span>";
			debtEl.innerHTML = debtHTML;
			debtEl.style.display = "block";
		} else {
			debtEl.innerHTML = "";
			debtEl.style.display = "none";
		}
	}

	$(".money-bar-row").hide();

	// Build ranked player list sorted by net worth
	var ranked = [];
	for (var i = 1; i <= pcount; i++) {
		var pi = player[i];
		var assets = 0, debt = 0, houses = 0, hotels = 0, propCount = 0;
		for (var j = 0; j < 40; j++) {
			var sq = square[j];
			if (sq.owner === i) {
				propCount++;
				assets += sq.price;
				assets += sq.house * sq.houseprice;
				assets += sq.hotel * sq.houseprice;
				houses += sq.house;
				hotels += sq.hotel;
				if (sq.mortgage) debt += Math.round(sq.price * MORTGAGE_VALUE);
			}
		}
		var jailCards = (pi.communityChestJailCard ? 1 : 0) + (pi.chanceJailCard ? 1 : 0);
		var interest = debt > 0 ? Math.round(debt * INTEREST_RATE) : 0;
		var nw = pi.money + assets - debt;
		var dscr = getDSCR(pi);
		ranked.push({ index: i, name: pi.name, color: pi.color, money: pi.money,
			assets: assets, debt: debt, interest: interest, nw: nw, dscr: dscr,
			houses: houses, hotels: hotels, propCount: propCount,
			snipe: pi.snipeCard || false, jailCards: jailCards,
			bankrupt: pi.bankrupt || false });
	}
	ranked.sort(function(a, b) { return b.nw - a.nw; });

	for (var r = 0; r < ranked.length; r++) {
		var ri = r + 1; // display row 1-based
		var rd = ranked[r];
		var rowId = "moneybarrow" + ri;
		$("#" + rowId).show();

		var barEl = document.getElementById("p" + ri + "moneybar");
		barEl.style.border = "2px solid " + rd.color;
		barEl.style.opacity = rd.bankrupt ? "0.4" : "1";

		// Show arrow for current turn player
		var arrowEl = document.getElementById("p" + ri + "arrow");
		if (arrowEl) arrowEl.style.visibility = (rd.index === turn) ? "visible" : "hidden";

		var nameEl = document.getElementById("p" + ri + "moneyname");
		nameEl.innerHTML = rd.name;
		nameEl.style.color = rd.color;

		var moneyEl = document.getElementById("p" + ri + "money");
		var moneyDiv = moneyEl.parentNode;
		if (rd.bankrupt) {
			moneyDiv.innerHTML = "<span id='p" + ri + "money' style='color:#999;font-weight:bold;'>BANKRUPT</span>";
		} else {
			var html = "";
			// Row 1: Cash + NW
			html += "<span id='p" + ri + "money' style='color:#006600;font-weight:bold;font-size:13px;'>$" + rd.money + "</span>";
			html += " <span style='font-size:9px;color:#888;'>NW: $" + rd.nw + "</span>";
			// Row 2: Properties + Buildings
			html += "<div class='card-row card-badge-props'>";
			html += rd.propCount + " props";
			if (rd.houses > 0 || rd.hotels > 0) {
				html += " &middot; ";
				if (rd.houses > 0) html += rd.houses + "H";
				if (rd.hotels > 0) html += (rd.houses > 0 ? "+" : "") + rd.hotels + "★";
			}
			html += "</div>";
			// Row 3: Held cards + credit warning (badges)
			var hasBadges = rd.snipe || rd.jailCards > 0 || (rd.dscr !== Infinity && rd.dscr < DSCR_BORROW && rd.debt > 0);
			if (hasBadges) {
				html += "<div class='card-row'>";
				if (rd.snipe) html += "<span class='card-badge card-badge-snipe'>SNIPE</span><span class='card-help'>?<span class='card-help-tip'>" + t('help_snipe') + "</span></span>";
				if (rd.jailCards > 0) html += "<span class='card-badge card-badge-jail'>JAIL&times;" + rd.jailCards + "</span><span class='card-help'>?<span class='card-help-tip'>" + t('help_jail') + "</span></span>";
				if (rd.debt > 0 && rd.dscr !== Infinity && rd.dscr < DSCR_FLOOR) {
					html += "<span class='card-badge card-badge-credit-danger'>" + t('credit_danger')
						+ "</span><span class='card-help'>?<span class='card-help-tip'>" + t('help_credit_danger') + "</span></span>";
				} else if (rd.debt > 0 && rd.dscr !== Infinity && rd.dscr < DSCR_BORROW) {
					html += "<span class='card-badge card-badge-credit-warn'>" + t('credit_warning')
						+ "</span><span class='card-help'>?<span class='card-help-tip'>" + t('help_credit_warn') + "</span></span>";
				}
				html += "</div>";
			}
			// Row 4: Debt info (if applicable)
			if (rd.debt > 0) {
				html += "<div class='card-row' style='font-size:9px;'>";
				html += "<span style='color:#aa0000;'>Debt: $" + rd.debt + "</span>";
				if (rd.interest > 0) html += " &middot; <span style='color:#aa0000;'>Int: $" + rd.interest + "/lap</span>";
				html += "<span class='card-help'>?<span class='card-help-tip'>" + t('help_debt') + "</span></span>";
				html += "</div>";
			}
			moneyDiv.innerHTML = html;
		}
	}

	if (document.getElementById("landed").innerHTML === "") {
		$("#landed").hide();
	}

	document.getElementById("quickstats").style.borderColor = p.color;

	if (p.money < 0) {
		$("#resignbutton").show();
		$("#nextbutton").hide();
	} else {
		$("#resignbutton").hide();
		if (p.human) $("#nextbutton").show();
		else $("#nextbutton").hide();
	}
}

function updateDice() {
	var die0 = game.getDie(1);
	var die1 = game.getDie(2);

	$("#die0").show();
	$("#die1").show();

	if (document.images) {
		var element0 = document.getElementById("die0");
		var element1 = document.getElementById("die1");

		element0.classList.remove("die-no-img");
		element1.classList.remove("die-no-img");

		element0.title = "Die (" + die0 + " spots)";
		element1.title = "Die (" + die1 + " spots)";

		if (element0.firstChild) {
			element0 = element0.firstChild;
		} else {
			element0 = element0.appendChild(document.createElement("img"));
		}

		element0.src = "images/Die_" + die0 + ".png";
		element0.alt = die0;

		if (element1.firstChild) {
			element1 = element1.firstChild;
		} else {
			element1 = element1.appendChild(document.createElement("img"));
		}

		element1.src = "images/Die_" + die1 + ".png";
		element1.alt = die0;
	} else {
		document.getElementById("die0").textContent = die0;
		document.getElementById("die1").textContent = die1;

		document.getElementById("die0").title = "Die";
		document.getElementById("die1").title = "Die";
	}
}

// ---- Enhanced board visuals: buildings, rent, mortgage on each cell ----
function updateBoardCellVisuals() {
	for (var i = 0; i < 40; i++) {
		var sq = square[i];
		if (sq.groupNumber < 3) continue; // only color properties

		// --- Buildings ---
		var bldgEl = document.getElementById("cell" + i + "buildings");
		if (bldgEl) {
			bldgEl.innerHTML = "";
			if (sq.hotel) {
				var h = document.createElement("div");
				h.className = "cell-building-icon cell-building-hotel";
				h.title = "Hotel";
				bldgEl.appendChild(h);
			} else if (sq.house > 0) {
				for (var x = 0; x < sq.house; x++) {
					var hd = document.createElement("div");
					hd.className = "cell-building-icon cell-building-house";
					hd.title = "House";
					bldgEl.appendChild(hd);
				}
			}
		}

		// --- Rent display ---
		var rentEl = document.getElementById("cell" + i + "rent");
		if (rentEl) {
			if (sq.owner > 0 && !sq.mortgage) {
				var rent;
				if (sq.hotel) {
					rent = sq.rent5;
				} else if (sq.house > 0) {
					rent = sq["rent" + sq.house];
				} else {
					// Check if owner has monopoly
					var groupOwned = true;
					for (var j = 0; j < 40; j++) {
						if (square[j].groupNumber === sq.groupNumber && square[j].owner !== sq.owner) {
							groupOwned = false;
							break;
						}
					}
					rent = groupOwned ? sq.baserent * 2 : sq.baserent;
				}
				rentEl.textContent = "$" + rent;
				rentEl.style.display = "block";
			} else {
				rentEl.style.display = "none";
			}
		}

		// --- Mortgage overlay ---
		var mortEl = document.getElementById("cell" + i + "mortgage");
		if (mortEl) {
			mortEl.style.display = sq.mortgage ? "block" : "none";
		}
	}
}

function updateOwned() {
	var p = player[turn];
	var checkedproperty = getCheckedProperty();
	$("#option").show();
	$("#owned").show();

	var HTML = "",
	firstproperty = -1;

	var mortgagetext = "",
	housetext = "";
	var sq;

	for (var i = 0; i < 40; i++) {
		sq = square[i];
		if (sq.groupNumber && sq.owner === 0) {
			$("#cell" + i + "owner").hide();
		} else if (sq.groupNumber && sq.owner > 0) {
			var currentCellOwner = document.getElementById("cell" + i + "owner");

			currentCellOwner.style.display = "block";
			currentCellOwner.style.backgroundColor = player[sq.owner].color;
			currentCellOwner.title = player[sq.owner].name;
		}
	}

	for (var i = 0; i < 40; i++) {
		sq = square[i];
		if (sq.owner == turn) {

			mortgagetext = "";
			if (sq.mortgage) {
				mortgagetext = "title='Mortgaged' style='color: grey;'";
			}

			housetext = "";
			if (sq.house >= 1 && sq.house <= 4) {
				for (var x = 1; x <= sq.house; x++) {
					housetext += "<img src='images/house.png' alt='' title='House' class='house' />";
				}
			} else if (sq.hotel) {
				housetext += "<img src='images/hotel.png' alt='' title='Hotel' class='hotel' />";
			}

			if (HTML === "") {
				HTML += "<table>";
				firstproperty = i;
			}

			HTML += "<tr class='property-cell-row'><td class='propertycellcheckbox'><input type='checkbox' id='propertycheckbox" + i + "' /></td><td class='propertycellcolor' style='background: " + sq.color + ";";

			if (sq.groupNumber == 1 || sq.groupNumber == 2) {
				HTML += " border: 1px solid grey; width: 18px;";
			}

			HTML += "' onmouseover='showdeed(" + i + ");' onmouseout='hidedeed();'></td><td class='propertycellname' " + mortgagetext + ">" + sq.name + housetext + "</td></tr>";
		}
	}

	if (p.communityChestJailCard) {
		if (HTML === "") {
			firstproperty = 40;
			HTML += "<table>";
		}
		HTML += "<tr class='property-cell-row'><td class='propertycellcheckbox'><input type='checkbox' id='propertycheckbox40' /></td><td class='propertycellcolor' style='background: white;'></td><td class='propertycellname'>Get Out of Jail Free Card</td></tr>";

	}
	if (p.chanceJailCard) {
		if (HTML === "") {
			firstproperty = 41;
			HTML += "<table>";
		}
		HTML += "<tr class='property-cell-row'><td class='propertycellcheckbox'><input type='checkbox' id='propertycheckbox41' /></td><td class='propertycellcolor' style='background: white;'></td><td class='propertycellname'>Get Out of Jail Free Card</td></tr>";
	}
	if (p.snipeCard) {
		if (HTML === "") {
			firstproperty = 42;
			HTML += "<table>";
		}
		HTML += "<tr class='property-cell-row'><td class='propertycellcheckbox'><input type='checkbox' id='propertycheckbox42' /></td><td class='propertycellcolor' style='background: #006633;'></td><td class='propertycellname' style='color:#006633;font-weight:bold;'>Snipe Card</td></tr>";
	}

	if (HTML === "") {
		HTML = p.name + ", you don't have any properties.";
		$("#option").hide();
	} else {
		HTML += "</table>";
	}

	document.getElementById("owned").innerHTML = HTML;

	// Select previously selected property.
	if (checkedproperty > -1 && document.getElementById("propertycheckbox" + checkedproperty)) {
		document.getElementById("propertycheckbox" + checkedproperty).checked = true;
	} else if (firstproperty > -1) {
		document.getElementById("propertycheckbox" + firstproperty).checked = true;
	}
	$(".property-cell-row").click(function() {
		var row = this;

		// Toggle check the current checkbox.
		$(this).find(".propertycellcheckbox > input").prop("checked", function(index, val) {
			return !val;
		});

		// Set all other checkboxes to false.
		$(".propertycellcheckbox > input").prop("checked", function(index, val) {
			if (!$.contains(row, this)) {
				return false;
			}
		});

		updateOption();
	});
	updateOption();
	updateBoardCellVisuals();
	updateDebtMeter();
}

function updateOption() {
	$("#option").show();

	var allGroupUninproved = true;
	var allGroupUnmortgaged = true;
	var checkedproperty = getCheckedProperty();

	if (checkedproperty < 0 || checkedproperty >= 40) {
		$("#buyhousebutton").hide();
		$("#sellhousebutton").hide();
		$("#mortgagebutton").hide();


		var housesum = 32;
		var hotelsum = 12;

		for (var i = 0; i < 40; i++) {
			s = square[i];
			if (s.hotel == 1)
				hotelsum--;
			else
				housesum -= s.house;
		}

		$("#buildings").show();
		document.getElementById("buildings").innerHTML = "<img src='images/house.png' alt='' title='House' class='house' />:&nbsp;" + housesum + "&nbsp;&nbsp;<img src='images/hotel.png' alt='' title='Hotel' class='hotel' />:&nbsp;" + hotelsum;

		return;
	}

	$("#buildings").hide();
	var sq = square[checkedproperty];

	buyhousebutton = document.getElementById("buyhousebutton");
	sellhousebutton = document.getElementById("sellhousebutton");

	$("#mortgagebutton").show();
	document.getElementById("mortgagebutton").disabled = false;

	if (sq.mortgage) {
		document.getElementById("mortgagebutton").value = "Unmortgage ($" + Math.round(sq.price * 0.55) + ")";
		document.getElementById("mortgagebutton").title = "Unmortgage " + sq.name + " for $" + Math.round(sq.price * 0.55) + ".";
		$("#buyhousebutton").hide();
		$("#sellhousebutton").hide();

		allGroupUnmortgaged = false;
	} else {
		document.getElementById("mortgagebutton").value = "Mortgage ($" + (sq.price * 0.5) + ")";
		document.getElementById("mortgagebutton").title = "Mortgage " + sq.name + " for $" + (sq.price * 0.5) + ".";

		if (sq.groupNumber >= 3) {
			$("#buyhousebutton").show();
			$("#sellhousebutton").show();
			buyhousebutton.disabled = false;
			sellhousebutton.disabled = false;

			buyhousebutton.value = "Buy house ($" + sq.houseprice + ")";
			sellhousebutton.value = "Sell house ($" + (sq.houseprice * 0.5) + ")";
			buyhousebutton.title = "Buy a house for $" + sq.houseprice;
			sellhousebutton.title = "Sell a house for $" + (sq.houseprice * 0.5);

			if (sq.house == 4) {
				buyhousebutton.value = "Buy hotel ($" + sq.houseprice + ")";
				buyhousebutton.title = "Buy a hotel for $" + sq.houseprice;
			}
			if (sq.hotel == 1) {
				$("#buyhousebutton").hide();
				sellhousebutton.value = "Sell hotel ($" + (sq.houseprice * 0.5) + ")";
				sellhousebutton.title = "Sell a hotel for $" + (sq.houseprice * 0.5);
			}

			var maxhouse = 0;
			var minhouse = 5;

			var max = sq.group.length;
			for (var i = 0; i < max; i++) {
				s = square[sq.group[i]];

				if (s.owner !== sq.owner) {
					buyhousebutton.disabled = true;
					sellhousebutton.disabled = true;
					buyhousebutton.title = "Before you can buy a house, you must own all the properties of this color-group.";
				} else {

					if (s.house > maxhouse) {
						maxhouse = s.house;
					}

					if (s.house < minhouse) {
						minhouse = s.house;
					}

					if (s.house > 0 || s.hotel > 0) {
						allGroupUninproved = false;
					}

					if (s.mortgage) {
						allGroupUnmortgaged = false;
					}
				}
			}

			if (!allGroupUnmortgaged) {
				buyhousebutton.disabled = true;
				buyhousebutton.title = "Before you can buy a house, you must unmortgage all the properties of this color-group.";
			}

			// Force even building
			if (sq.house > minhouse) {
				buyhousebutton.disabled = true;

				if (sq.house == 1) {
					buyhousebutton.title = "Before you can buy another house, the other properties of this color-group must all have one house.";
				} else if (sq.house == 4) {
					buyhousebutton.title = "Before you can buy a hotel, the other properties of this color-group must all have 4 houses.";
				} else {
					buyhousebutton.title = "Before you can buy a house, the other properties of this color-group must all have " + sq.house + " houses.";
				}
			}
			if (sq.house < maxhouse) {
				sellhousebutton.disabled = true;

				if (sq.house == 1) {
					sellhousebutton.title = "Before you can sell house, the other properties of this color-group must all have one house.";
				} else {
					sellhousebutton.title = "Before you can sell a house, the other properties of this color-group must all have " + sq.house + " houses.";
				}
			}

			// Disable buy if player can't afford it
			if (player[turn].money < sq.houseprice) {
				buyhousebutton.disabled = true;
				buyhousebutton.title = "You can't afford a house ($" + sq.houseprice + "). Cash: $" + player[turn].money + ".";
			}

			if (sq.house === 0 && sq.hotel === 0) {
				$("#sellhousebutton").hide();

			} else {
				$("#mortgagebutton").hide();

			}

			// Before a property can be mortgaged or sold, all the properties of its color-group must unimproved.
			if (!allGroupUninproved) {
				document.getElementById("mortgagebutton").title = "Before a property can be mortgaged, all the properties of its color-group must unimproved.";
				document.getElementById("mortgagebutton").disabled = true;
			}

		} else {
			$("#buyhousebutton").hide();
			$("#sellhousebutton").hide();
		}

		// DSCR check: disable mortgage button if bank would refuse the loan.
		if (!sq.mortgage) {
			sq.mortgage = true;
			var simDSCR = getDSCR(player[turn]);
			sq.mortgage = false;
			if (simDSCR < DSCR_BORROW) {
				document.getElementById("mortgagebutton").disabled = true;
				document.getElementById("mortgagebutton").title = t('credit_danger');
			}
		}
	}
}

function chanceCommunityChest() {
	var p = player[turn];

	// Community Chest
	if (p.position === 2 || p.position === 17 || p.position === 33) {
		var communityChestIndex = communityChestCards.deck[communityChestCards.index];

		// Remove the get out of jail free card from the deck.
		if (communityChestIndex === 0) {
			communityChestCards.deck.splice(communityChestCards.index, 1);
		}

		boardMsg("<img src='images/community_chest_icon.png' style='height: 50px; width: 53px; float: left; margin: 8px 8px 8px 0px;' /><div style='font-weight: bold; font-size: 16px; '>Community Chest:</div><div style='text-align: justify;'>" + communityChestCards[communityChestIndex].text + "</div>", function() {
			communityChestAction(communityChestIndex);
		});

		communityChestCards.index++;

		if (communityChestCards.index >= communityChestCards.deck.length) {
			communityChestCards.index = 0;
		}

	// Chance
	} else if (p.position === 7 || p.position === 22 || p.position === 36) {
		var chanceIndex = chanceCards.deck[chanceCards.index];

		// Remove holdable cards from the deck (jail card = 0, snipe card = 1).
		if (chanceIndex === 0 || chanceIndex === 1) {
			chanceCards.deck.splice(chanceCards.index, 1);
		}

		boardMsg("<img src='images/chance_icon.png' style='height: 50px; width: 26px; float: left; margin: 8px 8px 8px 0px;' /><div style='font-weight: bold; font-size: 16px; '>Chance:</div><div style='text-align: justify;'>" + chanceCards[chanceIndex].text + "</div>", function() {
			chanceAction(chanceIndex);
		});

		chanceCards.index++;

		if (chanceCards.index >= chanceCards.deck.length) {
			chanceCards.index = 0;
		}
	} else {
		if (!p.human) {
			p.AI.alertList = "";

			if (!p.AI.onLand()) {
				game.next();
			}
		}
	}
}

function chanceAction(chanceIndex) {
	var p = player[turn]; // This is needed for reference in action() method.

	// $('#popupbackground').hide();
	// $('#popupwrap').hide();
	chanceCards[chanceIndex].action(p);

	updateMoney();

	if (chanceIndex !== 15 && !p.human) {
		p.AI.alertList = "";
		game.next();
	}
}

function communityChestAction(communityChestIndex) {
	var p = player[turn]; // This is needed for reference in action() method.

	communityChestCards[communityChestIndex].action(p);

	updateMoney();

	// Don't advance turn if catastrophe or other async card is handling flow
	if (_catastrophePending) return;

	if (communityChestIndex !== 15 && !p.human) {
		p.AI.alertList = "";
		game.next();
	}
}

function addamount(amount, cause) {
	var p = player[turn];

	p.money += amount;

	addAlert(t('msg_received', {name: p.name, amount: amount, cause: cause}));
}

function subtractamount(amount, cause) {
	var p = player[turn];

	p.pay(amount, 0);

	addAlert(t('msg_lost', {name: p.name, amount: amount, cause: cause}));
}

function gotojail() {
	var p = player[turn];
	addAlert(t('msg_jail', {name: p.name}));
	setLanded(t('pop_jail_in'));

	p.jail = true;
	p.position = 10; // Move to jail square
	doublecount = 0;

	updatePosition();

	document.getElementById("nextbutton").value = "End turn";
	document.getElementById("nextbutton").title = "End turn and advance to the next player.";

	if (p.human) {
		document.getElementById("nextbutton").focus();
	}

	updatePosition();
	updateOwned();

	if (!p.human) {
		boardMsg(p.AI.alertList, game.next);
		p.AI.alertList = "";
	}
}

function gobackthreespaces() {
	var p = player[turn];

	p.position -= 3;

	land();
}

function payeachplayer(amount, cause) {
	var p = player[turn];
	var total = 0;

	for (var i = 1; i <= pcount; i++) {
		if (i != turn) {
			player[i].money += amount;
			total += amount;
			creditor = p.money >= 0 ? i : creditor;

			p.pay(amount, creditor);
		}
	}

	addAlert(t('msg_lost', {name: p.name, amount: total, cause: cause}));
}

function collectfromeachplayer(amount, cause) {
	var p = player[turn];
	var total = 0;

	for (var i = 1; i <= pcount; i++) {
		if (i != turn) {
			money = player[i].money;
			if (money < amount) {
				p.money += money;
				total += money;
				player[i].money = 0;
			} else {
				player[i].pay(amount, turn);
				p.money += amount;
				total += amount;
			}
		}
	}

	addAlert(t('msg_received', {name: p.name, amount: total, cause: cause}));
}

function advance(destination, pass) {
	var p = player[turn];

	if (typeof pass === "number") {
		if (p.position < pass) {
			p.position = pass;
		} else {
			p.position = pass;
			collectSalaryAndPayInterest(p);
		}
	}
	if (p.position < destination) {
		p.position = destination;
	} else {
		p.position = destination;
		var blocked = collectSalaryAndPayInterest(p, land);
		if (blocked) return;
	}

	land();
}

function advanceToNearestUtility() {
	var p = player[turn];

	if (p.position < 12) {
		p.position = 12;
	} else if (p.position >= 12 && p.position < 28) {
		p.position = 28;
	} else if (p.position >= 28) {
		p.position = 12;
		var blocked = collectSalaryAndPayInterest(p, function() { land(true); });
		if (blocked) return;
	}

	land(true);
}

function advanceToNearestRailroad() {
	var p = player[turn];

	updatePosition();

	if (p.position < 15) {
		p.position = 15;
	} else if (p.position >= 15 && p.position < 25) {
		p.position = 25;
	} else if (p.position >= 35) {
		p.position = 5;
		var blocked = collectSalaryAndPayInterest(p, function() { land(true); });
		if (blocked) return;
	}

	land(true);
}

function streetrepairs(houseprice, hotelprice) {
	var cost = 0;
	for (var i = 0; i < 40; i++) {
		var s = square[i];
		if (s.owner == turn) {
			if (s.hotel == 1)
				cost += hotelprice;
			else
				cost += s.house * houseprice;
		}
	}

	var p = player[turn];

	if (cost > 0) {
		p.pay(cost, 0);

		// If function was called by Community Chest.
		if (houseprice === 40) {
			addAlert(t('msg_lost_cc', {name: p.name, amount: cost}));
		} else {
			addAlert(t('msg_lost_ch', {name: p.name, amount: cost}));
		}
	}

}

// ============================================================
// Tycoon Saigon Event Cards
// ============================================================

// Snipe card execution (called from auction popup)
function executeSnipe(playerIndex, squareIndex) {
	var sp = player[playerIndex];
	var s = square[squareIndex];
	sp.snipeCard = false;
	sp.money -= s.price;
	s.owner = playerIndex;
	trackEvent("snipe_used", { player: sp.name, property: s.name, price: s.price });
	addAlert(t('msg_snipe', {name: sp.name, prop: s.name, amount: s.price}));

	// During liquidation, snipe proceeds go to the bankrupt player
	if (typeof game !== "undefined" && game.getLiquidation && game.getLiquidation()) {
		var liq = game.getLiquidation();
		for (var li = 1; li <= pcount; li++) {
			if (player[li].name === liq.playerName) {
				player[li].money += s.price;
				break;
			}
		}
	}

	updateMoney();
	updateOwned();
	$("#popupbackground").hide();
	$("#popupwrap").hide();
	// During liquidation, check if bankrupt player is now solvent
	if (typeof game !== "undefined" && game.getLiquidation && game.getLiquidation() && game.checkLiquidationSolvent()) {
		return;
	}
	if (!game.auction()) {
		if (typeof game !== "undefined" && game.getLiquidation && game.getLiquidation()) {
			game.settleLiquidation();
		} else {
			play();
		}
	}
}

function skipSnipe(squareIndex) {
	// Close the snipe popup, re-enter auction normally by re-queuing
	$("#popupbackground").hide();
	$("#popupwrap").hide();
	game.addPropertyToAuctionQueue(squareIndex);
	// Temporarily disable snipe cards so we don't loop
	var savedSnipes = [];
	for (var i = 1; i <= pcount; i++) {
		savedSnipes[i] = player[i].snipeCard;
		player[i].snipeCard = false;
	}
	game.auction();
	// Restore snipe cards
	for (var j = 1; j <= pcount; j++) {
		player[j].snipeCard = savedSnipes[j];
	}
}

// Fire-sale snipe: human player cherry-picks a property before auctions begin
function executeFireSaleSnipe(playerIndex, squareIndex) {
	var sp = player[playerIndex];
	var s = square[squareIndex];
	var q = game.getAuctionQueue();
	sp.snipeCard = false;
	sp.money -= s.price;
	s.owner = playerIndex;
	addAlert(t('msg_snipe', {name: sp.name, prop: s.name, amount: s.price}));

	// Proceeds to bankrupt player
	var liq = game.getLiquidation();
	if (liq) {
		for (var li = 1; li <= pcount; li++) {
			if (player[li].name === liq.playerName) {
				player[li].money += s.price;
				break;
			}
		}
	}

	// Remove from auction queue
	var qi = q.indexOf(squareIndex);
	if (qi >= 0) q.splice(qi, 1);

	updateMoney();
	updateOwned();
	$("#popupbackground").hide();
	$("#popupwrap").hide();

	// Check if snipe alone made player solvent
	if (liq && game.checkLiquidationSolvent()) return;

	// Proceed to fire sale popup → auctions
	if (q.length === 0) {
		game.settleLiquidation();
		return;
	}
	var creditorLabel = liq.creditorIndex !== 0 ? liq.creditorName : "the bank";
	var bp = null;
	for (var li = 1; li <= pcount; li++) {
		if (player[li].name === liq.playerName) { bp = player[li]; break; }
	}
	boardMsg(
		"<div class='interest-alert' style='background:#cc3300;color:white;'>"
		+ "<h3>FIRE SALE — " + liq.playerName + "</h3>"
		+ "<p>Owes $" + liq.rentOwed + " to " + creditorLabel + ".</p>"
		+ "<p>Cash: <strong>$" + (bp ? bp.money : "?") + "</strong></p>"
		+ "<p><strong>" + q.length + " properties</strong> going to auction!</p>"
		+ "</div>",
		function() { game.auction(); }
	);
}

function skipFireSaleSnipe() {
	$("#popupbackground").hide();
	$("#popupwrap").hide();
	var liq = game.getLiquidation();
	var q = game.getAuctionQueue();
	if (!liq) return;

	if (q.length === 0) {
		game.settleLiquidation();
		return;
	}
	var creditorLabel = liq.creditorIndex !== 0 ? liq.creditorName : "the bank";
	var bp = null;
	for (var li = 1; li <= pcount; li++) {
		if (player[li].name === liq.playerName) { bp = player[li]; break; }
	}
	addAlert(t('msg_auction_count', {count: q.length, name: liq.playerName}));
	boardMsg(
		"<div class='interest-alert' style='background:#cc3300;color:white;'>"
		+ "<h3>FIRE SALE — " + liq.playerName + "</h3>"
		+ "<p>Owes $" + liq.rentOwed + " to " + creditorLabel + ".</p>"
		+ "<p>Cash: <strong>$" + (bp ? bp.money : "?") + "</strong></p>"
		+ "<p><strong>" + q.length + " properties</strong> going to auction!</p>"
		+ "</div>",
		function() { game.auction(); }
	);
}

// Get total mortgage debt across all active players
function getSystemDebt() {
	var total = 0;
	for (var i = 1; i <= pcount; i++) {
		if (player[i].bankrupt) continue;
		total += getMortgageDebt(player[i]);
	}
	return total;
}

// Update the macro debt meter in the board center.
function updateDebtMeter() {
	var meter = document.getElementById("debt-meter");
	if (!meter) return;
	var debt = getSystemDebt();
	var threshold = BUBBLE_THRESHOLD;
	meter.style.display = "block";
	document.getElementById("debt-meter-amount").textContent = debt;
	document.getElementById("debt-meter-threshold").textContent = threshold;
	var pct = Math.min((debt / threshold) * 100, 100);
	var fill = document.getElementById("debt-meter-fill");
	fill.style.width = pct + "%";
	fill.className = "debt-meter-bar" + (crisisActive ? " crisis" : pct >= 80 ? " danger" : pct >= 50 ? " warning" : "");

	// Update crisis banner with current debt
	if (crisisActive) {
		var banner = document.getElementById("crisis-banner");
		if (banner) {
			var crisisRate = Math.round(INTEREST_RATE * CRISIS_INTEREST_MULT * 100);
			banner.innerHTML = "⚠ CRISIS — Debt: $" + debt + "/$" + threshold
				+ " — Interest: <span class='crisis-rate'>" + crisisRate + "%</span>"
				+ " — Deleverage to end ⚠";
		}
	}
}

// Check if bubble should pop — called at start of each player cycle
function checkBubble() {
	if (!EVENTS_ENABLED) return;
	if (crisisActive) return;
	if (gameRound - lastCrisisRound < 8) return;

	var debt = getSystemDebt();
	if (debt >= BUBBLE_THRESHOLD) {
		crisisActive = true;
		crisisRound = gameRound;
		trackEvent("crisis_triggered", { debt: debt, round: gameRound });
		addAlert(t('msg_crisis', {debt: debt, threshold: BUBBLE_THRESHOLD}));

		// Show persistent crisis banner
		var banner = document.getElementById("crisis-banner");
		if (banner) {
			var crisisRate = Math.round(INTEREST_RATE * CRISIS_INTEREST_MULT * 100);
			banner.innerHTML = "⚠ FINANCIAL CRISIS — Interest: <span class='crisis-rate'>" + crisisRate + "%</span>"
				+ " — Deleverage below $" + BUBBLE_THRESHOLD + " to end ⚠";
			banner.style.display = "block";
		}

		if (typeof boardMsg === "function") {
			boardMsg(
				"<div class='interest-alert' style='background:#ff4444;color:white;'>"
				+ "<h3>" + t('pop_crisis_title') + "</h3>"
				+ "<p>" + t('pop_crisis_desc', {debt: debt}) + "</p>"
				+ "<p>" + t('pop_crisis_spike', {rate: Math.round(INTEREST_RATE * CRISIS_INTEREST_MULT * 100)}) + "</p>"
				+ "<p>" + t('pop_crisis_warn') + "</p>"
				+ "</div>"
			);
		}
	}
}

// End crisis when system debt drops below threshold
function endCrisis() {
	if (crisisActive) {
		var debt = getSystemDebt();
		if (debt < BUBBLE_THRESHOLD) {
			crisisActive = false;
			lastCrisisRound = gameRound;
			addAlert(t('msg_crisis_end', {rate: Math.round(INTEREST_RATE * 100)}));

			// Hide crisis banner
			var banner = document.getElementById("crisis-banner");
			if (banner) banner.style.display = "none";
		}
	}
}

// Catastrophe card: ALL players pay CATASTROPHE_MULT × a dice roll
var _catastrophePending = false;

function catastrophe() {
	if (!EVENTS_ENABLED) {
		streetrepairs(40, 115); // fallback
		return;
	}

	_catastrophePending = true; // Signal to communityChestAction to not advance turn

	var p = player[turn];
	if (!p.human) {
		// AI: auto-roll immediately, no UI
		catastropheRoll();
		return;
	}

	// Human: Show the catastrophe announcement with a Roll button
	var announceHtml = "<div class='interest-alert' style='background:#cc3300;color:white;padding:15px;border-radius:8px;'>"
		+ "<h3 style='margin-top:0;color:#ffcc00;'>CATASTROPHE!</h3>"
		+ "<p>" + t('cc14').split('.')[0] + ".</p>"
		+ "<p style='font-size:12px;opacity:0.8;'>" + CATASTROPHE_MULT + "× dice roll</p>"
		+ "<div style='margin-top:12px;'><input type='button' value='🎲 Roll!' onclick='catastropheRoll();' "
		+ "style='padding:8px 28px;font-size:16px;font-weight:bold;cursor:pointer;background:#ffcc00;color:#333;border:none;border-radius:6px;' /></div>"
		+ "</div>";

	boardMsg(announceHtml, function() {});
	var okBtn = document.getElementById("board-msg-btn");
	if (okBtn) okBtn.style.display = "none";
}

function catastropheRoll() {
	var diceEmoji = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
	var results = [];
	for (var i = 1; i <= pcount; i++) {
		if (player[i].bankrupt) continue;
		var d1 = Math.floor(Math.random() * 6) + 1;
		var d2 = Math.floor(Math.random() * 6) + 1;
		var cost = (d1 + d2) * CATASTROPHE_MULT;
		player[i].money -= cost;
		results.push({ name: player[i].name, color: player[i].color,
			d1: d1, d2: d2, roll: d1 + d2, cost: cost });
		addAlert(t('msg_catastrophe', {name: player[i].name, cost: cost, roll: (d1 + d2), mult: CATASTROPHE_MULT}));
	}

	var html = "<div class='interest-alert' style='background:#cc3300;color:white;padding:15px;border-radius:8px;'>"
		+ "<h3 style='margin-top:0;color:#ffcc00;'>CATASTROPHE!</h3>"
		+ "<table style='width:100%;color:white;border-collapse:collapse;margin-top:8px;'>"
		+ "<tr style='border-bottom:1px solid rgba(255,255,255,0.3);font-size:11px;'>"
		+ "<th style='text-align:left;padding:4px;'>Player</th>"
		+ "<th style='text-align:center;padding:4px;'>Dice</th>"
		+ "<th style='text-align:right;padding:4px;'>Cost</th></tr>";
	for (var r = 0; r < results.length; r++) {
		var rd = results[r];
		html += "<tr style='border-bottom:1px solid rgba(255,255,255,0.15);'>"
			+ "<td style='padding:5px 4px;font-weight:bold;color:" + rd.color + ";'>" + rd.name + "</td>"
			+ "<td style='text-align:center;font-size:22px;padding:4px;'>" + diceEmoji[rd.d1] + " " + diceEmoji[rd.d2] + "</td>"
			+ "<td style='text-align:right;padding:4px;font-weight:bold;color:#ffcc00;'>-$" + rd.cost + "</td>"
			+ "</tr>";
	}
	html += "</table></div>";

	if (typeof updateMoney === "function") updateMoney();

	// Check if any player is now in debt
	for (var j = 1; j <= pcount; j++) {
		if (player[j].bankrupt) continue;
		if (player[j].money < 0) {
			player[j].creditor = 0;
			addAlert(t('msg_catastrophe_debt', {name: player[j].name}));
			// AI auto-resolve
			if (!player[j].human && player[j].AI && player[j].AI.payDebt) {
				player[j].AI.payDebt();
			}
		}
	}

	_catastrophePending = false;

	boardMsg(html, function() {
		updateMoney();
		// If it was an AI's turn, advance the game
		var p = player[turn];
		if (!p.human) {
			p.AI.alertList = "";
			game.next();
		}
	});
}

// Property Tax Reassessment: ALL players pay per house/hotel they own
function propertyTaxReassessment() {
	if (!EVENTS_ENABLED) {
		subtractamount(15, 'Cơ Hội');
		return;
	}

	var results = [];
	for (var pi = 1; pi <= pcount; pi++) {
		if (player[pi].bankrupt) continue;
		var houses = 0, hotels = 0;
		for (var i = 0; i < 40; i++) {
			if (square[i].owner === pi) {
				if (square[i].hotel === 1) hotels++;
				else houses += square[i].house;
			}
		}
		var cost = houses * TAX_PER_HOUSE + hotels * TAX_PER_HOTEL;
		if (cost > 0) {
			player[pi].money -= cost;
			results.push({ name: player[pi].name, houses: houses, hotels: hotels, cost: cost, idx: pi });
			addAlert(t('msg_prop_tax', {name: player[pi].name, cost: cost, houses: houses, hotels: hotels}));
		} else {
			results.push({ name: player[pi].name, houses: 0, hotels: 0, cost: 0, idx: pi });
		}
	}

	var html = "<div class='interest-alert' style='background:#cc6600;color:white;'>"
		+ "<h3>Property Tax Reassessment!</h3>"
		+ "<p>All property owners are reassessed: $" + TAX_PER_HOUSE + "/house, $" + TAX_PER_HOTEL + "/hotel.</p>"
		+ "<table style='width:100%;color:white;'>";
	for (var r = 0; r < results.length; r++) {
		html += "<tr><td>" + results[r].name + "</td><td>" + results[r].houses + " houses, " + results[r].hotels + " hotels</td><td>"
			+ (results[r].cost > 0 ? "-$" + results[r].cost : "no charge") + "</td></tr>";
	}
	html += "</table></div>";
	if (typeof boardMsg === "function") boardMsg(html);

	if (typeof updateMoney === "function") updateMoney();

	// Check if any player is now in debt
	for (var j = 0; j < results.length; j++) {
		if (results[j].cost > 0 && player[results[j].idx].money < 0) {
			player[results[j].idx].creditor = 0;
			addAlert(t('msg_prop_tax_debt', {name: player[results[j].idx].name}));
		}
	}
}

// Snipe card: holdable — grab a foreclosed/auctioned property at face value
function drawSnipeCard() {
	if (!EVENTS_ENABLED) {
		subtractamount(25, 'Cơ Hội'); // fallback: old streetRepairs-like
		streetrepairs(25, 100);
		return;
	}
	var p = player[turn];
	p.snipeCard = true;
	addAlert(t('msg_snipe_draw', {name: p.name}));
	if (typeof updateOwned === "function") updateOwned();

	if (typeof boardMsg === "function") {
		boardMsg(
			"<div class='interest-alert' style='background:#006633;color:white;'>"
			+ "<h3>Snipe Card!</h3>"
			+ "<p>Hold this card. When any property goes to auction, you can play it to</p>"
			+ "<p>grab the property at <strong>face value</strong> — bypassing all other bids!</p>"
			+ "</div>"
		);
	}
}

// ---- Casino (position 20, replaces Free Parking) ----
function casino() {
	if (!CASINO_ENABLED) return;
	var p = player[turn];

	if (!p.human) {
		// AI decides whether and how much to bet
		var tierIndex = p.AI.casinoBet ? p.AI.casinoBet(p) : -1;
		if (tierIndex < 0 || tierIndex >= CASINO_TIERS.length) {
			addAlert(t('msg_casino_skip', {name: p.name}));
			return;
		}
		var tier = CASINO_TIERS[tierIndex];
		if (p.money < tier.bet) {
			addAlert(t('msg_casino_broke', {name: p.name}));
			return;
		}
		casinoRoll(p, tier);
		return;
	}

	// Human player — show betting popup
	var html = "<div class='interest-alert' style='background:#1a1a2e;color:#e0c068;'>"
		+ "<h3 style='color:#ffd700;border-color:#ffd700;'>" + t('casino_title') + "</h3>"
		+ "<p>" + t('casino_place_bet') + "</p>"
		+ "<p style='font-size:12px;color:#ccc;'>" + t('casino_need_doubles') + "</p>"
		+ "<div style='margin:10px 0;'>";

	for (var i = 0; i < CASINO_TIERS.length; i++) {
		var tier = CASINO_TIERS[i];
		var disabled = p.money < tier.bet ? " disabled style='opacity:0.4;'" : "";
		html += "<div style='margin:4px 0;'>"
			+ "<input type='button' onclick='casinoSelect(" + i + ");' value='" + getCasinoTierLabel(tier) + "'"
			+ disabled + " style='width:100%;padding:6px;font-size:12px;background:#2a2a4e;color:#e0c068;border:1px solid #ffd700;cursor:pointer;' />"
			+ "</div>";
	}
	html += "<div style='margin:8px 0;'>"
		+ "<input type='button' onclick='casinoSkip();' value='" + t('casino_walk_away') + "' "
		+ "style='width:100%;padding:6px;font-size:12px;background:#333;color:#aaa;border:1px solid #666;cursor:pointer;' />"
		+ "</div></div></div>";

	popup(html);
}

// Auction: temporarily show the current bidder's Manage panel to sell/mortgage
var _auctionSavedTurn = null;
var _tradeConfirmed = false;
function auctionRaiseMoney() {
	// Find the current human bidder
	// currentbidder is inside Game closure, but we can find who's bidding from the UI
	// Temporarily swap `turn` to the human player so updateOwned() shows their properties
	for (var i = 1; i <= pcount; i++) {
		if (player[i].human && !player[i].bankrupt) {
			_auctionSavedTurn = turn;
			turn = i;
			break;
		}
	}
	// Switch to manage view
	$("#buy").hide();
	$("#manage").show();
	updateOwned();
	updateMoney();
	// Hide the auction bar and game buttons
	var aBar = document.getElementById("auction-bar");
	if (aBar) aBar.style.display = "none";
	$("#center-game-buttons").hide();
	// Add a "Back to Auction" button in the landed area
	setLanded("<div style='text-align:center;padding:4px;'>"
		+ "<input type='button' value='↩ " + t('btn_back_to_auction') + "' onclick='auctionBackFromRaise();' "
		+ "style='padding:6px 16px;cursor:pointer;font-size:13px;background:#DAA520;color:#333;border:1px solid #b8860b;border-radius:4px;font-weight:bold;' />"
		+ "</div>");
}

function auctionBackFromRaise() {
	// Restore the original turn
	if (_auctionSavedTurn !== null) {
		turn = _auctionSavedTurn;
		_auctionSavedTurn = null;
	}
	// Switch back to buy view and show auction bar + game buttons
	$("#manage").hide();
	$("#buy").show();
	$("#landed").hide();
	$("#center-game-buttons").show();
	var aBar = document.getElementById("auction-bar");
	if (aBar) aBar.style.display = "block";
	// Update cash display in auction
	updateMoney();
	var cashEl = document.getElementById("auction-cash");
	for (var i = 1; i <= pcount; i++) {
		if (player[i].human && !player[i].bankrupt) {
			if (cashEl) cashEl.textContent = "($" + player[i].money + ")";
			break;
		}
	}
}

// Auction exit confirmation (replaces native confirm)
function confirmAuctionExit() {
	popup("<p>" + t('btn_exit_auction') + "?</p>", function() { game.auctionExit(); }, "yes/no");
}

// Auction bid stepper — step up/down by $10
function auctionStepBid(step) {
	var bidVal = document.getElementById("bidvalue");
	var bidDisp = document.getElementById("bid");
	if (!bidVal || !bidDisp) return;
	var current = parseInt(bidVal.value, 10) || 0;
	var next = current + step;
	if (next < 10) next = 10;
	bidVal.value = next;
	bidDisp.textContent = "$" + next;
	bidDisp.style.color = "#DAA520";
}

function casinoSelect(tierIndex) {
	var p = player[turn];
	var tier = CASINO_TIERS[tierIndex];
	if (p.money < tier.bet) return;
	// Dismiss the casino betting popup before rolling
	$("#popupbackground").hide();
	$("#popupwrap").hide();
	casinoRoll(p, tier);
}

function casinoSkip() {
	// Dismiss the casino betting popup
	$("#popupbackground").hide();
	$("#popupwrap").hide();
	addAlert(t('msg_casino_walk', {name: player[turn].name}));
	boardMsg(t('pop_casino_skip'), function() {});
}

function casinoRoll(p, tier) {
	// Roll 2 dice
	var d1 = Math.floor(Math.random() * 6) + 1;
	var d2 = Math.floor(Math.random() * 6) + 1;
	var isDouble = (d1 === d2);
	var win = isDouble && d1 >= tier.minDouble;

	// Deduct bet
	p.money -= tier.bet;

	var html = "<div class='interest-alert' style='background:#1a1a2e;color:#e0c068;'>"
		+ "<h3 style='color:#ffd700;border-color:#ffd700;'>" + t('casino_roll_title') + "</h3>"
		+ "<p>" + t('casino_bets', {name: p.name, bet: tier.bet, min: tier.minDouble}) + "</p>"
		+ "<p style='font-size:28px;letter-spacing:8px;margin:12px 0;'>";

	// Dice display
	var diceChars = ['⚀','⚁','⚂','⚃','⚄','⚅'];
	html += diceChars[d1-1] + " " + diceChars[d2-1];
	html += "</p>";

	trackEvent("casino_bet", { player: p.name, bet: tier.bet, won: win, payout: win ? tier.payout : 0 });
	if (win) {
		p.money += tier.payout;
		addAlert(t('msg_casino_win', {name: p.name, bet: tier.bet, d1: d1, d2: d2, payout: tier.payout}));
		html += "<p style='font-size:20px;color:#00ff00;font-weight:bold;'>" + t('casino_jackpot', {payout: tier.payout}) + "</p>"
			+ "<p style='color:#88ff88;'>" + t('casino_net_profit', {profit: (tier.payout - tier.bet)}) + "</p>";
	} else {
		addAlert(t('msg_casino_loss', {name: p.name, bet: tier.bet, d1: d1, d2: d2}));
		html += "<p style='font-size:20px;color:#ff4444;font-weight:bold;'>" + t('casino_no_luck', {bet: tier.bet}) + "</p>";
		if (isDouble) {
			html += "<p style='color:#ff8888;font-size:11px;'>" + t('casino_rolled_low', {rolled: d1, min: tier.minDouble}) + "</p>";
		}
	}

	html += "</div>";

	updateMoney();
	boardMsg(html, function() {});
}

function payfifty() {
	var p = player[turn];

	document.getElementById("jail").style.border = '1px solid black';
	document.getElementById("cell11").style.border = '2px solid ' + p.color;

	$("#landed").hide();
	doublecount = 0;

	p.jail = false;
	p.jailroll = 0;
	p.position = 10;
	p.pay(50, 0);

	addAlert(t('msg_jail_fine', {name: p.name}));
	updateMoney();
	updatePosition();
}

function useJailCard() {
	var p = player[turn];

	document.getElementById("jail").style.border = '1px solid black';
	document.getElementById("cell11").style.border = '2px solid ' + p.color;

	$("#landed").hide();
	p.jail = false;
	p.jailroll = 0;

	p.position = 10;

	doublecount = 0;

	if (p.communityChestJailCard) {
		p.communityChestJailCard = false;

		// Insert the get out of jail free card back into the community chest deck.
		communityChestCards.deck.splice(communityChestCards.index, 0, 0);

		communityChestCards.index++;

		if (communityChestCards.index >= communityChestCards.deck.length) {
			communityChestCards.index = 0;
		}
	} else if (p.chanceJailCard) {
		p.chanceJailCard = false;

		// Insert the get out of jail free card back into the chance deck.
		chanceCards.deck.splice(chanceCards.index, 0, 0);

		chanceCards.index++;

		if (chanceCards.index >= chanceCards.deck.length) {
			chanceCards.index = 0;
		}
	}

	addAlert(t('msg_jail_card', {name: p.name}));
	updateOwned();
	updatePosition();
}

function buyHouse(index) {
	var sq = square[index];
	var p = player[sq.owner];
	var houseSum = 0;
	var hotelSum = 0;

	// Monopoly rule: cannot build if any property in the group is mortgaged.
	if (sq.group && sq.group.length > 0) {
		for (var g = 0; g < sq.group.length; g++) {
			if (square[sq.group[g]].mortgage) return false;
		}
	}

	if (p.money - sq.houseprice < 0) {
		if (sq.house == 4) {
			return false;
		} else {
			return false;
		}

	} else {
		for (var i = 0; i < 40; i++) {
			if (square[i].hotel === 1) {
				hotelSum++;
			} else {
				houseSum += square[i].house;
			}
		}

		if (sq.house < 4) {
			if (houseSum >= 32) {
				return false;

			} else {
				sq.house++;
				addAlert(t('msg_house', {name: p.name, prop: sq.name}));
			}

		} else {
			if (hotelSum >= 12) {
				return;

			} else {
				sq.house = 5;
				sq.hotel = 1;
				addAlert(t('msg_hotel', {name: p.name, prop: sq.name}));
			}
		}

		p.pay(sq.houseprice, 0);

		updateOwned();
		updateMoney();
	}
}

function sellHouse(index) {
	sq = square[index];
	p = player[sq.owner];

	if (sq.hotel === 1) {
		sq.hotel = 0;
		sq.house = 4;
		addAlert(t('msg_sell_hotel', {name: p.name, prop: sq.name}));
	} else {
		sq.house--;
		addAlert(t('msg_sell_house', {name: p.name, prop: sq.name}));
	}

	p.money += sq.houseprice * 0.5;
	updateOwned();
	updateMoney();
}

function showStats() {
	var HTML, sq, p;
	var mortgagetext,
	housetext;
	var write;
	HTML = "<table align='center'><tr>";

	for (var x = 1; x <= pcount; x++) {
		write = false;
		p = player[x];
		if (x == 5) {
			HTML += "</tr><tr>";
		}
		HTML += "<td class='statscell' id='statscell" + x + "' style='border: 2px solid " + p.color + "' ><div class='statsplayername'>" + p.name + "</div>";

		for (var i = 0; i < 40; i++) {
			sq = square[i];

			if (sq.owner == x) {
				mortgagetext = "",
				housetext = "";

				if (sq.mortgage) {
					mortgagetext = "title='Mortgaged' style='color: grey;'";
				}

				if (!write) {
					write = true;
					HTML += "<table>";
				}

				if (sq.house == 5) {
					housetext += "<span style='float: right; font-weight: bold;'>1&nbsp;x&nbsp;<img src='images/hotel.png' alt='' title='Hotel' class='hotel' style='float: none;' /></span>";
				} else if (sq.house > 0 && sq.house < 5) {
					housetext += "<span style='float: right; font-weight: bold;'>" + sq.house + "&nbsp;x&nbsp;<img src='images/house.png' alt='' title='House' class='house' style='float: none;' /></span>";
				}

				HTML += "<tr><td class='statscellcolor' style='background: " + sq.color + ";";

				if (sq.groupNumber == 1 || sq.groupNumber == 2) {
					HTML += " border: 1px solid grey;";
				}

				HTML += "' onmouseover='showdeed(" + i + ");' onmouseout='hidedeed();'></td><td class='statscellname' " + mortgagetext + ">" + sq.name + housetext + "</td></tr>";
			}
		}

		if (p.communityChestJailCard) {
			if (!write) {
				write = true;
				HTML += "<table>";
			}
			HTML += "<tr><td class='statscellcolor'></td><td class='statscellname'>Get Out of Jail Free Card</td></tr>";

		}
		if (p.chanceJailCard) {
			if (!write) {
				write = true;
				HTML += "<table>";
			}
			HTML += "<tr><td class='statscellcolor'></td><td class='statscellname'>Get Out of Jail Free Card</td></tr>";

		}

		if (!write) {
			HTML += p.name + " dosen't have any properties.";
		} else {
			HTML += "</table>";
		}

		HTML += "</td>";
	}
	HTML += "</tr></table><div id='titledeed'></div>";

	document.getElementById("statstext").innerHTML = HTML;
	// Show using animation.
	$("#statsbackground").fadeIn(400, function() {
		$("#statswrap").show();
	});
}

function showdeed(property) {
	var sq = square[property];
	var deedEl = document.getElementById("deed");
	$(deedEl).show();

	$("#deed-normal").hide();
	$("#deed-mortgaged").hide();
	$("#deed-special").hide();
	$("#deed-live").hide();

	// --- Populate live status for any owned/group property ---
	if (sq.groupNumber) {
		var liveEl = document.getElementById("deed-live");
		var ownerEl = document.getElementById("deed-live-owner");
		var rentEl = document.getElementById("deed-live-rent");
		var buildEl = document.getElementById("deed-live-buildings");
		var groupEl = document.getElementById("deed-live-group");
		$(liveEl).show();

		// Owner
		if (sq.owner > 0 && player[sq.owner]) {
			ownerEl.innerHTML = "<span style='color:" + player[sq.owner].color + ";'>" + player[sq.owner].name + "</span>";
		} else {
			ownerEl.innerHTML = "<span style='color:#888;font-style:italic;'>" + t('deed_unowned') + "</span>";
		}

		// Current rent + buildings
		rentEl.innerHTML = "";
		buildEl.innerHTML = "";
		if (sq.owner > 0 && !sq.mortgage) {
			if (sq.groupNumber >= 3) {
				var rent = sq.baserent;
				if (sq.hotel > 0) {
					rent = sq.rent5;
					buildEl.textContent = t('deed_hotel');
				} else if (sq.house > 0) {
					rent = sq["rent" + sq.house];
					buildEl.textContent = sq.house + " " + t('deed_houses');
				} else {
					// Check monopoly
					var mono = true;
					for (var k = 0; k < 40; k++) {
						if (square[k].groupNumber === sq.groupNumber && square[k].owner !== sq.owner) { mono = false; break; }
					}
					if (mono) { rent = sq.baserent * 2; buildEl.innerHTML = "<span style='color:#DAA520;font-weight:bold;'>" + t('deed_monopoly') + "</span>"; }
				}
				// Jail penalty: show reduced rent if owner is in jail
				if (player[sq.owner].jail && (sq.house > 0 || sq.hotel > 0)) {
					var mono = true;
					for (var k2 = 0; k2 < 40; k2++) {
						if (square[k2].groupNumber === sq.groupNumber && square[k2].owner !== sq.owner) { mono = false; break; }
					}
					var jailRent = mono ? sq.baserent * 2 : sq.baserent;
					rentEl.innerHTML = t('deed_current_rent') + ": <span style='color:#ff6666;text-decoration:line-through;'>$" + rent + "</span> <span style='color:#ff8888;'>$" + jailRent + "</span>"
						+ "<div style='color:#ff8888;font-size:9px;'>" + t('msg_jail_rent_frozen') + "</div>";
				} else {
					rentEl.textContent = t('deed_current_rent') + ": $" + rent;
				}
			} else if (sq.groupNumber === 1) {
				var cnt = 0;
				for (var k = 0; k < 40; k++) { if (square[k].groupNumber === 1 && square[k].owner === sq.owner) cnt++; }
				var tRent = [0, 25, 50, 100, 200];
				rentEl.textContent = t('deed_current_rent') + ": $" + tRent[cnt];
			}
		} else if (sq.mortgage) {
			rentEl.innerHTML = "<span style='color:#cc0000;font-weight:bold;'>" + t('lbl_mortgaged') + "</span>";
		}

		// Group progress
		if (sq.groupNumber >= 3) {
			var groupTotal = 0, groupOwned = 0;
			for (var k = 0; k < 40; k++) {
				if (square[k].groupNumber === sq.groupNumber) {
					groupTotal++;
					if (sq.owner > 0 && square[k].owner === sq.owner) groupOwned++;
				}
			}
			groupEl.textContent = (sq.owner > 0 ? groupOwned + "/" + groupTotal + " " + t('deed_in_group') : "");
		} else {
			groupEl.textContent = "";
		}
	}

	// --- Show appropriate deed template ---
	if (sq.mortgage) {
		$("#deed-mortgaged").show();
		document.getElementById("deed-mortgaged-name").textContent = sq.name;
		document.getElementById("deed-mortgaged-mortgage").textContent = (sq.price / 2);

	} else {
		if (sq.groupNumber >= 3) {
			$("#deed-normal").show();
			document.getElementById("deed-header").style.backgroundColor = sq.color;
			document.getElementById("deed-name").textContent = sq.name;
			document.getElementById("deed-baserent").textContent = sq.baserent;
			document.getElementById("deed-rent1").textContent = sq.rent1;
			document.getElementById("deed-rent2").textContent = sq.rent2;
			document.getElementById("deed-rent3").textContent = sq.rent3;
			document.getElementById("deed-rent4").textContent = sq.rent4;
			document.getElementById("deed-rent5").textContent = sq.rent5;
			document.getElementById("deed-mortgage").textContent = (sq.price / 2);
			document.getElementById("deed-houseprice").textContent = sq.houseprice;
			document.getElementById("deed-hotelprice").textContent = sq.houseprice;

		} else if (sq.groupNumber == 2) {
			$("#deed-special").show();
			document.getElementById("deed-special-name").textContent = sq.name;
			document.getElementById("deed-special-text").innerHTML = utiltext();
			document.getElementById("deed-special-mortgage").textContent = (sq.price / 2);

		} else if (sq.groupNumber == 1) {
			$("#deed-special").show();
			document.getElementById("deed-special-name").textContent = sq.name;
			document.getElementById("deed-special-text").innerHTML = transtext();
			document.getElementById("deed-special-mortgage").textContent = (sq.price / 2);
		}
	}
}

function hidedeed() {
	$("#deed").hide();
}

// Position deed card near cursor
function positionDeed(e) {
	var deedEl = document.getElementById("deed");
	if (!deedEl || deedEl.style.display === "none") return;
	var top = e.clientY + 15;
	var left = e.clientX + 15;
	// Keep on screen
	if (top + deedEl.offsetHeight > window.innerHeight) top = window.innerHeight - deedEl.offsetHeight - 10;
	if (left + deedEl.offsetWidth > window.innerWidth) left = e.clientX - deedEl.offsetWidth - 15;
	if (top < 0) top = 5;
	deedEl.style.top = top + "px";
	deedEl.style.left = left + "px";
}

// Position the logo/debt-meter overlay in the center of the board
function positionBoardCenterOverlay() {
	var overlay = document.getElementById("board-center-overlay");
	var board = document.getElementById("board");
	if (!overlay || !board) return;

	var rect = board.getBoundingClientRect();
	// Board center = area between the edge cells (roughly 105px inset from each side)
	var inset = 108;
	var centerX = rect.left + inset + (rect.width - inset * 2) / 2;
	var centerY = rect.top + inset + (rect.height - inset * 2) / 2;
	var centerW = rect.width - inset * 2;

	overlay.style.left = (rect.left + inset + window.scrollX) + "px";
	overlay.style.top = (rect.top + inset + window.scrollY) + "px";
	overlay.style.width = centerW + "px";
	overlay.style.height = (rect.height - inset * 2) + "px";
	overlay.style.display = "flex";
	overlay.style.flexDirection = "column";
	overlay.style.justifyContent = "center";
	overlay.style.alignItems = "center";
}

function buy() {
	var p = player[turn];
	var property = square[p.position];
	var cost = property.price;

	if (p.money >= cost) {
		p.pay(cost, 0);

		property.owner = turn;
		updateMoney();
		addAlert(t('msg_bought', {name: p.name, prop: property.name, price: property.pricetext}));

		updateOwned();

		$("#landed").hide();

	} else {
		boardMsg("<p>" + t('pop_too_expensive', {name: p.name, amount: (property.price - p.money), prop: property.name}) + "</p>");
	}
}

function mortgage(index) {
	var sq = square[index];
	var p = player[sq.owner];

	if (sq.house > 0 || sq.hotel > 0 || sq.mortgage) {
		return false;
	}

	// Monopoly rule: cannot mortgage if ANY property in the color group has buildings.
	if (sq.group && sq.group.length > 0) {
		for (var g = 0; g < sq.group.length; g++) {
			var gs = square[sq.group[g]];
			if (gs.house > 0 || gs.hotel > 0) return false;
		}
	}

	var mortgagePrice = Math.round(sq.price * 0.5);
	var unmortgagePrice = Math.round(sq.price * 0.55);

	// DSCR gate: simulate the mortgage and check if the bank would approve.
	// Temporarily flag as mortgaged to calculate post-mortgage DSCR.
	sq.mortgage = true;
	var postDSCR = getDSCR(p);
	if (postDSCR < DSCR_BORROW) {
		sq.mortgage = false; // bank refuses
		addAlert(t('msg_mortgage_refused', {prop: sq.name}));
		if (typeof boardMsg === "function" && p.human) {
			boardMsg(
				"<div style='background:#cc6600;color:white;padding:15px;border-radius:8px;'>"
				+ "<h3 style='margin-top:0;'>" + t('pop_mortgage_refused_title') + "</h3>"
				+ "<p>" + t('msg_mortgage_refused', {prop: sq.name}) + "</p>"
				+ "<p>" + t('pop_mortgage_refused_desc') + "</p>"
				+ "</div>"
			);
		}
		return false;
	}

	// Mortgage approved — keep the flag set, pay out the loan.
	p.money += mortgagePrice;

	document.getElementById("mortgagebutton").value = "Unmortgage for $" + unmortgagePrice;
	document.getElementById("mortgagebutton").title = "Unmortgage " + sq.name + " for $" + unmortgagePrice + ".";

	addAlert(t('msg_mortgage', {name: p.name, prop: sq.name, amount: mortgagePrice}));
	updateOwned();
	updateMoney();

	return true;
}

function unmortgage(index) {
	var sq = square[index];
	var p = player[sq.owner];
	var unmortgagePrice = Math.round(sq.price * 0.55);
	var mortgagePrice = Math.round(sq.price * 0.5);

	if (unmortgagePrice > p.money || !sq.mortgage) {
		return false;
	}

	p.pay(unmortgagePrice, 0);
	sq.mortgage = false;
	document.getElementById("mortgagebutton").value = "Mortgage for $" + mortgagePrice;
	document.getElementById("mortgagebutton").title = "Mortgage " + sq.name + " for $" + mortgagePrice + ".";

	addAlert(t('msg_unmortgage', {name: p.name, prop: sq.name, amount: unmortgagePrice}));
	updateOwned();
	return true;
}


function land(increasedRent) {
	increasedRent = !!increasedRent; // Cast increasedRent to a boolean value. It is used for the ADVANCE TO THE NEAREST RAILROAD/UTILITY Chance cards.

	var p = player[turn];
	var s = square[p.position];

	var die1 = game.getDie(1);
	var die2 = game.getDie(2);

	$("#landed").show();
	setLanded(t('pop_buy_prompt', {prop: s.name}));
	s.landcount++;
	addAlert(t('msg_landed', {name: p.name, prop: s.name}));

	// Allow player to buy the property on which he landed.
	if (s.price !== 0 && s.owner === 0) {

		if (!p.human) {

			if (p.AI.buyProperty(p.position)) {
				buy();
			}
		} else {
			setLanded("<div>" + t('pop_buy_prompt', {prop: "<a href='javascript:void(0);' onmouseover='showdeed(" + p.position + ");' onmouseout='hidedeed();' class='statscellcolor'>" + s.name + "</a>"}) + "<input type='button' onclick='buy();' value='" + t('pop_buy_btn', {price: s.price}) + "' title='Buy " + s.name + " for " + s.pricetext + ".'/></div>");
		}


		game.addPropertyToAuctionQueue(p.position);
	}

	// Collect rent
	if (s.owner !== 0 && s.owner != turn && !s.mortgage) {
		var groupowned = true;
		var rent;

		// Railroads
		if (p.position == 5 || p.position == 15 || p.position == 25 || p.position == 35) {
			if (increasedRent) {
				rent = 25;
			} else {
				rent = 12.5;
			}

			if (s.owner == square[5].owner) {
				rent *= 2;
			}
			if (s.owner == square[15].owner) {
				rent *= 2;
			}
			if (s.owner == square[25].owner) {
				rent *= 2;
			}
			if (s.owner == square[35].owner) {
				rent *= 2;
			}

		} else if (p.position === 12) {
			if (increasedRent || square[28].owner == s.owner) {
				rent = (die1 + die2) * 10;
			} else {
				rent = (die1 + die2) * 4;
			}

		} else if (p.position === 28) {
			if (increasedRent || square[12].owner == s.owner) {
				rent = (die1 + die2) * 10;
			} else {
				rent = (die1 + die2) * 4;
			}

		} else {

			for (var i = 0; i < 40; i++) {
				sq = square[i];
				if (sq.groupNumber == s.groupNumber && sq.owner != s.owner) {
					groupowned = false;
				}
			}

			if (!groupowned) {
				rent = s.baserent;
			} else {
				if (s.house === 0) {
					rent = s.baserent * 2;
				} else {
					rent = s["rent" + s.house];
				}
			}
		}

		// Jail penalty: owner in jail only collects base rent (assets frozen)
		var jailPenalty = false;
		if (player[s.owner].jail && s.groupNumber >= 3) {
			var fullRent = rent;
			// Base rent with monopoly doubling if applicable
			var groupowned = true;
			for (var gi = 0; gi < 40; gi++) {
				if (square[gi].groupNumber == s.groupNumber && square[gi].owner != s.owner) { groupowned = false; break; }
			}
			rent = groupowned ? s.baserent * 2 : s.baserent;
			if (rent < fullRent) jailPenalty = true;
		}

		addAlert(t('msg_rent', {name: p.name, amount: rent, owner: player[s.owner].name}));
		if (jailPenalty) {
			addAlert(t('msg_jail_rent_penalty', {name: player[s.owner].name}));
		}
		p.pay(rent, s.owner);
		player[s.owner].money += rent;

		// AI auto-resolves debt immediately (sell houses, mortgage)
		if (!p.human && p.money < 0 && p.AI && p.AI.payDebt) {
			p.AI.payDebt();
			// If still negative after payDebt, trigger bankruptcy immediately
			if (p.money < 0) {
				updateMoney();
				boardMsg("<p>" + t('pop_bankrupt', {name: p.name}) + "</p>", game.bankruptcy);
				return;
			}
		}

		var landedText = t('pop_rent_collected', {prop: s.name, owner: player[s.owner].name, amount: rent});
		if (jailPenalty) {
			landedText += " <span style='color:#ff8888;font-size:11px;'>(" + t('msg_jail_rent_frozen') + ")</span>";
		}
		setLanded(landedText);
	} else if (s.owner > 0 && s.owner != turn && s.mortgage) {
		setLanded(t('pop_mortgaged_no_rent', {prop: s.name}));
	}

	// Casino (replaces Free Parking)
	if (p.position === 20) {
		casino();
	}

	// City Tax
	if (p.position === 4) {
		citytax();
	}

	// Go to jail. Go directly to Jail. Do not pass GO. Do not collect $200.
	if (p.position === 30) {
		updateMoney();
		updatePosition();

		if (p.human) {
			boardMsg("<div>" + t('sq_go_to_jail_desc') + "</div>", gotojail);
		} else {
			gotojail();
		}

		return;
	}

	// Luxury Tax
	if (p.position === 38) {
		luxurytax();
	}

	updateMoney();
	updatePosition();
	updateOwned();

	if (!p.human) {
		boardMsg(p.AI.alertList, chanceCommunityChest);
		p.AI.alertList = "";
	} else {
		chanceCommunityChest();
	}
}

function roll() {
	var p = player[turn];

	$("#option").hide();
	$("#buy").show();
	$("#manage").hide();

	if (p.human) {
		document.getElementById("nextbutton").focus();
	}
	document.getElementById("nextbutton").value = "End turn";
	document.getElementById("nextbutton").title = "End turn and advance to the next player.";

	game.rollDice();
	var die1 = game.getDie(1);
	var die2 = game.getDie(2);

	// Capture the first roll of this player's turn — used by the cost of
	// living formula (first_roll × lap count) when they pass GO this turn.
	// doublecount is still at its pre-roll value here, so 0 = first roll.
	if (doublecount === 0) {
		p.firstRollThisTurn = die1 + die2;
	}

	doublecount++;

	if (die1 == die2) {
		addAlert(t('msg_rolled_doubles', {name: p.name, total: (die1 + die2)}));
	} else {
		addAlert(t('msg_rolled', {name: p.name, total: (die1 + die2)}));
	}

	if (die1 == die2 && !p.jail) {
		updateDice(die1, die2);

		if (doublecount < 3) {
			document.getElementById("nextbutton").value = "Roll again";
			document.getElementById("nextbutton").title = "You threw doubles. Roll again.";

		// If player rolls doubles three times in a row, send him to jail
		} else if (doublecount === 3) {
			p.jail = true;
			doublecount = 0;
			addAlert(t('msg_triple_doubles', {name: p.name}));
			updateMoney();


			if (p.human) {
				boardMsg(t('pop_jail_3doubles'), gotojail);
			} else {
				gotojail();
			}

			return;
		}
	} else {
		document.getElementById("nextbutton").value = "End turn";
		document.getElementById("nextbutton").title = "End turn and advance to the next player.";
		doublecount = 0;
	}

	updatePosition();
	updateMoney();
	updateOwned();

	if (p.jail === true) {
		p.jailroll++;

		updateDice(die1, die2);
		if (die1 == die2) {
			document.getElementById("jail").style.border = "1px solid black";
			document.getElementById("cell11").style.border = "2px solid " + p.color;
			$("#landed").hide();

			p.jail = false;
			p.jailroll = 0;
			p.position = 10 + die1 + die2;
			doublecount = 0;

			addAlert(t('msg_jail_doubles', {name: p.name}));

			land();
		} else {
			if (p.jailroll === 3) {

				if (p.human) {
					boardMsg("<p>" + t('pop_jail_must_pay') + "</p>", function() {
						payfifty();
						player[turn].position=10 + die1 + die2;
						land();
					});
				} else {
					payfifty();
					p.position = 10 + die1 + die2;
					land();
				}
			} else {
				$("#landed").show();
				setLanded(t('pop_jail_in'));

				if (!p.human) {
					boardMsg(p.AI.alertList, game.next);
					p.AI.alertList = "";
				}
			}
		}


	} else {
		updateDice(die1, die2);

		// Move player
		p.position += die1 + die2;

		// Collect $200 salary as you pass GO (plus mortgage interest)
		if (p.position >= 40) {
			p.position -= 40;
			// Pass land() as callback so it runs AFTER COL/interest messages are dismissed
			var blocked = collectSalaryAndPayInterest(p, land);
			if (blocked) return; // land() will be called from the callback chain
		}

		land();
	}
}

// Record a snapshot of all players' state for the timeline chart.
function logTurnSnapshot() {
	turnCounter++;
	var snap = { turn: turnCounter, round: gameRound, crisis: crisisActive, players: [] };

	// Build a lookup of active players by name
	var activeByName = {};
	for (var i = 1; i <= pcount; i++) {
		var pi = player[i];
		var assets = 0, debt = 0, houses = 0, hotels = 0, props = 0;
		for (var j = 0; j < 40; j++) {
			var sq = square[j];
			if (sq.owner === i) {
				props++;
				assets += sq.price;
				assets += sq.house * sq.houseprice;
				assets += sq.hotel * sq.houseprice;
				houses += sq.house;
				hotels += sq.hotel;
				if (sq.mortgage) debt += Math.round(sq.price * MORTGAGE_VALUE);
			}
		}
		var nw = pi.money + assets - debt;
		activeByName[pi.name] = {
			name: pi.name, money: pi.money, assets: assets, debt: debt,
			nw: nw, houses: houses, hotels: hotels, props: props,
			bankrupt: false
		};
	}

	// Record all original players in order — eliminated ones get zeroed out
	for (var k = 0; k < originalPlayers.length; k++) {
		var name = originalPlayers[k].name;
		if (activeByName[name]) {
			snap.players.push(activeByName[name]);
		} else {
			// Eliminated — record zeros
			snap.players.push({
				name: name, money: 0, assets: 0, debt: 0,
				nw: 0, houses: 0, hotels: 0, props: 0,
				bankrupt: true
			});
		}
	}
	gameLog.push(snap);
}

// Export log and open timeline chart in a new window.
function showTimeline() {
	if (gameLog.length === 0) { alert("No data yet — play some turns first."); return; }
	var chartWindow = window.open("", "TycoonTimeline", "width=1200,height=700");
	if (!chartWindow) { alert(t('pop_timeline_popup')); return; }

	var playerNames = [];
	var playerColors = [];
	for (var i = 0; i < originalPlayers.length; i++) {
		playerNames.push(originalPlayers[i].name);
		// Fix dark colors for visibility on dark background
		var c = originalPlayers[i].color;
		if (c === "green" || c === "#008000") c = "#00cc66";
		if (c === "darkgreen") c = "#00cc66";
		playerColors.push(c);
	}

	var html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
		+ '<title>Tycoon Saigon — Game Timeline</title>'
		+ '<style>'
		+ 'body { font-family: Arial, sans-serif; background: #1a1a2e; color: #eee; margin: 0; padding: 20px; }'
		+ 'h1 { text-align: center; color: #ffcc00; margin-bottom: 5px; }'
		+ '.subtitle { text-align: center; color: #999; margin-bottom: 20px; }'
		+ '.chart-container { background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 20px; }'
		+ '.chart-title { font-size: 16px; font-weight: bold; color: #ffcc00; margin-bottom: 10px; }'
		+ 'canvas { width: 100% !important; }'
		+ '.legend { display: flex; gap: 20px; justify-content: center; margin: 15px 0; flex-wrap: wrap; }'
		+ '.legend-item { display: flex; align-items: center; gap: 6px; }'
		+ '.legend-dot { width: 12px; height: 12px; border-radius: 50%; }'
		+ '.crisis-marker { background: rgba(255,0,0,0.15); }'
		+ '</style>'
		+ '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"><\/script>'
		+ '</head><body>'
		+ '<h1>TYCOON SAIGON</h1>'
		+ '<p class="subtitle">Game Timeline — ' + gameLog.length + ' turns</p>';

	// Legend
	html += '<div class="legend">';
	for (var i = 0; i < playerNames.length; i++) {
		html += '<div class="legend-item"><div class="legend-dot" style="background:' + playerColors[i] + ';"></div>' + playerNames[i] + '</div>';
	}
	html += '</div>';

	html += '<div class="chart-container"><div class="chart-title">Net Worth Over Time</div><canvas id="nwChart"></canvas></div>'
		+ '<div class="chart-container"><div class="chart-title">Cash Over Time</div><canvas id="cashChart"></canvas></div>'
		+ '<div class="chart-container"><div class="chart-title">Debt Over Time</div><canvas id="debtChart"></canvas></div>'
		+ '<div class="chart-container"><div class="chart-title">Houses + Hotels Over Time</div><canvas id="housesChart"></canvas></div>';

	html += '<script>'
		+ 'var gameLog = ' + JSON.stringify(gameLog) + ';'
		+ 'var names = ' + JSON.stringify(playerNames) + ';'
		+ 'var colors = ' + JSON.stringify(playerColors) + ';'
		+ 'var turns = gameLog.map(function(s) { return s.turn; });'
		+ ''
		+ 'function makeDatasets(field) {'
		+ '  var ds = [];'
		+ '  for (var i = 0; i < names.length; i++) {'
		+ '    var wasBankrupt = false;'
		+ '    ds.push({'
		+ '      label: names[i],'
		+ '      data: gameLog.map(function(s) {'
		+ '        if (s.players[i].bankrupt) { wasBankrupt = true; return null; }'
		+ '        return s.players[i][field];'
		+ '      }),'
		+ '      borderColor: colors[i],'
		+ '      backgroundColor: colors[i] + "33",'
		+ '      borderWidth: 2,'
		+ '      pointRadius: 0,'
		+ '      tension: 0.3,'
		+ '      fill: false,'
		+ '      spanGaps: false'
		+ '    });'
		+ '  }'
		+ '  return ds;'
		+ '}'
		+ ''
		+ 'function crisisAnnotations() {'
		+ '  var regions = []; var inCrisis = false; var start = 0;'
		+ '  for (var i = 0; i < gameLog.length; i++) {'
		+ '    if (gameLog[i].crisis && !inCrisis) { inCrisis = true; start = gameLog[i].turn; }'
		+ '    if (!gameLog[i].crisis && inCrisis) { inCrisis = false; regions.push({start: start, end: gameLog[i].turn}); }'
		+ '  }'
		+ '  if (inCrisis) regions.push({start: start, end: gameLog[gameLog.length-1].turn});'
		+ '  return regions;'
		+ '}'
		+ ''
		+ 'var chartOpts = {'
		+ '  responsive: true,'
		+ '  plugins: { legend: { display: true, labels: { color: "#ccc", usePointStyle: true, pointStyle: "line" } } },'
		+ '  scales: {'
		+ '    x: { title: { display: true, text: "Turn", color: "#999" }, ticks: { color: "#999" }, grid: { color: "#333" } },'
		+ '    y: { title: { display: true, text: "$", color: "#999" }, ticks: { color: "#999" }, grid: { color: "#333" } }'
		+ '  }'
		+ '};'
		+ ''
		+ 'function makeChart(id, field, yLabel) {'
		+ '  var ctx = document.getElementById(id).getContext("2d");'
		+ '  new Chart(ctx, { type: "line", data: { labels: turns, datasets: makeDatasets(field) }, options: chartOpts });'
		+ '}'
		+ ''
		+ 'makeChart("nwChart", "nw", "Net Worth ($)");'
		+ 'makeChart("cashChart", "money", "Cash ($)");'
		+ 'makeChart("debtChart", "debt", "Debt ($)");'
		+ ''
		+ 'var housesDs = [];'
		+ 'for (var i = 0; i < names.length; i++) {'
		+ '  housesDs.push({'
		+ '    label: names[i],'
		+ '    data: gameLog.map(function(s) { return s.players[i].bankrupt ? null : s.players[i].houses + s.players[i].hotels * 5; }),'
		+ '    borderColor: colors[i],'
		+ '    backgroundColor: colors[i] + "33",'
		+ '    borderWidth: 2,'
		+ '    pointRadius: 0,'
		+ '    tension: 0.3,'
		+ '    fill: false,'
		+ '    spanGaps: false'
		+ '  });'
		+ '}'
		+ 'var hCtx = document.getElementById("housesChart").getContext("2d");'
		+ 'new Chart(hCtx, { type: "line", data: { labels: turns, datasets: housesDs }, options: chartOpts });'
		+ '<\/script></body></html>';

	chartWindow.document.open();
	chartWindow.document.write(html);
	chartWindow.document.close();
}

function play() {
	if (game.auction()) {
		return;
	}

	// Log end-of-turn snapshot for timeline
	logTurnSnapshot();

	turn++;
	if (turn > pcount) {
		turn -= pcount;
		// New round — check for bubble and end any active crisis
		gameRound++;
		endCrisis();
		checkBubble();
	}

	var p = player[turn];
	game.resetDice();

	document.getElementById("pname").innerHTML = p.name;

	addAlert(t('msg_turn', {name: p.name}));

	// Check for bankruptcy.
	p.pay(0, p.creditor);

	$("#landed, #option, #manage").hide();
	$("#board, #moneybar, #viewstats, #buy").show();
	showCenterPanel('center-game');

	doublecount = 0;
	humanTradesThisTurn = 0;
	lastRejectedTrade = null;
	if (p.human) {
		document.getElementById("nextbutton").focus();
	}
	document.getElementById("nextbutton").value = "Roll Dice";
	document.getElementById("nextbutton").title = "Roll the dice and move your token accordingly.";

	$("#die0").hide();
	$("#die1").hide();

	if (p.jail) {
		if (p.jailroll === 0)
			addAlert(t('msg_jail_turn1', {name: p.name}));
		else if (p.jailroll === 1)
			addAlert(t('msg_jail_turn2', {name: p.name}));
		else if (p.jailroll === 2)
			addAlert(t('msg_jail_turn3', {name: p.name}));

		if (!p.human) {
			// AI handles jail automatically
			if (p.AI.postBail()) {
				if (p.communityChestJailCard || p.chanceJailCard) {
					useJailCard();
				} else {
					payfifty();
				}
			}
			// AI will auto-roll via game.next() below
		} else {
			// Human: show jail UI with pay/card options
			var jailHtml = t('pop_jail_in') + "<input type='button' title='" + t('pop_jail_pay') + "' value='" + t('pop_jail_pay') + "' onclick='payfifty();' />";
			if (p.communityChestJailCard || p.chanceJailCard) {
				jailHtml += "<input type='button' id='gojfbutton' title='" + t('pop_jail_card') + "' onclick='useJailCard();' value='" + t('pop_jail_card') + "' />";
			}
			if (p.jailroll === 2) {
				jailHtml += "<div style='font-size:11px;color:#ff8888;margin-top:4px;'>NOTE: If you do not throw doubles, you must pay the $50 fine.</div>";
			}
			setLanded(jailHtml);
			document.getElementById("nextbutton").title = "Roll the dice. If you throw doubles, you will get out of jail.";
		}
	}

	updateMoney();
	updatePosition();
	updateOwned();

	$(".money-bar-arrow").hide();
	$("#p" + turn + "arrow").show();

	if (!p.human) {
		if (!p.AI.beforeTurn()) {
			game.next();
		}
	}
}

function setup() {
	pcount = parseInt(document.getElementById("playernumber").value, 10);

	// Collect form configs for first-roll ceremony
	var configs = [];
	var AI_NAMES = {"1":"AI Test","2":"AI Shark","3":"AI Careful","4":"AI Monopolist","5":"AI Claude"};
	for (var i = 1; i <= pcount; i++) {
		var aiType = document.getElementById("player" + i + "ai").value;
		configs.push({
			color: document.getElementById("player" + i + "color").value.toLowerCase(),
			aiType: aiType,
			humanName: document.getElementById("player" + i + "name").value,
			isHuman: aiType === "0",
			displayName: aiType === "0" ? document.getElementById("player" + i + "name").value : AI_NAMES[aiType] || "AI",
			d1: 0, d2: 0, roll: 0, rolled: false,
			tiebreak: Math.random()
		});
	}

	// Grab Claude API key if any Claude player is selected
	var apiKeyInput = document.getElementById("claude-api-key");
	if (apiKeyInput && apiKeyInput.value.trim()) {
		CLAUDE_API_KEY = apiKeyInput.value.trim();
	}

	$("#board, #moneybar").show();
	$("#setup").hide();

	positionBoardCenterOverlay();

	if (pcount === 2) {
		document.getElementById("stats").style.width = "454px";
	} else if (pcount === 3) {
		document.getElementById("stats").style.width = "686px";
	}

	document.getElementById("stats").style.top = "0px";
	document.getElementById("stats").style.left = "0px";

	// Start interactive first-roll ceremony
	_firstRoll = { configs: configs, index: -1 };
	_firstRollAdvance();
}

var _firstRoll = null;

function _firstRollRender() {
	var configs = _firstRoll.configs;
	var idx = _firstRoll.index;

	var html = "<div style='text-align:center;'>"
		+ "<h3 style='margin:0 0 10px;'>" + t('first_roll_title') + "</h3>"
		+ "<table style='margin:0 auto;border-collapse:collapse;'>";
	for (var i = 0; i < configs.length; i++) {
		var c = configs[i];
		var highlight = (i === idx && !c.rolled) ? "background:rgba(255,255,255,0.08);" : "";
		html += "<tr style='border-bottom:1px solid #555;" + highlight + "'>"
			+ "<td style='padding:6px 8px;font-weight:bold;color:" + c.color + ";'>" + c.displayName + "</td>";
		if (c.rolled) {
			html += "<td style='padding:6px 4px;'><img src='images/Die_" + c.d1 + ".png' height='28' width='28'/>"
				+ " <img src='images/Die_" + c.d2 + ".png' height='28' width='28'/></td>"
				+ "<td style='padding:6px 8px;font-weight:bold;font-size:16px;'>" + c.roll + "</td>";
		} else if (i === idx && c.isHuman) {
			html += "<td colspan='2' style='padding:6px 8px;'>"
				+ "<input type='button' value='" + t('btn_roll') + "' onclick='_firstRollDo()' "
				+ "style='font-size:14px;padding:6px 20px;cursor:pointer;'/></td>";
		} else if (i === idx) {
			html += "<td colspan='2' style='padding:6px 8px;color:#aaa;'>...</td>";
		} else {
			html += "<td colspan='2' style='padding:6px 8px;color:#555;'>—</td>";
		}
		html += "</tr>";
	}
	html += "</table></div>";

	document.getElementById("board-msg-text").innerHTML = html;
	document.getElementById("board-msg-btn").style.display = "none";
	showCenterPanel('center-msg');
}

function _firstRollAdvance() {
	_firstRoll.index++;
	var idx = _firstRoll.index;
	var configs = _firstRoll.configs;

	if (idx >= configs.length) {
		_firstRollFinish();
		return;
	}

	_firstRollRender();

	if (!configs[idx].isHuman) {
		setTimeout(function() {
			var c = configs[idx];
			c.d1 = Math.floor(Math.random() * 6) + 1;
			c.d2 = Math.floor(Math.random() * 6) + 1;
			c.roll = c.d1 + c.d2;
			c.rolled = true;
			_firstRollRender();
			setTimeout(_firstRollAdvance, 700);
		}, 400);
	}
}

function _firstRollDo() {
	var c = _firstRoll.configs[_firstRoll.index];
	c.d1 = Math.floor(Math.random() * 6) + 1;
	c.d2 = Math.floor(Math.random() * 6) + 1;
	c.roll = c.d1 + c.d2;
	c.rolled = true;
	_firstRollRender();
	setTimeout(_firstRollAdvance, 700);
}

function _firstRollFinish() {
	var configs = _firstRoll.configs;

	// Sort by roll descending; random tiebreak
	configs.sort(function(a, b) {
		if (b.roll !== a.roll) return b.roll - a.roll;
		return b.tiebreak - a.tiebreak;
	});

	// Assign to player[1..pcount] in sorted order
	for (var i = 0; i < configs.length; i++) {
		var p = player[i + 1];
		var cfg = configs[i];
		p.color = cfg.color;
		if (cfg.aiType === "0") { p.name = cfg.humanName; p.human = true; }
		else if (cfg.aiType === "1") { p.human = false; p.AI = new AITest(p); }
		else if (cfg.aiType === "2") { p.human = false; p.AI = new AIShark(p); }
		else if (cfg.aiType === "3") { p.human = false; p.AI = new AICareful(p); }
		else if (cfg.aiType === "4") { p.human = false; p.AI = new AIMonopolist(p); }
		else if (cfg.aiType === "5") { p.human = false; p.AI = new AIClaude(p); }
	}

	// Save original player roster
	originalPlayers = [];
	gameLog = [];
	turnCounter = 0;
	eliminatedPlayers = {};
	for (var i = 1; i <= pcount; i++) {
		originalPlayers.push({ name: player[i].name, color: player[i].color });
	}

	// Track game start
	var aiTypes = [], humanCount = 0;
	for (var i = 1; i <= pcount; i++) {
		if (player[i].human) humanCount++;
		else if (player[i].AI) aiTypes.push(player[i].name.replace(/ \d+$/, ""));
	}
	trackEvent("game_started", { players: pcount, humans: humanCount, ais: aiTypes.join(",") });

	// Show final order, then start the game
	var html = "<div style='text-align:center;'>"
		+ "<h3 style='margin:0 0 10px;'>" + t('first_roll_title') + "</h3>"
		+ "<table style='margin:0 auto;border-collapse:collapse;'>";
	for (var i = 0; i < configs.length; i++) {
		var cfg = configs[i];
		var name = player[i + 1].name;
		var first = i === 0 ? " &#9733;" : "";
		html += "<tr style='border-bottom:1px solid #555;'>"
			+ "<td style='padding:6px 8px;font-weight:bold;color:" + cfg.color + ";'>" + (i + 1) + ".</td>"
			+ "<td style='padding:6px 8px;'>" + name + "</td>"
			+ "<td style='padding:6px 4px;'><img src='images/Die_" + cfg.d1 + ".png' height='28' width='28'/>"
			+ " <img src='images/Die_" + cfg.d2 + ".png' height='28' width='28'/></td>"
			+ "<td style='padding:6px 8px;font-weight:bold;font-size:16px;'>" + cfg.roll + first + "</td>"
			+ "</tr>";
	}
	html += "</table></div>";

	_firstRoll = null;
	boardMsg(html, play);
}

// function togglecheck(elementid) {
	// element = document.getElementById(elementid);

	// if (window.event.srcElement.id == elementid)
		// return;

	// if (element.checked) {
		// element.checked = false;
	// } else {
		// element.checked = true;
	// }
// }

function getCheckedProperty() {
	for (var i = 0; i < 42; i++) {
		if (document.getElementById("propertycheckbox" + i) && document.getElementById("propertycheckbox" + i).checked) {
			return i;
		}
	}
	return -1; // No property is checked.
}

// function propertycell_onclick(element, num) {
	// togglecheck("propertycheckbox" + num);
	// if (document.getElementById("propertycheckbox" + num).checked) {

		// // Uncheck all other boxes.
		// for (var i = 0; i < 40; i++) {
			// if (i !== num && document.getElementById("propertycheckbox" + i)) {
				// document.getElementById("propertycheckbox" + i).checked = false;
			// }
		// }
	// }

	// updateOption();
// }

function playernumber_onchange() {
	pcount = parseInt(document.getElementById("playernumber").value, 10);

	$(".player-input").hide();

	for (var i = 1; i <= pcount; i++) {
		$("#player" + i + "input").show();
	}
}

function menuitem_onmouseover(element) {
	element.className = "menuitem menuitem_hover";
	return;
}

function menuitem_onmouseout(element) {
	element.className = "menuitem";
	return;
}

window.onload = function() {
	game = new Game();

	for (var i = 0; i <= 8; i++) {
		player[i] = new Player("", "");
		player[i].index = i;
	}

	var groupPropertyArray = [];
	var groupNumber;

	for (var i = 0; i < 40; i++) {
		groupNumber = square[i].groupNumber;

		if (groupNumber > 0) {
			if (!groupPropertyArray[groupNumber]) {
				groupPropertyArray[groupNumber] = [];
			}

			groupPropertyArray[groupNumber].push(i);
		}
	}

	for (var i = 0; i < 40; i++) {
		groupNumber = square[i].groupNumber;

		if (groupNumber > 0) {
			square[i].group = groupPropertyArray[groupNumber];
		}

		square[i].index = i;
	}

	AITest.count = 0;

	player[1].human = true;
	player[0].name = "the bank";

	communityChestCards.index = 0;
	chanceCards.index = 0;

	communityChestCards.deck = [];
	chanceCards.deck = [];

	for (var i = 0; i < 16; i++) {
		chanceCards.deck[i] = i;
		communityChestCards.deck[i] = i;
	}

	// Shuffle Chance and Community Chest decks.
	chanceCards.deck.sort(function() {return Math.random() - 0.5;});
	communityChestCards.deck.sort(function() {return Math.random() - 0.5;});

	$("#playernumber").on("change", playernumber_onchange);
	playernumber_onchange();

	$("#nextbutton").click(game.next);
	$("#noscript").hide();
	// Show greeting screen first; setup shown when player clicks Play
	$("#greeting").show();

	var enlargeWrap = document.body.appendChild(document.createElement("div"));

	enlargeWrap.id = "enlarge-wrap";

	var HTML = "";
	for (var i = 0; i < 40; i++) {
		HTML += "<div id='enlarge" + i + "' class='enlarge' data-sq='" + i + "'>";
		HTML += "<div id='enlarge" + i + "color' class='enlarge-color'></div>";
		HTML += "<div id='enlarge" + i + "name' class='enlarge-name'></div>";
		HTML += "<div id='enlarge" + i + "price' class='enlarge-price'></div>";
		HTML += "<div id='enlarge" + i + "details' class='enlarge-details'></div>";
		HTML += "<div id='enlarge" + i + "token' class='enlarge-token'></div></div>";
	}

	enlargeWrap.innerHTML = HTML;

	var currentCell;
	var currentCellAnchor;
	var currentCellPositionHolder;
	var currentCellName;
	var currentCellOwner;

	for (var i = 0; i < 40; i++) {
		s = square[i];

		currentCell = document.getElementById("cell" + i);

		currentCellAnchor = currentCell.appendChild(document.createElement("div"));
		currentCellAnchor.id = "cell" + i + "anchor";
		currentCellAnchor.className = "cell-anchor";

		currentCellPositionHolder = currentCellAnchor.appendChild(document.createElement("div"));
		currentCellPositionHolder.id = "cell" + i + "positionholder";
		currentCellPositionHolder.className = "cell-position-holder";
		currentCellPositionHolder.enlargeId = "enlarge" + i;

		currentCellName = currentCellAnchor.appendChild(document.createElement("div"));
		currentCellName.id = "cell" + i + "name";
		currentCellName.className = "cell-name";
		currentCellName.textContent = s.name;

		if (square[i].groupNumber) {
			currentCellOwner = currentCellAnchor.appendChild(document.createElement("div"));
			currentCellOwner.id = "cell" + i + "owner";
			currentCellOwner.className = "cell-owner";
		}

		// Apply group color band to property cells
		if (square[i].groupNumber >= 3) {
			var c = s.color;
			var cls = currentCell.className;
			if (cls.indexOf("board-top") !== -1) {
				currentCell.style.background = "linear-gradient(to bottom, " + c + " 28%, #FFFEF5 28%)";
			} else if (cls.indexOf("board-bottom") !== -1) {
				currentCell.style.background = "linear-gradient(to top, " + c + " 28%, #FFFEF5 28%)";
			} else if (cls.indexOf("board-left") !== -1) {
				currentCell.style.background = "linear-gradient(to right, " + c + " 28%, #FFFEF5 28%)";
			} else if (cls.indexOf("board-right") !== -1) {
				currentCell.style.background = "linear-gradient(to left, " + c + " 28%, #FFFEF5 28%)";
			}
		}

		// Enhanced visuals: buildings, rent, mortgage overlay
		if (square[i].groupNumber >= 3) {
			var bldg = currentCellAnchor.appendChild(document.createElement("div"));
			bldg.id = "cell" + i + "buildings";
			bldg.className = "cell-buildings";

			var rentEl = currentCellAnchor.appendChild(document.createElement("div"));
			rentEl.id = "cell" + i + "rent";
			rentEl.className = "cell-rent";

			var mortOvl = currentCellAnchor.appendChild(document.createElement("div"));
			mortOvl.id = "cell" + i + "mortgage";
			mortOvl.className = "cell-mortgage-overlay";
			var mortLbl = mortOvl.appendChild(document.createElement("div"));
			mortLbl.className = "cell-mortgage-label";
			mortLbl.textContent = "MTG";
		}

		document.getElementById("enlarge" + i + "color").style.backgroundColor = s.color;
		document.getElementById("enlarge" + i + "name").textContent = s.name;
		document.getElementById("enlarge" + i + "price").textContent = s.pricetext;
	}


	// Add images to enlarges.
	document.getElementById("enlarge0token").innerHTML += '<img src="images/arrow_icon.png" height="40" width="136" alt="" />';
	document.getElementById("enlarge20price").innerHTML += "<img src='images/free_parking_icon.png' height='80' width='72' alt='' style='position: relative; top: -20px;' />";
	document.getElementById("enlarge38token").innerHTML += '<img src="images/tax_icon.png" height="60" width="70" alt="" style="position: relative; top: -20px;" />';

	corrections();

	// Jail corrections
	$("<div>", {id: "jailpositionholder" }).appendTo("#jail");
	$("<span>").text("Jail").appendTo("#jail");

	document.getElementById("jail").enlargeId = "enlarge40";

	document.getElementById("enlarge-wrap").innerHTML += "<div id='enlarge40' class='enlarge'><div id='enlarge40color' class='enlarge-color'></div><br /><div id='enlarge40name' class='enlarge-name'>Jail</div><br /><div id='enlarge40price' class='enlarge-price'><img src='images/jake_icon.png' height='80' width='80' alt='' style='position: relative; top: -20px;' /></div><br /><div id='enlarge40token' class='enlarge-token'></div></div>";

	document.getElementById("enlarge40name").innerHTML = "Jail";

	// Create event handlers for hovering — show unified deed card instead of enlarge popup.

	var drag, dragX, dragY, dragObj, dragTop, dragLeft;

	$(".cell-position-holder, #jail").on("mouseover", function(){
		var eId = this.enlargeId;
		if (eId) {
			var idx = parseInt(eId.replace("enlarge", ""));
			if (!isNaN(idx) && idx < 40 && square[idx] && square[idx].groupNumber) {
				showdeed(idx);
			} else {
				// Non-property squares: show old enlarge popup
				$("#" + eId).show();
			}
		}
	}).on("mouseout", function() {
		hidedeed();
		var eId = this.enlargeId;
		if (eId) $("#" + eId).hide();

	}).on("mousemove", function(e) {
		// Position deed card
		positionDeed(e);
		// Position enlarge popup (for non-property squares)
		var element = document.getElementById(this.enlargeId);
		if (element) {
			if (e.clientY + 20 > window.innerHeight - 204) {
				element.style.top = (window.innerHeight - 204) + "px";
			} else {
				element.style.top = (e.clientY + 20) + "px";
			}
			element.style.left = (e.clientX + 10) + "px";
		}
	});


	$("body").on("mousemove", function(e) {
		var object;

		if (e.target) {
			object = e.target;
		} else if (window.event && window.event.srcElement) {
			object = window.event.srcElement;
		}


		if (object.classList.contains("propertycellcolor") || object.classList.contains("statscellcolor")) {
			if (e.clientY + 20 > window.innerHeight - 279) {
				document.getElementById("deed").style.top = (window.innerHeight - 279) + "px";
			} else {
				document.getElementById("deed").style.top = (e.clientY + 20) + "px";
			}
			document.getElementById("deed").style.left = (e.clientX + 10) + "px";


		} else if (drag) {
			if (e) {
				dragObj.style.left = (dragLeft + e.clientX - dragX) + "px";
				dragObj.style.top = (dragTop + e.clientY - dragY) + "px";

			} else if (window.event) {
				dragObj.style.left = (dragLeft + window.event.clientX - dragX) + "px";
				dragObj.style.top = (dragTop + window.event.clientY - dragY) + "px";
			}
		}
	});


	$("body").on("mouseup", function() {

		drag = false;
	});
	document.getElementById("statsdrag").onmousedown = function(e) {
		dragObj = document.getElementById("stats");
		dragObj.style.position = "relative";

		dragTop = parseInt(dragObj.style.top, 10) || 0;
		dragLeft = parseInt(dragObj.style.left, 10) || 0;

		if (window.event) {
			dragX = window.event.clientX;
			dragY = window.event.clientY;
		} else if (e) {
			dragX = e.clientX;
			dragY = e.clientY;
		}

		drag = true;
	};

	document.getElementById("popupdrag").onmousedown = function(e) {
		dragObj = document.getElementById("popup");
		dragObj.style.position = "relative";

		dragTop = parseInt(dragObj.style.top, 10) || 0;
		dragLeft = parseInt(dragObj.style.left, 10) || 0;

		if (window.event) {
			dragX = window.event.clientX;
			dragY = window.event.clientY;
		} else if (e) {
			dragX = e.clientX;
			dragY = e.clientY;
		}

		drag = true;
	};

	$("#mortgagebutton").click(function() {
		var checkedProperty = getCheckedProperty();
		var s = square[checkedProperty];

		if (s.mortgage) {
			if (player[s.owner].money < Math.round(s.price * 0.55)) {
				boardMsg("<p>" + t('pop_unmortgage_cost', {amount: (Math.round(s.price * 0.55) - player[s.owner].money), prop: s.name}) + "</p>");

			} else {
				popup("<p>" + t('pop_unmortgage_confirm', {name: player[s.owner].name, prop: s.name, amount: Math.round(s.price * 0.55)}) + "</p>", function() {
					unmortgage(checkedProperty);
				}, t('btn_yes') + "/" + t('btn_no'));
			}
		} else {
			popup("<p>" + t('pop_mortgage_confirm', {name: player[s.owner].name, prop: s.name, amount: Math.round(s.price * 0.5)}) + "</p>", function() {
				mortgage(checkedProperty);
			}, t('btn_yes') + "/" + t('btn_no'));
		}

	});

	$("#buyhousebutton").on("click", function() {
		var checkedProperty = getCheckedProperty();
		var s = square[checkedProperty];
		var p = player[s.owner];
		var houseSum = 0;
		var hotelSum = 0;

		if (p.money < s.houseprice) {
			if (s.house === 4) {
				boardMsg("<p>" + t('pop_hotel_cost', {amount: (s.houseprice - player[s.owner].money), prop: s.name}) + "</p>");
				return;
			} else {
				boardMsg("<p>" + t('pop_house_cost', {amount: (s.houseprice - player[s.owner].money), prop: s.name}) + "</p>");
				return;
			}
		}

		for (var i = 0; i < 40; i++) {
			if (square[i].hotel === 1) {
				hotelSum++;
			} else {
				houseSum += square[i].house;
			}
		}

		if (s.house < 4 && houseSum >= 32) {
			boardMsg("<p>" + t('pop_no_houses') + "</p>");
			return;
		} else if (s.house === 4 && hotelSum >= 12) {
			boardMsg("<p>" + t('pop_no_hotels') + "</p>");
			return;
		}

		buyHouse(checkedProperty);

	});

	$("#sellhousebutton").click(function() { sellHouse(getCheckedProperty()); });

	$("#viewstats").on("click", showStats);
	$("#statsclose, #statsbackground").on("click", function() {
		$("#statswrap").hide();
		$("#statsbackground").fadeOut(400);
	});

	$("#buy-menu-item").click(function() {
		$("#buy").show();
		$("#manage").hide();

		// Scroll alerts to bottom.
		$("#alert").scrollTop($("#alert").prop("scrollHeight"));
	});


	$("#manage-menu-item").click(function() {
		$("#manage").show();
		$("#buy").hide();
	});


	$("#trade-menu-item").click(game.trade);


};
