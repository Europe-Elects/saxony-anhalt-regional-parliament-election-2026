#!/usr/bin/env node
/* Fetches the Path 2 sheet tabs and writes /data/*.json.
   Path 1 sections (Projections, Coalition Options, Turnout, Electoral
   History) are Datawrapper embeds wired straight to the Sheet — see
   CLAUDE.md — and are deliberately not handled here.

   Fail-safe contract: a tab that fails to fetch, parse or validate leaves
   its existing JSON file untouched. Publishing stale data beats publishing
   wrong data on election night. */

const fs = require('fs');
const path = require('path');

const SHEET_ID = '1ikZkOUhOHG6VmfxZYZCjEEQiAI82SabRxUOhy9VLpyw';
const DATA_DIR = path.join(__dirname, '..', 'data');
const SEATS_TOTAL = 97;

const csvUrl = tab =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  const s = String(text).split('\r\n').join('\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}

function parseNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace('%', '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

/* "CDU (EPP)" -> {code:'CDU', label:'CDU (EPP)', euro:'EPP'} */
const PARTY_CODES = {
  cdu: 'CDU', afd: 'AfD', linke: 'LINKE', 'die linke': 'LINKE', spd: 'SPD',
  grune: 'GRUENE', gruene: 'GRUENE', fdp: 'FDP', bsw: 'BSW', fw: 'FW',
  'freie wahler': 'FW', basis: 'BASIS', diebasis: 'BASIS', 'die basis': 'BASIS',
  tierschutzpartei: 'TSP', gartenpartei: 'GARTEN', partei: 'PARTEI',
  'die partei': 'PARTEI', tierschutzallianz: 'TSA', pdf: 'PDF', volt: 'VOLT',
  npd: 'NPD', dvu: 'DVU', schill: 'SCHILL', rep: 'REP',
};

function splitParty(label) {
  const raw = String(label || '').trim();
  const m = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const name = (m ? m[1] : raw).trim();
  const euro = m ? m[2].trim() : null;
  const key = name.toLowerCase()
    .replace(/[äàá]/g, 'a').replace(/[üù]/g, 'u').replace(/[öò]/g, 'o').replace(/ß/g, 'ss');
  return { code: PARTY_CODES[key] || null, name, label: raw, euro };
}

async function fetchTab(tab, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(csvUrl(tab), { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const rows = parseCSV(text);
      if (rows.length < 2) throw new Error('fewer than 2 rows');
      return rows;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`${tab}: ${lastErr.message}`);
}

/* ---------- transforms ---------- */

/* Institutes as rows, parties as columns. Kept in sheet shape so the
   front-end renderer can consume `rows` unchanged. */
function buildExit(rows, { max, integer }) {
  const header = rows[0];
  const body = rows.slice(1).filter(r => r[0]);
  if (!body.length) throw new Error('no institute rows');

  for (const r of body) {
    let sum = 0;
    for (const cell of r.slice(1)) {
      const n = parseNum(cell);
      if (n == null) continue;
      if (n < 0 || n > max) throw new Error(`value ${n} out of range 0..${max} for "${r[0]}"`);
      if (integer && !Number.isInteger(n)) throw new Error(`non-integer seat ${n} for "${r[0]}"`);
      sum += n;
    }
    if (!integer && sum > 105) throw new Error(`shares for "${r[0]}" sum to ${sum}`);
    if (integer && sum > SEATS_TOTAL * 1.5) throw new Error(`seats for "${r[0]}" sum to ${sum}`);
  }

  return {
    updated: new Date().toISOString(),
    published: body.some(r => r.slice(1).some(c => parseNum(c) != null)),
    header,
    rows: body,
  };
}

function buildResults(rows) {
  const body = rows.slice(1).filter(r => r[0]);
  const totalRow = body.find(r => /valid votes/i.test(r[0]));
  const validVotes = totalRow ? (parseNum(totalRow[1]) || 0) : 0;

  const parties = body.filter(r => r !== totalRow).map(r => {
    const p = splitParty(r[0]);
    const votes = parseNum(r[1]);
    const share = parseNum(r[2]);
    const seats = parseNum(r[3]);
    const reported = votes != null && votes > 0;
    if (share != null && (share < 0 || share > 100)) throw new Error(`share ${share} out of range for "${r[0]}"`);
    if (seats != null && (seats < 0 || seats > SEATS_TOTAL * 1.5)) throw new Error(`seats ${seats} implausible for "${r[0]}"`);
    return {
      ...p,
      votes: reported ? votes : null,
      share: reported ? share : null,
      seats: reported ? seats : null,
      // The sheet computes these against a hardcoded 2021 baseline and so
      // serves a full negative swing while votes are still zero.
      changeV: reported ? parseNum(r[4]) : null,
      changeS: reported ? parseNum(r[5]) : null,
      reported,
    };
  });

  const totalShare = parties.reduce((a, p) => a + (p.share || 0), 0);
  if (totalShare > 105) throw new Error(`vote shares sum to ${totalShare}`);

  return {
    updated: new Date().toISOString(),
    validVotes,
    counting: parties.some(p => p.reported),
    parties,
  };
}

/* Long format in, nested object out. Shape matches what the page already
   renders: {data:{Category:{Subgroup:{PARTY:{year:share}}}}, order, years}.
   Subgroup and category order follows the sheet, so reordering rows there
   reorders the dropdowns here. */
function buildDemographic(rows) {
  const header = rows[0];
  const years = header.slice(3).filter(y => /^\d{4}$/.test(y));
  if (!years.length) throw new Error('no year columns');

  const data = {}, order = {};
  for (const r of rows.slice(1)) {
    const [category, subgroup, party] = [r[0], r[1], r[2]];
    if (!category || !subgroup || !party) continue;
    const code = splitParty(party).code;
    if (!code) throw new Error(`unknown party "${party}" in ${category}/${subgroup}`);

    (order[category] ||= []);
    if (!order[category].includes(subgroup)) order[category].push(subgroup);

    const bucket = ((data[category] ||= {})[subgroup] ||= {});
    const series = (bucket[code] ||= {});
    years.forEach((y, i) => {
      const v = parseNum(r[3 + i]);
      if (v == null) return;
      if (v < 0 || v > 100) throw new Error(`share ${v} out of range for ${category}/${subgroup}/${party} in ${y}`);
      series[y] = v;
    });
  }

  /* A subgroup can exist in the sheet with every cell still blank - a row
     prepared for figures nobody has published yet. It just should not reach
     the dropdowns until it has something to show. */
  for (const [cat, subs] of Object.entries(data)) {
    for (const [sub, parties] of Object.entries(subs)) {
      for (const [code, series] of Object.entries(parties)) {
        if (!Object.keys(series).length) delete parties[code];
      }
      if (!Object.keys(parties).length) {
        delete subs[sub];
        order[cat] = order[cat].filter(s => s !== sub);
      }
    }
    if (!order[cat].length) { delete data[cat]; delete order[cat]; }
  }

  if (!Object.keys(data).length) throw new Error('no figures in any group');
  return { updated: new Date().toISOString(), years, order, data };
}

/* ---------- runner ---------- */

const TARGETS = [
  { file: 'exitVotes.json', tab: 'exit', build: r => buildExit(r, { max: 100, integer: false }) },
  { file: 'exitSeats.json', tab: 'exit_seat', build: r => buildExit(r, { max: SEATS_TOTAL * 1.5, integer: true }) },
  { file: 'results.json', tab: 'results', build: buildResults },
  { file: 'demographic.json', tab: 'demographic vote - Infratest', build: buildDemographic },
];

/* Only rewrite when something other than the timestamp changed, so the
   Action does not commit (and Pages does not rebuild) on every poll. */
function writeIfChanged(file, payload) {
  const dest = path.join(DATA_DIR, file);
  const next = JSON.stringify(payload, null, 2);
  if (fs.existsSync(dest)) {
    const strip = s => s.replace(/^\s*"updated": "[^"]*",?$/m, '').trim();
    if (strip(fs.readFileSync(dest, 'utf8')) === strip(next)) return false;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(dest, next + '\n');
  return true;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let failures = 0, changes = 0;

  for (const t of TARGETS) {
    try {
      const rows = await fetchTab(t.tab);
      const changed = writeIfChanged(t.file, t.build(rows));
      changes += changed ? 1 : 0;
      console.log(`${changed ? 'updated' : 'unchanged'}  ${t.file}  (${t.tab})`);
    } catch (e) {
      failures++;
      const kept = fs.existsSync(path.join(DATA_DIR, t.file));
      console.error(`FAILED   ${t.file}  (${t.tab}): ${e.message}${kept ? ' — keeping previous file' : ' — no previous file to keep'}`);
    }
  }

  console.log(`\n${changes} file(s) changed, ${failures} tab(s) failed`);
  if (failures === TARGETS.length) {
    console.error('every tab failed — treating as an error');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseCSV, parseNum, splitParty, buildExit, buildResults, buildDemographic, writeIfChanged };
