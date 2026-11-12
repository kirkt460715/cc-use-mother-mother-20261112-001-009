import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Scenario } from '../ward_calendar/model.js';
import { Engine } from '../simulation/engine.js';
import { verify } from '../simulation/audit.js';
import { capture, restore, resume } from '../simulation/checkpoint.js';
import { patientMetrics, wardMetrics, queueArea, summary, serviceLevels, describe } from '../patient_flow/metrics.js';
import { orderedQueue, availableSeat, chooseWard, relocationVictims, queueReasons } from '../patient_flow/queue.js';
import { stateAt, patientTrace } from '../simulation/explorer.js';
import { bedLedger, constructionEffects, windows } from '../simulation/capacity-audit.js';
import { blockedDemand, eventWorkload, horizonRemainders, warmup, invariantDetails } from '../simulation/diagnostics.js';
import { clone, digest } from '../scenarios/values.js';

function fixture() {
  return JSON.parse(readFileSync('fixtures/wards.json', 'utf8'));
}

function simple(patients, beds = 1, horizon = 20) {
  const document = fixture();
  document.horizon = horizon;
  document.closures = [];
  document.wards = [{ id: 'one', specialty: 'care', beds, accessible: beds, initial: [] }];
  document.patients = patients;
  return new Scenario(document);
}

function patient(id, arrival, stay, patience = 20, priority = 0, accessible = false) {
  return { id, arrival, stay, patience, priority, accessible, specialty: 'care' };
}

test('full relocation scenario conserves patients and care time', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const audit = verify(scenario, result, true);
  assert.equal(audit.valid, true);
  assert.equal(audit.patients, 6);
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b), 6);
  assert.equal(result.counts.future, 0);
  assert.equal(result.horizon, 48);
  assert.equal(result.events.at(-1).hash, result.event_root);
  assert.ok(result.events.some(row => row.kind === 'displaced'));
  assert.equal(invariantDetails(scenario, result).valid, true);
});

test('deadline admission wins over timeout at the same instant', () => {
  const scenario = simple([patient('a', 0, 5), patient('b', 0, 4, 5)]);
  const result = new Engine(scenario).run();
  const second = result.patients.find(row => row.id === 'b');
  assert.equal(second.first_admitted, 5);
  assert.equal(second.discharged, 9);
  assert.equal(second.abandoned, null);
  assert.equal(result.counts.abandoned, 0);
  const atFive = result.events.filter(row => row.time === 5);
  assert.equal(atFive[0].kind, 'discharged');
  assert.equal(atFive[1].kind, 'admitted');
  assert.equal(verify(scenario, result, true).valid, true);
});

test('zero patience admits immediately if possible and otherwise abandons', () => {
  const scenario = simple([patient('a', 0, 5, 0), patient('b', 0, 3, 0)]);
  const result = new Engine(scenario).run();
  assert.equal(result.patients[0].first_admitted, 0);
  assert.equal(result.patients[1].abandoned, 0);
  assert.equal(result.patients[1].first_admitted, null);
  assert.equal(result.counts.discharged, 1);
  assert.equal(result.counts.abandoned, 1);
  assert.equal(queueArea(result).waiting_person_time, 0);
  assert.equal(serviceLevels(scenario, result, [0])[0].numerator, 1);
  assert.equal(serviceLevels(scenario, result, [0])[0].denominator, 2);
  assert.equal(verify(scenario, result).valid, true);
});

test('priority queue changes allocation while FIFO keeps arrival order', () => {
  const document = simple([patient('a', 0, 5), patient('b', 1, 3, 20, 1), patient('c', 2, 3, 20, 8)]).export();
  const priority = new Engine(new Scenario(document)).run();
  document.policy.queue = 'fifo';
  const fifo = new Engine(new Scenario(document)).run();
  assert.equal(priority.patients.find(row => row.id === 'c').first_admitted, 5);
  assert.equal(priority.patients.find(row => row.id === 'b').first_admitted, 8);
  assert.equal(fifo.patients.find(row => row.id === 'b').first_admitted, 5);
  assert.equal(fifo.patients.find(row => row.id === 'c').first_admitted, 8);
  assert.equal(priority.counts.discharged, 3);
  assert.equal(fifo.counts.discharged, 3);
});

test('accessible reservation prevents ordinary patients consuming protected beds', () => {
  const document = simple([patient('a', 0, 5, 3, 0, false), patient('b', 1, 3, 3, 0, true)]).export();
  document.policy.reserve_accessible = true;
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  assert.equal(result.patients[0].status, 'abandoned');
  assert.equal(result.patients[1].first_admitted, 1);
  assert.equal(result.patients[1].episodes[0].seat, 'accessible');
  const abandon = result.events.find(row => row.kind === 'abandoned');
  assert.deepEqual(abandon.details.reasons, ['occupied_or_draining']);
  assert.equal(verify(scenario, result).valid, true);
});

test('ordinary bed preference preserves an accessible seat in the same ward', () => {
  const document = simple([patient('a', 0, 5), patient('b', 0, 5, 20, 0, true)], 2).export();
  document.wards[0].accessible = 1;
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  assert.equal(result.patients[0].episodes[0].seat, 'ordinary');
  assert.equal(result.patients[1].episodes[0].seat, 'accessible');
  assert.equal(result.patients[0].first_admitted, 0);
  assert.equal(result.patients[1].first_admitted, 0);
  assert.equal(wardMetrics(scenario, result)[0].accessible_occupied_time, 5);
  assert.equal(verify(scenario, result).care_time, 10);
});

test('initial accessible occupant is assigned before ordinary fallback regardless of list order', () => {
  const document = simple([patient('a', 0, 5), patient('b', 0, 5, 20, 0, true)], 2).export();
  document.wards[0].accessible = 1;
  document.wards[0].initial = ['a', 'b'];
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  assert.equal(result.events[0].details.patient, 'b');
  assert.equal(result.patients[0].episodes[0].seat, 'ordinary');
  assert.equal(result.patients[1].episodes[0].seat, 'accessible');
  assert.equal(result.counts.discharged, 2);
  assert.equal(verify(scenario, result, true).valid, true);
});

test('drain closure retains existing occupancy and measures debt', () => {
  const document = simple([patient('a', 0, 10), patient('b', 3, 3, 10)]).export();
  document.closures = [{ id: 'close', ward: 'one', start: 2, end: 8, beds: 1, accessible: 1, requires: [], mode: 'drain' }];
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  assert.equal(result.patients[0].discharged, 10);
  assert.equal(result.patients[0].moves, 0);
  assert.equal(result.patients[1].first_admitted, 10);
  assert.equal(wardMetrics(scenario, result)[0].capacity_debt_time, 6);
  assert.equal(result.events.filter(row => row.kind === 'displaced').length, 0);
  assert.equal(constructionEffects(scenario, result)[0].coincident_capacity_debt_time, 6);
  assert.equal(verify(scenario, result).valid, true);
});

test('relocation pauses care and invalidates original discharge event', () => {
  const document = simple([patient('a', 0, 10)]).export();
  document.closures = [{ id: 'close', ward: 'one', start: 2, end: 8, beds: 1, accessible: 1, requires: [], mode: 'relocate' }];
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  const state = result.patients[0];
  assert.equal(state.moves, 1);
  assert.equal(state.boarding_time, 6);
  assert.equal(state.discharged, 16);
  assert.equal(state.episodes.length, 2);
  assert.deepEqual(state.episodes.map(row => [row.start, row.end]), [[0, 2], [8, 16]]);
  assert.equal(result.events.filter(row => row.kind === 'discharged').length, 1);
  assert.equal(patientMetrics(scenario, result)[0].care_time, 10);
  assert.equal(queueArea(result).boarding_person_time, 6);
  assert.equal(verify(scenario, result, true).valid, true);
});

test('closure start at discharge instant does not displace completed patient', () => {
  const document = simple([patient('a', 0, 5)]).export();
  document.closures = [{ id: 'close', ward: 'one', start: 5, end: 8, beds: 1, accessible: 1, requires: [], mode: 'relocate' }];
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  assert.equal(result.patients[0].discharged, 5);
  assert.equal(result.patients[0].moves, 0);
  assert.equal(result.events.filter(row => row.kind === 'displaced').length, 0);
  assert.equal(wardMetrics(scenario, result)[0].capacity_debt_time, 0);
  assert.equal(constructionEffects(scenario, result)[0].displaced_people.length, 0);
  assert.equal(verify(scenario, result).valid, true);
});

test('horizon arrival is observed with zero followup and not falsely discharged', () => {
  const scenario = simple([patient('a', 20, 5, 0)]);
  const result = new Engine(scenario).run();
  assert.equal(result.patients[0].first_admitted, 20);
  assert.equal(result.patients[0].status, 'admitted');
  assert.equal(result.patients[0].discharged, null);
  assert.equal(patientMetrics(scenario, result)[0].care_time, 0);
  assert.equal(horizonRemainders(scenario, result).remaining_care_sum, 5);
  assert.equal(serviceLevels(scenario, result, [1])[0].denominator, 0);
  assert.equal(serviceLevels(scenario, result, [1])[0].fraction, null);
  assert.equal(verify(scenario, result).valid, true);
});

test('finite horizon censors ongoing queues and boarding', () => {
  const document = simple([patient('a', 0, 30), patient('b', 1, 5, 20)]).export();
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  const metric = patientMetrics(scenario, result).find(row => row.id === 'b');
  assert.equal(metric.status, 'waiting');
  assert.equal(metric.wait_censored, true);
  assert.equal(metric.initial_wait, 19);
  assert.equal(result.counts.waiting, 1);
  assert.equal(queueArea(result).waiting_person_time, 19);
  assert.equal(horizonRemainders(scenario, result).rows.length, 2);
  assert.equal(verify(scenario, result).valid, true);
});

test('checkpoint continuation exactly matches uninterrupted event stream', () => {
  const scenario = new Scenario(fixture());
  const engine = new Engine(scenario);
  engine.step();
  engine.step();
  engine.step();
  const saved = capture(engine);
  const original = engine.run();
  const continued = resume(scenario, saved);
  assert.deepEqual(continued, original);
  assert.equal(restore(scenario, saved).clock, saved.clock);
  assert.equal(restore(scenario, saved, false).clock, saved.clock);
  assert.equal(restore(scenario, capture(new Engine(scenario))).run().result_digest, original.result_digest);
  assert.equal(verify(scenario, continued, true).valid, true);
});

test('checkpoint detects validly rehashed but impossible state', () => {
  const scenario = new Scenario(fixture());
  const engine = new Engine(scenario);
  engine.step();
  const saved = capture(engine);
  saved.states[0][1].moves = 999;
  const { checkpoint_digest, ...body } = saved;
  saved.checkpoint_digest = digest(body);
  assert.throws(() => restore(scenario, saved), /prefix replay/);
  saved.clock = 99999;
  assert.throws(() => restore(scenario, saved), /checksum/);
  const alternate = scenario.export();
  alternate.policy.queue = 'fifo';
  assert.throws(() => restore(new Scenario(alternate), capture(engine)), /another scenario/);
});

test('zero step and completed checkpoints both resume without duplicate arrivals', () => {
  const scenario = new Scenario(fixture());
  const engine = new Engine(scenario);
  const start = capture(engine);
  const result = engine.run();
  const end = capture(engine);
  assert.deepEqual(resume(scenario, start), result);
  assert.deepEqual(resume(scenario, end), result);
  assert.equal(end.done, true);
  assert.equal(start.done, false);
  assert.equal(result.events.filter(row => row.kind === 'arrived').length, 4);
  assert.equal(result.events.filter(row => row.kind === 'initial').length, 2);
});

test('event hash corruption and altered interval capacity are rejected', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const modified = clone(result);
  modified.events[0].details.patient = 'wrong';
  assert.throws(() => verify(scenario, modified), /checksum/);
  const { result_digest, ...body } = modified;
  modified.result_digest = digest(body);
  assert.throws(() => verify(scenario, modified), /event chain/);
  const other = clone(result);
  other.intervals[0].wards[0].beds += 1;
  const { result_digest: old, ...changed } = other;
  other.result_digest = digest(changed);
  assert.throws(() => verify(scenario, other), /capacity/);
});

test('event replay produces the same occupied bed ledger as interval integration', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const ledger = bedLedger(scenario, result);
  const sum = ledger.reduce((total, row) => total + row.occupied * (row.end - row.start), 0);
  assert.equal(sum, verify(scenario, result).care_time);
  assert.equal(ledger.length, result.intervals.length * 2);
  assert.equal(stateAt(scenario, result, 0).patients.filter(row => row.status === 'admitted').length, 2);
  const trace = patientTrace(scenario, result, 'p1');
  assert.equal(trace.input.accessible, true);
  assert.equal(trace.metrics.care_time, 12);
  assert.ok(trace.events.every(row => row.details.patient === 'p1'));
  assert.throws(() => patientTrace(scenario, result, 'missing'), /unknown/);
});

test('window metrics partition queue and capacity integrals', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const values = windows(scenario, result, 7);
  const queue = queueArea(result);
  assert.equal(values[0].start, 0);
  assert.equal(values.at(-1).end, 48);
  assert.equal(values.reduce((sum, row) => sum + row.waiting_person_time, 0), queue.waiting_person_time);
  assert.equal(values.reduce((sum, row) => sum + row.boarding_person_time, 0), queue.boarding_person_time);
  const occupied = values.reduce((sum, row) => sum + row.occupied_bed_time, 0);
  assert.equal(occupied, verify(scenario, result).care_time);
  assert.throws(() => windows(scenario, result, 0), /integer/);
});

test('diagnostics distinguish blocked demand from causal attribution', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const blocked = blockedDemand(scenario, result);
  const queue = queueArea(result);
  assert.equal(blocked.rows.reduce((sum, row) => sum + row.duration, 0), queue.waiting_person_time + queue.boarding_person_time);
  assert.equal(blocked.reasons_are_coincident_not_additive_causal_attribution, true);
  assert.equal(eventWorkload(result).business_events, result.events.length);
  assert.ok(eventWorkload(result).processed_scheduled_events > 0);
  assert.equal(warmup(scenario, result, 1).patients, 4);
  assert.equal(warmup(scenario, result, 1).excluded_initial_conditions, true);
  assert.equal(invariantDetails(scenario, result).rows.length, 6);
});

test('descriptive statistics make empty and even samples explicit', () => {
  assert.equal(describe([]).mean, null);
  assert.equal(describe([]).median, null);
  assert.equal(describe([2, 4]).median, 3);
  assert.deepEqual(describe([2, 4]).mean, { numerator: 3, denominator: 1 });
  assert.equal(describe([9, 1, 5]).p90, 9);
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  assert.equal(summary(scenario, result).rows[0].arrivals, 6);
  assert.equal(summary(scenario, result).admitted_only_wait_is_selection_biased, true);
  assert.throws(() => summary(scenario, result, 'county'), /unsupported/);
});

test('repeated relocation preserves remaining care rather than restarting stays', () => {
  const document = simple([patient('a', 0, 12)]).export();
  document.closures = [
    { id: 'first', ward: 'one', start: 2, end: 4, beds: 1, accessible: 1, requires: [], mode: 'relocate' },
    { id: 'second', ward: 'one', start: 6, end: 8, beds: 1, accessible: 1, requires: ['first'], mode: 'relocate' }
  ];
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  const state = result.patients[0];
  assert.equal(state.moves, 2);
  assert.equal(state.boarding_time, 4);
  assert.equal(state.discharged, 16);
  assert.equal(state.episodes.length, 3);
  assert.equal(patientMetrics(scenario, result)[0].care_time, 12);
  assert.equal(queueArea(result).boarding_person_time, 4);
  assert.equal(verify(scenario, result, true).valid, true);
});

test('ordinary and accessible capacity debts remain separate under partial closure', () => {
  const document = simple([patient('a', 0, 10), patient('b', 0, 10, 20, 0, true)], 2).export();
  document.wards[0].accessible = 1;
  document.closures = [{ id: 'ordinary', ward: 'one', start: 2, end: 6, beds: 1, accessible: 0, requires: [], mode: 'drain' }];
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  const during = result.intervals.find(row => row.start === 2).wards[0];
  assert.equal(during.ordinary_debt, 1);
  assert.equal(during.accessible_debt, 0);
  assert.equal(during.occupied, 2);
  assert.equal(during.beds, 1);
  assert.equal(result.patients.every(row => row.moves === 0), true);
  assert.equal(wardMetrics(scenario, result)[0].capacity_debt_time, 4);
  assert.equal(verify(scenario, result).valid, true);
});

test('patients never use a ward with another specialty', () => {
  const document = simple([patient('a', 0, 10), patient('b', 1, 5, 3)]).export();
  document.wards.push({ id: 'other', specialty: 'rehab', beds: 10, accessible: 10, initial: [] });
  const scenario = new Scenario(document);
  const result = new Engine(scenario).run();
  assert.equal(result.patients.find(row => row.id === 'b').status, 'abandoned');
  assert.equal(result.patients.every(row => row.episodes.every(episode => episode.ward === 'one')), true);
  const unused = wardMetrics(scenario, result).find(row => row.ward === 'other');
  assert.equal(unused.occupied_bed_time, 0);
  assert.equal(unused.available_bed_time, 200);
  assert.deepEqual(unused.utilization, { numerator: 0, denominator: 1 });
  assert.equal(verify(scenario, result).valid, true);
});

test('an empty patient cohort produces real zero counts and no invented waits', () => {
  const scenario = simple([]);
  const result = new Engine(scenario).run();
  assert.equal(result.patients.length, 0);
  assert.equal(Object.values(result.counts).reduce((a, b) => a + b), 0);
  assert.equal(queueArea(result).waiting_person_time, 0);
  assert.equal(patientMetrics(scenario, result).length, 0);
  assert.equal(summary(scenario, result).rows.length, 0);
  assert.equal(serviceLevels(scenario, result, [1])[0].fraction, null);
  assert.equal(wardMetrics(scenario, result)[0].occupied_bed_time, 0);
  assert.equal(horizonRemainders(scenario, result).remaining_care_sum, 0);
  assert.equal(verify(scenario, result, true).valid, true);
});
