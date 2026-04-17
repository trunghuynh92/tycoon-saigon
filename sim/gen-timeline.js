#!/usr/bin/env node
// gen-timeline.js — Run a single sim game and produce an HTML timeline chart
// Usage: node gen-timeline.js [--seed N] [--max-rounds N] [--out filename.html]

const path = require('path');
const fs = require('fs');
const sim = require('./tycoon-sim.js');

// Parse args
const args = process.argv.slice(2);
let seed = 42, maxRounds = 200, outFile = path.join(__dirname, '..', 'sim-timeline.html');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') seed = parseInt(args[++i], 10);
  else if (args[i] === '--max-rounds') maxRounds = parseInt(args[++i], 10);
  else if (args[i] === '--out') outFile = args[++i];
}

const template = sim.loadSquares();
const rng = sim.makeRng(seed);
const result = sim.playGame(template, rng, { maxRounds: maxRounds, verbose: true });

const timeline = result.timeline || [];
const events = result.events || [];

if (timeline.length === 0) {
  console.error('No timeline data captured. Check that snapshotTimeline() is called.');
  process.exit(1);
}

// Extract player names from first snapshot
const playerNames = timeline[0].players.map(p => p.name);
const rounds = timeline.map(t => t.round);

// Build per-player series
function buildSeries(field) {
  return playerNames.map(name => {
    return timeline.map(t => {
      const p = t.players.find(pp => pp.name === name);
      return p ? p[field] : 0;
    });
  });
}

const nwSeries = buildSeries('nw');
const cashSeries = buildSeries('cash');
const debtSeries = buildSeries('debt');
const housesSeries = buildSeries('houses');
const propsSeries = buildSeries('props');

// Player colors
const colors = [
  'rgba(231, 76, 60, 1)',    // red — Shark
  'rgba(52, 152, 219, 1)',   // blue — Balanced
  'rgba(46, 204, 113, 1)',   // green — Careful
  'rgba(241, 196, 15, 1)',   // yellow — Gambler
];
const bgColors = colors.map(c => c.replace(', 1)', ', 0.15)'));

// Event type → color/style
const eventStyles = {
  catastrophe: { color: '#e74c3c', label: 'Catastrophe', dash: [6, 3] },
  propertyTax: { color: '#f39c12', label: 'Property Tax', dash: [4, 4] },
  crisis:      { color: '#8e44ad', label: 'Crisis',       dash: [10, 4] },
  fireSale:    { color: '#2c3e50', label: 'Fire Sale',     dash: [2, 2] },
};

// Build Chart.js annotation plugin config for events
function buildAnnotations() {
  const annotations = {};
  events.forEach((evt, i) => {
    const style = eventStyles[evt.type] || { color: '#999', label: evt.type, dash: [] };
    annotations['event' + i] = {
      type: 'line',
      xMin: evt.round,
      xMax: evt.round,
      borderColor: style.color,
      borderWidth: 1.5,
      borderDash: style.dash,
      label: {
        display: true,
        content: style.label,
        position: 'start',
        backgroundColor: style.color,
        color: '#fff',
        font: { size: 9, weight: 'bold' },
        padding: 3,
        rotation: -90,
        yAdjust: -10,
      }
    };
  });
  return annotations;
}

// Summary text
const winner = result.winner;
const roundsPlayed = result.rounds;
const capped = result.capped;
const playerSummary = result.players.map(p =>
  `${p.name}: ${p.bankrupt ? 'Bankrupt R' + p.bankruptRound : '$' + p.finalNetWorth}`
).join(' | ');

const annotations = JSON.stringify(buildAnnotations());

function makeDatasets(series, field) {
  return playerNames.map((name, i) => {
    return {
      label: name,
      data: series[i],
      borderColor: colors[i],
      backgroundColor: bgColors[i],
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      fill: false,
    };
  });
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tycoon Saigon — Simulation Timeline (Seed ${seed})</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.0.1/dist/chartjs-plugin-annotation.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #eee; font-family: 'Segoe UI', sans-serif; padding: 20px; }
  h1 { text-align: center; color: #e94560; margin-bottom: 5px; font-size: 24px; }
  .subtitle { text-align: center; color: #aaa; margin-bottom: 20px; font-size: 13px; }
  .chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .chart-box { background: #16213e; border-radius: 10px; padding: 16px; }
  .chart-box h3 { color: #0f3460; font-size: 14px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; color: #aaa; }
  canvas { width: 100% !important; }
  .legend-box { display: flex; justify-content: center; gap: 24px; margin: 12px 0 20px; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 3px; }
  .event-legend { display: flex; justify-content: center; gap: 20px; margin-bottom: 16px; }
  .event-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #aaa; }
  .event-line { width: 20px; height: 2px; }
  .summary { text-align: center; color: #aaa; font-size: 13px; margin-top: 10px; }
  .summary strong { color: #e94560; }
</style>
</head>
<body>
<h1>Tycoon Saigon — Game Timeline</h1>
<div class="subtitle">Seed ${seed} | ${roundsPlayed} rounds${capped ? ' (capped)' : ''} | Winner: <strong style="color:#e94560">${winner}</strong></div>

<div class="legend-box">
${playerNames.map((n, i) => `  <div class="legend-item"><div class="legend-dot" style="background:${colors[i]}"></div>${n}</div>`).join('\n')}
</div>

<div class="event-legend">
  <div class="event-item"><div class="event-line" style="background:#e74c3c"></div>Catastrophe</div>
  <div class="event-item"><div class="event-line" style="background:#f39c12"></div>Property Tax</div>
  <div class="event-item"><div class="event-line" style="background:#8e44ad"></div>Crisis</div>
  <div class="event-item"><div class="event-line" style="background:#2c3e50; border: 1px solid #7f8c8d"></div>Fire Sale</div>
</div>

<div class="chart-row">
  <div class="chart-box">
    <h3>Net Worth</h3>
    <canvas id="chartNW"></canvas>
  </div>
  <div class="chart-box">
    <h3>Cash</h3>
    <canvas id="chartCash"></canvas>
  </div>
</div>
<div class="chart-row">
  <div class="chart-box">
    <h3>Debt (Mortgage)</h3>
    <canvas id="chartDebt"></canvas>
  </div>
  <div class="chart-box">
    <h3>Buildings (House Units)</h3>
    <canvas id="chartHouses"></canvas>
  </div>
</div>
<div class="chart-row">
  <div class="chart-box" style="grid-column: span 2;">
    <h3>Properties Owned</h3>
    <canvas id="chartProps"></canvas>
  </div>
</div>

<div class="summary">${playerSummary}</div>

<script>
const rounds = ${JSON.stringify(rounds)};
const annotations = ${annotations};

const chartOpts = {
  responsive: true,
  animation: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { display: false },
    annotation: { annotations: annotations },
    tooltip: {
      backgroundColor: 'rgba(22,33,62,0.95)',
      titleColor: '#e94560',
      bodyColor: '#eee',
      callbacks: {
        label: function(ctx) {
          return ctx.dataset.label + ': $' + (ctx.raw || 0).toLocaleString();
        }
      }
    }
  },
  scales: {
    x: {
      title: { display: true, text: 'Round', color: '#666' },
      ticks: { color: '#555', maxTicksLimit: 20 },
      grid: { color: 'rgba(255,255,255,0.05)' }
    },
    y: {
      ticks: { color: '#555', callback: function(v) { return '$' + v.toLocaleString(); } },
      grid: { color: 'rgba(255,255,255,0.08)' }
    }
  }
};

const housesOpts = JSON.parse(JSON.stringify(chartOpts));
housesOpts.scales.y.ticks.callback = function(v) { return v; };
housesOpts.plugins.tooltip.callbacks = { label: function(ctx) { return ctx.dataset.label + ': ' + (ctx.raw || 0); } };

const propsOpts = JSON.parse(JSON.stringify(housesOpts));

function makeChart(id, datasets, opts) {
  new Chart(document.getElementById(id), {
    type: 'line',
    data: { labels: rounds, datasets: datasets },
    options: opts || chartOpts
  });
}

const nwData = ${JSON.stringify(makeDatasets(nwSeries, 'nw'))};
const cashData = ${JSON.stringify(makeDatasets(cashSeries, 'cash'))};
const debtData = ${JSON.stringify(makeDatasets(debtSeries, 'debt'))};
const housesData = ${JSON.stringify(makeDatasets(housesSeries, 'houses'))};
const propsData = ${JSON.stringify(makeDatasets(propsSeries, 'props'))};

makeChart('chartNW', nwData);
makeChart('chartCash', cashData);
makeChart('chartDebt', debtData);
makeChart('chartHouses', housesData, housesOpts);
makeChart('chartProps', propsData, propsOpts);
</script>
</body>
</html>`;

fs.writeFileSync(outFile, html, 'utf8');
console.log('Timeline written to: ' + outFile);
console.log('Seed: ' + seed + ', Rounds: ' + roundsPlayed + ', Winner: ' + winner);
console.log('Timeline snapshots: ' + timeline.length + ', Events: ' + events.length);
console.log('Events: ' + events.map(e => 'R' + e.round + ' ' + e.type).join(', '));
