var sim = require('./tycoon-sim.js');
var t = sim.loadSquares();
var errors = 0;
for (var s = 1; s <= 500; s++) {
  try {
    var r = sim.playGame(t, sim.makeRng(s), {maxRounds:200});
    if (r.winner === undefined) { console.log('seed ' + s + ': no winner'); errors++; }
  } catch(e) { console.log('seed ' + s + ': ERROR ' + e.message); errors++; }
}
console.log('500 games, errors: ' + errors);
