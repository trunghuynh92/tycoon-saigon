#\!/usr/bin/env node
/**
 * 4-Monopolist simulation — VANILLA mode (no events, no leverage, no COL)
 * Compare against the Tycoon Saigon version to see if "get monopoly = win"
 * is inherent to Monopoly or amplified by our mechanics.
 */

// Disable Tycoon Saigon mechanics before requiring the module
// The module uses module-level `let` variables, so we need to
// set them after require via CLI flag parsing in main().
// Instead, we'll fork the approach: run via child_process with flags.

const { execSync } = require('child_process');

// Run the main sim with vanilla flags, but we need 4 monopolists...
// Actually, let's just duplicate the logic with flags set manually.

// Simpler: just modify the module globals after require
// Problem: they're `let` not `exports`. So let's use the CLI approach.

// CLEANEST: write a tiny wrapper that sets process.argv and calls main
// Nah — let me just inline the same logic from four-monopolist-sim.js
// but tweak the tycoon-sim globals before running.

// The module variables are `let` at module scope — not accessible from outside.
// The only way to control them is via CLI args parsed in main().
// But playGame doesn't read CLI args — those are set in main().
// The variables ARE set before playGame runs if we call main()... but we
// don't want main(), we want playGame with custom players.

// SOLUTION: just set process.argv before requiring the module, since the
// module parses args at require time? No, it parses in main().

// OK let's just do it the dumb way: copy the needed flags into the module
// source at runtime. Actually the REAL solution: add --no-events etc as
// environment variables or just accept that we need to modify the sim
// to export the config setters.

// PRAGMATIC: Run the existing four-monopolist-sim.js but with a modified
// copy of tycoon-sim.js where the defaults are vanilla. Or...

// ACTUALLY SIMPLEST: the four-monopolist-sim.js requires tycoon-sim.js
// which has module-level lets. We can't change them from outside.
// But we CAN use Node's vm module or just... modify them via a hack:

// Let's use the fact that the sim's main() DOES parse CLI args and sets
// those variables. If we restructure: call a setup function first.

// I'll just add a configure function to tycoon-sim.js exports.
console.log('See four-monopolist-sim.js — adding config export to tycoon-sim.js');
