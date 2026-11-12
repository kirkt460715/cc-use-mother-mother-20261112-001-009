import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../scenarios/store.js';
import { Scenario } from '../ward_calendar/model.js';
import { Engine } from '../simulation/engine.js';
import { backup, restoreBackup } from '../scenarios/recovery.js';
import { exportArchive, inspectArchive, csv } from '../scenarios/archive.js';
import { parseCSV, patientsFromCSV, inputProfile } from '../scenarios/exchange.js';
import { reportPlan, verifyReport, compactSummary } from '../simulation/report.js';
import { extendedQuery } from '../simulation/report-query.js';
import { page, query } from '../simulation/explorer.js';
import { canonical, digest, load } from '../scenarios/values.js';
import { execute, demo } from '../ward-sim.js';

function fixture() {
  return JSON.parse(readFileSync('fixtures/wards.json', 'utf8'));
}

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'ward-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('immutable scenario identities accept exact replay and reject changed content', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  const first = store.putScenario('source', fixture());
  assert.deepEqual(store.putScenario('source', fixture()), first);
  const changed = fixture();
  changed.policy.queue = 'fifo';
  assert.throws(() => store.putScenario('source', changed), /immutable/);
  assert.equal(store.scenario('source').fingerprint, first.input_digest);
  assert.deepEqual(store.keys('scenarios'), ['source']);
  assert.equal(store.audit().scenarios, 1);
  assert.throws(() => store.path('unknown', 'source'), /unknown/);
  assert.throws(() => store.path('scenarios', '../source'), /identifier/);
});

test('stored runs and resumed checkpoints share the validated scenario snapshot', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  const uninterrupted = store.run('full', 'source');
  const checkpoint = store.checkpoint('middle', 'source', 4);
  const resumed = store.resume('resumed', 'middle');
  assert.equal(checkpoint.scenario, 'source');
  assert.deepEqual(resumed, uninterrupted);
  assert.deepEqual(store.result('full'), uninterrupted);
  assert.deepEqual(store.run('full', 'source'), uninterrupted);
  assert.equal(store.audit().runs, 2);
  assert.equal(store.audit().checkpoints, 1);
  assert.equal(store.audit().valid, true);
});

test('labels remain tied to exact result identities', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  const full = store.run('full', 'source');
  store.run('second', 'source');
  const label = store.label('public', 'full');
  assert.equal(label.result_digest, full.result.result_digest);
  assert.deepEqual(store.label('public', 'full'), label);
  assert.throws(() => store.label('public', 'second'), /immutable/);
  assert.equal(store.publication('public').run, 'full');
  assert.equal(store.audit().labels, 1);
  assert.equal(store.audit().runs, 2);
});

test('write locks and interrupted staging files fail visibly without overwriting records', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  const lock = store.path('scenarios', 'source') + '.lock';
  writeFileSync(lock, 'owner');
  assert.throws(() => store.putScenario('source', fixture()), /locked/);
  assert.equal(readFileSync(lock, 'utf8'), 'owner');
  assert.throws(() => store.audit(), /interrupted/);
  rmSync(lock);
  store.putScenario('source', fixture());
  const stage = store.path('runs', 'interrupted') + '.staging';
  writeFileSync(stage, 'partial');
  assert.throws(() => store.audit(), /interrupted/);
  assert.equal(readFileSync(stage, 'utf8'), 'partial');
  assert.equal(store.scenario('source').patients.size, 6);
});

test('store rejects symlink roots and records', t => {
  const root = temporary(t);
  mkdirSync(join(root, 'real'));
  symlinkSync(join(root, 'real'), join(root, 'link'));
  assert.throws(() => new Store(join(root, 'link')), /symlink/);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  symlinkSync(store.path('scenarios', 'source'), store.path('scenarios', 'linked'));
  assert.throws(() => store.scenario('linked'), /regular/);
  assert.throws(() => store.audit(), /regular/);
  assert.equal(store.scenario('source').patients.size, 6);
  assert.equal(existsSync(store.path('scenarios', 'linked')), true);
});

test('backup and restore validate both file checksums and business replay', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  store.run('full', 'source');
  store.checkpoint('middle', 'source', 2);
  store.label('public', 'full');
  const saved = backup(store, join(root, 'backup'));
  assert.equal(saved.files, 4);
  const restored = restoreBackup(join(root, 'backup'), join(root, 'restored'), saved.manifest_digest);
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.audit, store.audit());
  const copy = new Store(join(root, 'restored'));
  assert.deepEqual(copy.result('full'), store.result('full'));
  assert.deepEqual(copy.publication('public'), store.publication('public'));
});

test('restore rejects wrong checksum and existing target without destructive cleanup', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  const saved = backup(store, join(root, 'backup'));
  assert.throws(() => restoreBackup(join(root, 'backup'), join(root, 'bad'), '0'.repeat(64)), /checksum/);
  assert.equal(existsSync(join(root, 'bad')), false);
  assert.throws(() => restoreBackup(join(root, 'backup'), join(root, 'store'), saved.manifest_digest), /exists/);
  assert.equal(store.scenario('source').patients.size, 6);
  assert.throws(() => backup(store, join(root, 'backup')), /exists/);
  assert.equal(load(join(root, 'backup/backup.json')).version, 1);
  assert.equal(store.audit().valid, true);
});

test('backup content tampering is rejected before creating a restore destination', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  const saved = backup(store, join(root, 'backup'));
  writeFileSync(join(root, 'backup/scenarios/source.json'), '{}');
  assert.throws(() => restoreBackup(join(root, 'backup'), join(root, 'bad'), saved.manifest_digest), /checksum/);
  assert.equal(existsSync(join(root, 'bad')), false);
  assert.equal(store.scenario('source').patients.size, 6);
  assert.equal(readFileSync(join(root, 'backup/scenarios/source.json'), 'utf8'), '{}');
  assert.equal(store.audit().scenarios, 1);
});

test('archive checksums and semantic reconstruction cover every exported artifact', t => {
  const root = temporary(t);
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const exported = exportArchive(scenario, result, join(root, 'archive'));
  assert.equal(exported.valid, true);
  assert.equal(exported.files, 7);
  assert.equal(exported.result_digest, result.result_digest);
  assert.deepEqual(inspectArchive(join(root, 'archive')), exported);
  assert.throws(() => exportArchive(scenario, result, join(root, 'archive')), /exists/);
  writeFileSync(join(root, 'archive/extra.txt'), 'extra');
  assert.throws(() => inspectArchive(join(root, 'archive')), /file set/);
  rmSync(join(root, 'archive/extra.txt'));
  writeFileSync(join(root, 'archive/patients.csv'), 'forged');
  assert.throws(() => inspectArchive(join(root, 'archive')), /checksum/);
});

test('CSV parser handles quoted delimiters, embedded newlines and strict failures', () => {
  assert.deepEqual(parseCSV('a,b\r\n"x,y","z""q"\r\n'), [['a', 'b'], ['x,y', 'z"q']]);
  assert.deepEqual(parseCSV('a\n"two\nlines"\n'), [['a'], ['two\nlines']]);
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV('a,b'), [['a', 'b']]);
  assert.throws(() => parseCSV('a\n"unterminated'), /unterminated/);
  assert.throws(() => parseCSV('a\n"ok"bad\n'), /after closing/);
  assert.throws(() => parseCSV('a\nun"quoted\n'), /quote inside/);
  const text = csv([{ a: 'x,y', b: 'line\nnext', c: null }]);
  assert.equal(parseCSV(text)[1][0], 'x,y');
  assert.equal(parseCSV(text)[1][1], 'line\nnext');
  assert.equal(csv([]), '');
});

test('patient demand CSV roundtrips model fields and validates canonical numbers', () => {
  const scenario = new Scenario(fixture());
  const text = csv(scenario.document.patients);
  const reconstructed = patientsFromCSV(scenario, text);
  assert.equal(reconstructed.fingerprint, scenario.fingerprint);
  assert.equal(inputProfile(reconstructed).patients, 6);
  assert.equal(inputProfile(reconstructed).specialties[0].arrivals, 6);
  assert.throws(() => patientsFromCSV(scenario, text.replace('false', 'False')), /true or false/);
  assert.throws(() => patientsFromCSV(scenario, text.replace(',12\n', ',012\n')), /canonical/);
  assert.throws(() => patientsFromCSV(scenario, 'id,id\np1,p2\n'), /header/);
  assert.throws(() => patientsFromCSV(scenario, text + 'incomplete\n'), /width/);
  assert.equal(scenario.patients.get('p1').stay, 12);
});

test('result pagination binds cursors to table, filters and result identity', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const first = page(result, 'events', { limit: 2 });
  const second = page(result, 'events', { limit: 2, cursor: first.next_cursor });
  assert.equal(first.rows.length, 2);
  assert.equal(second.rows[0].sequence, 2);
  assert.equal(first.total, result.events.length);
  assert.throws(() => page(result, 'patients', { limit: 2, cursor: first.next_cursor }), /another query/);
  assert.throws(() => page(result, 'events', { limit: 3, cursor: first.next_cursor }), /another query/);
  assert.throws(() => page(result, 'events', { cursor: '?' }), /cursor/);
  assert.equal(page(result, 'events', { patient: 'p1' }).rows.every(row => row.details.patient === 'p1'), true);
  assert.throws(() => page(result, 'intervals', { patient: 'p1' }), /incompatible/);
  assert.throws(() => page(result, 'events', { limit: 0 }), /integer/);
});

test('report plan executes and replays a coherent set of business views', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const report = compactSummary(scenario, result);
  assert.equal(report.rows.length, 7);
  assert.equal(report.complete, true);
  assert.equal(verifyReport(scenario, result, report).valid, true);
  const queues = report.rows.find(row => row.id === 'queues').output;
  assert.equal(queues.waiting_person_time, query(scenario, result, 'queue').waiting_person_time);
  const invalid = structuredClone(report.definition);
  invalid.operations.push(invalid.operations[0]);
  assert.throws(() => reportPlan(scenario, result, invalid), /duplicate/);
  const changed = structuredClone(report);
  changed.rows[0].output = {};
  assert.throws(() => verifyReport(scenario, result, changed), /checksum/);
});

test('all extended query views produce source based metrics and reject unknown options', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const kinds = ['blocked-demand', 'event-workload', 'unfinished', 'invariants', 'bed-ledger', 'construction-effects', 'equity'];
  for (const kind of kinds) {
    const value = extendedQuery(scenario, result, kind);
    assert.notEqual(value, undefined);
    assert.throws(() => extendedQuery(scenario, result, kind, { ignored: true }), /fields/);
  }
  assert.equal(extendedQuery(scenario, result, 'invariants').valid, true);
  assert.equal(extendedQuery(scenario, result, 'warmup', { cutoff: 1 }).patients, 4);
  assert.equal(extendedQuery(scenario, result, 'capacity-windows', { width: 7 }).at(-1).end, 48);
  assert.throws(() => query(scenario, result, 'unknown'), /unknown/);
});

test('CLI simulates and exposes structured failures with real exit codes', t => {
  const root = temporary(t);
  const run = spawnSync(process.execPath, ['ward-sim.js', 'simulate', 'fixtures/wards.json'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const result = JSON.parse(run.stdout);
  assert.equal(result.counts.future, 0);
  assert.equal(result.patients.length, 6);
  const failed = spawnSync(process.execPath, ['ward-sim.js', 'simulate', join(root, 'missing')], { encoding: 'utf8' });
  assert.equal(failed.status, 2);
  assert.equal(failed.stdout, '');
  assert.ok(JSON.parse(failed.stderr).error.length > 0);
  assert.throws(() => execute(['unknown']), /unknown/);
  assert.throws(() => execute(['simulate']), /argument/);
  assert.ok(Object.hasOwn(execute(['help']).commands, 'checkpoint'));
});

test('CLI workspace commands preserve exact resume and immutable labels', t => {
  const root = temporary(t);
  execute(['import', root, 'source', 'fixtures/wards.json']);
  const run = execute(['run', root, 'full', 'source']);
  execute(['checkpoint', root, 'middle', 'source', '3']);
  const resumed = execute(['resume', root, 'resumed', 'middle']);
  assert.deepEqual(run.result, resumed.result);
  const label = execute(['label', root, 'approved', 'full']);
  assert.equal(label.run, 'full');
  const audit = execute(['audit', root]);
  assert.equal(audit.runs, 2);
  assert.equal(audit.checkpoints, 1);
  assert.equal(audit.labels, 1);
  assert.equal(audit.valid, true);
});

test('acceptance demo covers simulation, comparison, export and restore', () => {
  const result = demo('fixtures/wards.json');
  assert.equal(result.source, 'local_synthetic_fixture');
  assert.equal(result.audit.valid, true);
  assert.equal(result.checkpoint_resume_identical, true);
  assert.equal(result.archive.valid, true);
  assert.equal(result.restored.restored, true);
  assert.equal(result.store_audit.runs, 2);
  assert.equal(result.store_audit.labels, 1);
  assert.equal(result.comparison.direction, 'right_minus_left');
  assert.equal(result.construction.length, 1);
  assert.equal(result.input.patients, 6);
});

test('CLI demand import writes a valid scenario and refuses overwriting output', t => {
  const root = temporary(t);
  const scenario = new Scenario(fixture());
  const source = join(root, 'patients.csv');
  writeFileSync(source, csv(scenario.document.patients));
  const destination = join(root, 'new.json');
  const imported = execute(['csv-demand', 'fixtures/wards.json', source, destination]);
  assert.equal(imported.patients, 6);
  assert.equal(new Scenario(load(destination)).fingerprint, scenario.fingerprint);
  assert.throws(() => execute(['csv-demand', 'fixtures/wards.json', source, destination]));
  assert.equal(new Scenario(load(destination)).fingerprint, scenario.fingerprint);
  const linked = join(root, 'linked.csv');
  symlinkSync(source, linked);
  assert.throws(() => execute(['csv-demand', 'fixtures/wards.json', linked, join(root, 'bad')]), /regular/);
});

test('CLI report plans write coherent views bound to both input and result', t => {
  const root = temporary(t);
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  writeFileSync(join(root, 'result.json'), canonical(result));
  writeFileSync(join(root, 'plan.json'), canonical({ version: 1, operations: [{ id: 'queues', kind: 'queue', options: {} }] }));
  const report = execute(['report-plan', 'fixtures/wards.json', join(root, 'result.json'), join(root, 'plan.json')]);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].kind, 'queue');
  assert.equal(report.result_digest, result.result_digest);
  assert.equal(report.input_digest, scenario.fingerprint);
  assert.equal(verifyReport(scenario, result, report).valid, true);
  assert.equal(report.complete, true);
});

test('unknown store files cannot disappear silently from audit', t => {
  const root = temporary(t);
  const store = new Store(join(root, 'store'));
  store.putScenario('source', fixture());
  writeFileSync(join(store.root, 'scenarios/unexpected.txt'), 'unexpected');
  assert.throws(() => store.audit(), /unknown file/);
  assert.equal(store.scenario('source').patients.size, 6);
  rmSync(join(store.root, 'scenarios/unexpected.txt'));
  assert.equal(store.audit().valid, true);
  const file = store.path('scenarios', 'source');
  const stored = load(file);
  stored.input_digest = '0'.repeat(64);
  writeFileSync(file, canonical(stored));
  assert.throws(() => store.scenario('source'), /integrity/);
});

test('report rehashing cannot conceal a changed operation result', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const report = compactSummary(scenario, result);
  report.rows[0].output = [];
  report.rows[0].output_digest = digest([]);
  const { report_digest, ...body } = report;
  report.report_digest = digest(body);
  assert.throws(() => verifyReport(scenario, result, report), /replay/);
  assert.equal(result.patients.length, 6);
  assert.equal(scenario.fingerprint, report.input_digest);
  assert.equal(report.definition.version, 1);
  assert.equal(report.complete, true);
});
