var sim = require('./tycoon-sim.js');
var t = sim.loadSquares();
var wins = { Shark: 0, Careful: 0, Monopolist: 0 };
var elimFirst = { Shark: 0, Careful: 0, Monopolist: 0 };
var survivalRounds = { Shark: 0, Careful: 0, Monopolist: 0 };
var capped = 0;
var total = 1000;

for (var s = 1; s <= total; s++) {
  var r = sim.playGame(t, sim.makeRng(s), { maxRounds: 200 });
  wins[r.winner]++;
  if (r.capped) capped++;

  // Track who dies first
  var firstDeath = null;
  for (var i = 0; i < r.players.length; i++) {
    var p = r.players[i];
    if (p.bankrupt) {
      if (firstDeath === null || p.bankruptRound < firstDeath.round) {
        firstDeath = { name: p.name, round: p.bankruptRound };
      }
    }
    survivalRounds[p.name] += p.bankrupt ? p.bankruptRound : r.rounds;
  }
  if (firstDeath) elimFirst[firstDeath.name]++;
}

console.log('=== WIN RATES (1000 games) ===');
for (var name in wins) {
  console.log(name + ': ' + wins[name] + ' wins (' + (wins[name] / total * 100).toFixed(1) + '%)');
}
console.log('\n=== FIRST ELIMINATED ===');
for (var name in elimFirst) {
  console.log(name + ': dies first ' + elimFirst[name] + ' times (' + (elimFirst[name] / total * 100).toFixed(1) + '%)');
}
console.log('\n=== AVG SURVIVAL (rounds) ===');
for (var name in survivalRounds) {
  console.log(name + ': ' + (survivalRounds[name] / total).toFixed(1));
}
console.log('\nCapped (no elimination): ' + capped + ' (' + (capped / total * 100).toFixed(1) + '%)');
