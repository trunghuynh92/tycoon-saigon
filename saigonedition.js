// ============================================================
// Tycoon Saigon — Saigon Edition
// Themed around HCMC neighborhoods and landmarks.
// Follows the pattern of classicedition.js / newyorkcityedition.js.
// ============================================================

function Square(name, pricetext, color, price, groupNumber, baserent, rent1, rent2, rent3, rent4, rent5) {
	this.name = name;
	this.pricetext = pricetext;
	this.color = color;
	this.owner = 0;
	this.mortgage = false;
	this.house = 0;
	this.hotel = 0;
	this.groupNumber = groupNumber || 0;
	this.price = (price || 0);
	this.baserent = (baserent || 0);
	this.rent1 = (rent1 || 0);
	this.rent2 = (rent2 || 0);
	this.rent3 = (rent3 || 0);
	this.rent4 = (rent4 || 0);
	this.rent5 = (rent5 || 0);
	this.landcount = 0;

	if (groupNumber === 3 || groupNumber === 4) {
		this.houseprice = 50;
	} else if (groupNumber === 5 || groupNumber === 6) {
		this.houseprice = 100;
	} else if (groupNumber === 7 || groupNumber === 8) {
		this.houseprice = 150;
	} else if (groupNumber === 9 || groupNumber === 10) {
		this.houseprice = 200;
	} else {
		this.houseprice = 0;
	}
}

function Card(text, action) {
	this.text = text;
	this.action = action;
}

// Visual tweaks after the board renders. Keep the existing
// transit/utility icons — they still read as transport & power.
function corrections() {
	// Add transit icons to the four transit hubs.
	document.getElementById("enlarge5token").innerHTML += '<img src="images/train_icon.png" height="60" width="65" alt="" style="position: relative; bottom: 20px;" />';
	document.getElementById("enlarge15token").innerHTML += '<img src="images/train_icon.png" height="60" width="65" alt="" style="position: relative; top: -20px;" />';
	document.getElementById("enlarge25token").innerHTML += '<img src="images/train_icon.png" height="60" width="65" alt="" style="position: relative; top: -20px;" />';
	document.getElementById("enlarge35token").innerHTML += '<img src="images/train_icon.png" height="60" width="65" alt="" style="position: relative; top: -20px;" />';
	// Utility icons.
	document.getElementById("enlarge12token").innerHTML += '<img src="images/electric_icon.png" height="60" width="48" alt="" style="position: relative; top: -20px;" />';
	document.getElementById("enlarge28token").innerHTML += '<img src="images/water_icon.png" height="60" width="78" alt="" style="position: relative; top: -20px;" />';
}

function utiltext() {
	return t('util_desc');
}

function transtext() {
	return t('trans_desc');
}

function luxurytax() {
	var p = player[turn];
	addAlert(t('tax_luxury_alert', {name: p.name}));
	p.pay(100, 0);
	if (!p.human && p.money < 0 && p.AI && p.AI.payDebt) {
		p.AI.payDebt();
		if (p.money < 0) { updateMoney(); boardMsg("<p>" + t('pop_bankrupt', {name: p.name}) + "</p>", game.bankruptcy); return; }
	}
	$("#landed").show().text(t('tax_luxury_landed'));
}

function citytax() {
	var p = player[turn];
	addAlert(t('tax_income_alert', {name: p.name}));
	p.pay(200, 0);
	if (!p.human && p.money < 0 && p.AI && p.AI.payDebt) {
		p.AI.payDebt();
		if (p.money < 0) { updateMoney(); boardMsg("<p>" + t('pop_bankrupt', {name: p.name}) + "</p>", game.bankruptcy); return; }
	}
	$("#landed").show().text(t('tax_income_landed'));
}

var square = [];

// Non-property squares — use t() for translatable names
square[0] = new Square(t('sq_go'), t('sq_go_desc'), "#FFFFFF");
square[2] = new Square(t('sq_community_chest'), t('sq_community_chest_desc'), "#FFFFFF");
square[4] = new Square(t('sq_income_tax'), t('sq_income_tax_desc'), "#FFFFFF");
square[7] = new Square(t('sq_chance'), t('sq_chance_desc'), "#FFFFFF");
square[10] = new Square(t('sq_just_visiting'), "", "#FFFFFF");
square[17] = new Square(t('sq_community_chest'), t('sq_community_chest_desc'), "#FFFFFF");
square[20] = new Square(t('sq_casino'), t('sq_casino_desc'), "#FFFFFF");
square[22] = new Square(t('sq_chance'), t('sq_chance_desc'), "#FFFFFF");
square[30] = new Square(t('sq_go_to_jail'), t('sq_go_to_jail_desc'), "#FFFFFF");
square[33] = new Square(t('sq_community_chest'), t('sq_community_chest_desc'), "#FFFFFF");
square[36] = new Square(t('sq_chance'), t('sq_chance_desc'), "#FFFFFF");
square[38] = new Square(t('sq_luxury_tax'), t('sq_luxury_tax_desc'), "#FFFFFF");

// Brown group (3) — $60
square[1] = new Square(t('prop_binh_thanh'), "$60", "#8B4513", 60, 3, 2, 10, 30, 90, 160, 250);
square[3] = new Square(t('prop_go_vap'), "$60", "#8B4513", 60, 3, 4, 20, 60, 180, 320, 450);

// Light Blue group (4) — $100–120
square[6] = new Square(t('prop_tan_binh'), "$100", "#87CEEB", 100, 4, 6, 30, 90, 270, 400, 550);
square[8] = new Square(t('prop_tan_phu'), "$100", "#87CEEB", 100, 4, 6, 30, 90, 270, 400, 550);
square[9] = new Square(t('prop_binh_tan'), "$120", "#87CEEB", 120, 4, 8, 40, 100, 300, 450, 600);

// Pink group (5) — $140–160
square[11] = new Square(t('prop_phu_nhuan'), "$140", "#FF0080", 140, 5, 10, 50, 150, 450, 625, 750);
square[13] = new Square(t('prop_quan3'), "$140", "#FF0080", 140, 5, 10, 50, 150, 450, 625, 750);
square[14] = new Square(t('prop_quan10'), "$160", "#FF0080", 160, 5, 12, 60, 180, 500, 700, 900);

// Orange group (6) — $180–200
square[16] = new Square(t('prop_quan5'), "$180", "#FFA500", 180, 6, 14, 70, 200, 550, 750, 950);
square[18] = new Square(t('prop_quan11'), "$180", "#FFA500", 180, 6, 14, 70, 200, 550, 750, 950);
square[19] = new Square(t('prop_quan6'), "$200", "#FFA500", 200, 6, 16, 80, 220, 600, 800, 1000);

// Red group (7) — $220–240
square[21] = new Square(t('prop_quan4'), "$220", "#FF0000", 220, 7, 18, 90, 250, 700, 875, 1050);
square[23] = new Square(t('prop_quan8'), "$220", "#FF0000", 220, 7, 18, 90, 250, 700, 875, 1050);
square[24] = new Square(t('prop_quan7'), "$240", "#FF0000", 240, 7, 20, 100, 300, 750, 925, 1100);

// Yellow group (8) — $260–280
square[26] = new Square(t('prop_thu_duc'), "$260", "#FFFF00", 260, 8, 22, 110, 330, 800, 975, 1150);
square[27] = new Square(t('prop_quan9'), "$260", "#FFFF00", 260, 8, 22, 110, 330, 800, 975, 1150);
square[29] = new Square(t('prop_quan2'), "$280", "#FFFF00", 280, 8, 24, 120, 360, 850, 1025, 1200);

// Green group (9) — $300–320 — HCMC prestige neighborhoods
square[31] = new Square(t('prop_da_kao'), "$300", "#008000", 300, 9, 26, 130, 390, 900, 1100, 1275);
square[32] = new Square(t('prop_tan_dinh'), "$300", "#008000", 300, 9, 26, 130, 390, 900, 1100, 1275);
square[34] = new Square(t('prop_thu_thiem'), "$320", "#008000", 320, 9, 28, 150, 450, 1000, 1200, 1400);

// Dark Blue group (10) — $350–400 — HCMC prestige
square[37] = new Square(t('prop_thao_dien'), "$350", "#0000FF", 350, 10, 35, 175, 500, 1100, 1300, 1500);
square[39] = new Square(t('prop_quan1'), "$400", "#0000FF", 400, 10, 50, 200, 600, 1400, 1700, 2000);

// Transit hubs (group 1) — replaces the four railroads
square[5]  = new Square(t('prop_airport'), "$200", "#FFFFFF", 200, 1);
square[15] = new Square(t('prop_railway'), "$200", "#FFFFFF", 200, 1);
square[25] = new Square(t('prop_bus_east'), "$200", "#FFFFFF", 200, 1);
square[35] = new Square(t('prop_dragon_wharf'), "$200", "#FFFFFF", 200, 1);

// Utilities (group 2)
square[12] = new Square(t('prop_evn'), "$150", "#FFFFFF", 150, 2);
square[28] = new Square(t('prop_sawaco'), "$150", "#FFFFFF", 150, 2);

// ------------------------------------------------------------
// Cộng Đồng (Community Chest) — Vietnamese flavor, same effects
// ------------------------------------------------------------
var communityChestCards = [];

communityChestCards[0]  = new Card(t('cc0'), function(p) { p.communityChestJailCard = true; updateOwned(); });
communityChestCards[1]  = new Card(t('cc1'), function() { addamount(10, t('sq_community_chest')); });
communityChestCards[2]  = new Card(t('cc2'), function() { addamount(50, t('sq_community_chest')); });
communityChestCards[3]  = new Card(t('cc3'), function() { addamount(100, t('sq_community_chest')); });
communityChestCards[4]  = new Card(t('cc4'), function() { addamount(20, t('sq_community_chest')); });
communityChestCards[5]  = new Card(t('cc5'), function() { addamount(100, t('sq_community_chest')); });
communityChestCards[6]  = new Card(t('cc6'), function() { addamount(100, t('sq_community_chest')); });
communityChestCards[7]  = new Card(t('cc7'), function() { addamount(25, t('sq_community_chest')); });
communityChestCards[8]  = new Card(t('cc8'), function() { subtractamount(100, t('sq_community_chest')); });
communityChestCards[9]  = new Card(t('cc9'), function() { addamount(200, t('sq_community_chest')); });
communityChestCards[10] = new Card(t('cc10'), function() { subtractamount(50, t('sq_community_chest')); });
communityChestCards[11] = new Card(t('cc11'), function() { subtractamount(50, t('sq_community_chest')); });
communityChestCards[12] = new Card(t('cc12'), function() { collectfromeachplayer(10, t('sq_community_chest')); });
communityChestCards[13] = new Card(t('cc13'), function() { advance(0); });
communityChestCards[14] = new Card(t('cc14'), function() { catastrophe(); });
communityChestCards[15] = new Card(t('cc15'), function() { gotojail(); });

// ------------------------------------------------------------
// Cơ Hội (Chance) — Vietnamese flavor, same effects
// ------------------------------------------------------------
var chanceCards = [];

chanceCards[0]  = new Card(t('ch0'), function(p) { p.chanceJailCard = true; updateOwned(); });
chanceCards[1]  = new Card(t('ch1'), function(p) { drawSnipeCard(); });
chanceCards[2]  = new Card(t('ch2'), function() { subtractamount(15, t('sq_chance')); });
chanceCards[3]  = new Card(t('ch3'), function() { payeachplayer(50, t('sq_chance')); });
chanceCards[4]  = new Card(t('ch4'), function() { gobackthreespaces(); });
chanceCards[5]  = new Card(t('ch5'), function() { advanceToNearestUtility(); });
chanceCards[6]  = new Card(t('ch6'), function() { addamount(50, t('sq_chance')); });
chanceCards[7]  = new Card(t('ch7'), function() { advanceToNearestRailroad(); });
chanceCards[8]  = new Card(t('ch8'), function() { propertyTaxReassessment(); });
chanceCards[9]  = new Card(t('ch9'), function() { advance(5); });
chanceCards[10] = new Card(t('ch10'), function() { advance(39); });
chanceCards[11] = new Card(t('ch11'), function() { advance(24); });
chanceCards[12] = new Card(t('ch12'), function() { addamount(150, t('sq_chance')); });
chanceCards[13] = new Card(t('ch13'), function() { advanceToNearestRailroad(); });
chanceCards[14] = new Card(t('ch14'), function() { advance(11); });
chanceCards[15] = new Card(t('ch15'), function() { gotojail(); });
