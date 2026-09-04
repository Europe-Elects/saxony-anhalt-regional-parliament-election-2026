#!/usr/bin/env node
/* Run: node scripts/build-data.test.js
   No framework — the repo has no build step and this needs to stay
   runnable from a bare Action runner. */

const assert = require('assert');
const { parseCSV, parseNum, splitParty, buildExit, buildResults } = require('./build-data');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n         ${e.message}`); }
}
const throws = (fn, re) => assert.throws(fn, re);

const EXIT_HEADER = '"","CDU","AfD","Linke","SPD","GRÜNE","BSW","FDP","FW"';
const exitCsv = (...rows) => [EXIT_HEADER, ...rows].join('\n');
const exitRows = (...rows) => parseCSV(exitCsv(...rows));

console.log('\nparsing');
test('strips percent signs and handles decimal commas', () => {
  assert.strictEqual(parseNum('41.7%'), 41.7);
  assert.strictEqual(parseNum('41,7'), 41.7);
  assert.strictEqual(parseNum('0'), 0);
});
test('empty cell is null, not zero', () => {
  assert.strictEqual(parseNum(''), null);
  assert.strictEqual(parseNum(null), null);
});
test('quoted commas inside a cell do not split it', () => {
  const rows = parseCSV('"a","b, c","d"');
  assert.deepStrictEqual(rows[0], ['a', 'b, c', 'd']);
});

console.log('\nparty label splitting');
test('splits code and EU group', () => {
  assert.deepStrictEqual(splitParty('CDU (EPP)'), { code: 'CDU', name: 'CDU', label: 'CDU (EPP)', euro: 'EPP' });
});
test('handles umlauts and mixed case', () => {
  assert.strictEqual(splitParty('GRÜNE (Greens/EFA)').code, 'GRUENE');
  assert.strictEqual(splitParty('LINKE (Left)').code, 'LINKE');
});
test('unknown party keeps its label but has no code', () => {
  const p = splitParty('Gartenpartei (*)');
  assert.strictEqual(p.code, 'GARTEN');
  assert.strictEqual(splitParty('Irgendwas (*)').code, null);
});
test('label without a group does not crash', () => {
  assert.deepStrictEqual(splitParty('Volt'), { code: 'VOLT', name: 'Volt', label: 'Volt', euro: null });
});

console.log('\nexit poll — the live shape');
test('empty sheet is valid but not published', () => {
  const out = buildExit(exitRows('"Infratest dimap for ARD","","","","","","",""'), { max: 100, integer: false });
  assert.strictEqual(out.published, false);
  assert.strictEqual(out.rows.length, 1);
});
test('real figures mark it published and keep sheet shape', () => {
  const out = buildExit(exitRows('"Infratest dimap for ARD","22%","42%","12%","8%","5%","4%","3%",""'), { max: 100, integer: false });
  assert.strictEqual(out.published, true);
  assert.strictEqual(out.header[1], 'CDU');
  assert.strictEqual(out.rows[0][0], 'Infratest dimap for ARD');
});
test('a blank column stays blank rather than becoming 0%', () => {
  const out = buildExit(exitRows('"Infratest dimap for ARD","22%","42%","12%","8%","5%","4%","3%",""'), { max: 100, integer: false });
  assert.strictEqual(parseNum(out.rows[0][8]), null);
});

console.log('\nexit poll — election-night failure modes');
test('rejects the percent-formatting trap (41.7 typed into a % cell)', () => {
  throws(() => buildExit(exitRows('"Infratest dimap for ARD","4170%","10%","","","","",""'), { max: 100, integer: false }),
    /out of range/);
});
test('rejects shares that sum past 105', () => {
  throws(() => buildExit(exitRows('"Infratest dimap for ARD","60%","60%","","","","",""'), { max: 100, integer: false }),
    /sum to/);
});
test('rejects negative values', () => {
  throws(() => buildExit(exitRows('"Infratest dimap for ARD","-5%","","","","","",""'), { max: 100, integer: false }),
    /out of range/);
});
test('rejects fractional seat counts', () => {
  throws(() => buildExit(exitRows('"Infratest dimap for ARD","40.5","","","","","",""'), { max: 145, integer: true }),
    /non-integer seat/);
});
test('rejects a sheet with a header but no institute rows', () => {
  throws(() => buildExit(parseCSV(EXIT_HEADER + '\n"",""'), { max: 100, integer: false }), /no institute rows/);
});
test('tolerates a party column being added mid-evening', () => {
  const rows = parseCSV([
    '"","CDU","AfD","Linke","SPD","GRÜNE","BSW","FDP","FW","Volt"',
    '"Infratest dimap for ARD","22%","42%","12%","8%","5%","4%","3%","","1%"',
  ].join('\n'));
  const out = buildExit(rows, { max: 100, integer: false });
  assert.strictEqual(out.header.length, 10);
  assert.strictEqual(out.rows[0].length, 10);
});

const RESULTS_HEADER = '"Party","Votes","Vote Share","Seats","Change V","Change S"';
const resultsRows = (...rows) => parseCSV([RESULTS_HEADER, ...rows].join('\n'));

console.log('\nresults');
test('zero votes are reported as pending, not as a wipeout', () => {
  const out = buildResults(resultsRows('"CDU (EPP)","0","0.00%","0","-37.12%","-40"'));
  const cdu = out.parties[0];
  assert.strictEqual(cdu.reported, false);
  assert.strictEqual(cdu.changeV, null, 'the -37.12% must not reach the front-end');
  assert.strictEqual(cdu.share, null);
  assert.strictEqual(out.counting, false);
});
test('once votes land, the sheet-computed change is passed through', () => {
  const out = buildResults(resultsRows('"CDU (EPP)","120000","21.50%","20","-15.62%","-20"'));
  const cdu = out.parties[0];
  assert.strictEqual(cdu.reported, true);
  assert.strictEqual(cdu.share, 21.5);
  assert.strictEqual(cdu.changeV, -15.62);
  assert.strictEqual(cdu.changeS, -20);
  assert.strictEqual(out.counting, true);
});
test('picks up the valid-votes total row and excludes it from parties', () => {
  const out = buildResults(resultsRows(
    '"CDU (EPP)","120000","21.50%","20","-15.62%","-20"',
    '"Valid votes counted","558000","","","",""',
  ));
  assert.strictEqual(out.validVotes, 558000);
  assert.strictEqual(out.parties.length, 1);
});
test('rejects an impossible vote share', () => {
  throws(() => buildResults(resultsRows('"CDU (EPP)","120000","210.00%","20","",""')), /out of range/);
});
test('rejects shares summing past 105 across parties', () => {
  throws(() => buildResults(resultsRows(
    '"CDU (EPP)","1","60.00%","20","",""',
    '"AfD (ESN)","1","60.00%","20","",""',
  )), /sum to/);
});
test('partially entered rows do not poison the reported ones', () => {
  const out = buildResults(resultsRows(
    '"CDU (EPP)","120000","21.50%","20","-15.62%","-20"',
    '"Volt (Greens/EFA)","0","0.00%","","0.00%",""',
  ));
  assert.strictEqual(out.parties[0].reported, true);
  assert.strictEqual(out.parties[1].reported, false);
  assert.strictEqual(out.parties[1].share, null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
