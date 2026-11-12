import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Scenario, closureCapacity } from '../ward_calendar/model.js';
import { validateCalendar, segments, capacitySummary, dependencyOrder, shiftClosure } from '../ward_calendar/calendar.js';
import { EventHeap } from '../simulation/heap.js';
import { Engine } from '../simulation/engine.js';
import { paired, meanInterval, replicate, vector } from '../comparison/paired.js';
import { uniform, discrete, arrivals, seeds } from '../comparison/random.js';
import { closureFrontier, policyComparison, closureAttribution, noConstruction } from '../comparison/frontier.js';
import { cartesianDimensions, dominates, pareto, evaluateDesign } from '../comparison/design.js';
import { matchedAccessibility, deprivation, arrivalWindows, destinationChanges } from '../patient_flow/equity.js';
import { canonical, digest, clone, integer, fields, id, ratio } from '../scenarios/values.js';

function fixture() {
  return JSON.parse(readFileSync('fixtures/wards.json', 'utf8'));
}

function profile() {
  return {
    count: 12,
    specialty: 'care',
    accessible_pct: 30,
    stay: [{ value: 5, weight: 1 }, { value: 12, weight: 2 }],
    patience: 10,
    priority: [{ value: 1, weight: 1 }, { value: 3, weight: 1 }]
  };
}

test('canonical values have stable identity and reject unsupported data', () => {
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonical(Infinity), /nonfinite/);
  assert.throws(() => canonical(undefined), /unsupported/);
  assert.throws(() => integer(true, 'number'), /integer/);
  assert.throws(() => id('../ward'), /identifier/);
  assert.throws(() => fields({ a: 1, extra: 2 }, ['a']), /mismatch/);
  assert.deepEqual(ratio(6, 8), { numerator: 3, denominator: 4 });
  assert.equal(ratio(0, 0), null);
  assert.deepEqual(ratio(0, 3), { numerator: 0, denominator: 1 });
});

test('scenario owns its input and normalizes entity array order', () => {
  const input = fixture();
  const scenario = new Scenario(input);
  const signature = scenario.fingerprint;
  input.patients[0].stay = 999;
  assert.equal(scenario.patients.get('p1').stay, 12);
  const exported = scenario.export();
  exported.wards.reverse();
  exported.patients.reverse();
  assert.equal(new Scenario(exported).fingerprint, signature);
  exported.patients[0].stay += 1;
  assert.notEqual(new Scenario(exported).fingerprint, signature);
  assert.equal(scenario.fingerprint, signature);
});

test('scenario rejects missing references and ambiguous initial occupants', () => {
  let document = fixture();
  document.wards[0].initial.push('missing');
  assert.throws(() => new Scenario(document), /initial/);
  document = fixture();
  document.wards[1].initial.push('p1');
  assert.throws(() => new Scenario(document), /assigned twice/);
  document = fixture();
  document.patients[0].arrival = 1;
  assert.throws(() => new Scenario(document), /time zero/);
  document = fixture();
  document.patients[0].specialty = 'missing';
  assert.throws(() => new Scenario(document), /specialty/);
  document = fixture();
  document.closures[0].ward = 'missing';
  assert.throws(() => new Scenario(document), /ward missing/);
});

test('strict model rejects invalid numeric and boolean domains', () => {
  for (const [key, value] of [['stay', 0], ['arrival', -1], ['priority', 11], ['patience', 49], ['accessible', 1]]) {
    const document = fixture();
    document.patients[0][key] = value;
    assert.throws(() => new Scenario(document));
  }
  const document = fixture();
  document.policy.max_events = 99;
  assert.throws(() => new Scenario(document), /max_events/);
  document.policy.max_events = 100;
  document.policy.queue = 'random';
  assert.throws(() => new Scenario(document), /queue/);
  document.policy.queue = 'fifo';
  document.extra = 1;
  assert.throws(() => new Scenario(document), /fields/);
});

test('calendar uses half open closures and exact bed time', () => {
  const scenario = new Scenario(fixture());
  assert.equal(closureCapacity(scenario, 'north', 3).beds, 2);
  assert.equal(closureCapacity(scenario, 'north', 4).beds, 0);
  assert.equal(closureCapacity(scenario, 'north', 15).beds, 0);
  assert.equal(closureCapacity(scenario, 'north', 16).beds, 2);
  assert.deepEqual(validateCalendar(scenario).boundaries, [0, 4, 16, 48]);
  assert.equal(segments(scenario).length, 6);
  const north = capacitySummary(scenario).find(row => row.ward === 'north');
  assert.equal(north.closed_bed_time, 24);
  assert.equal(north.available_bed_time, 72);
  assert.equal(north.minimum_beds, 0);
});

test('calendar rejects overlapping capacity removal before running events', () => {
  const document = fixture();
  document.closures.push({ ...document.closures[0], id: 'overlap', start: 8, end: 12 });
  const scenario = new Scenario(document);
  assert.throws(() => validateCalendar(scenario), /invalid capacity/);
  assert.throws(() => new Engine(scenario), /invalid capacity/);
  document.closures[1].start = 16;
  document.closures[1].end = 20;
  const valid = new Scenario(document);
  assert.equal(validateCalendar(valid).valid, true);
  assert.equal(closureCapacity(valid, 'north', 16).beds, 0);
  assert.equal(closureCapacity(valid, 'north', 20).beds, 2);
});

test('construction dependencies must finish before their successor begins', () => {
  const document = fixture();
  document.closures.push({ ...document.closures[0], id: 'second', start: 18, end: 24, requires: ['upgrade'] });
  const scenario = new Scenario(document);
  assert.deepEqual(dependencyOrder(scenario), ['upgrade', 'second']);
  const shifted = new Scenario(shiftClosure(scenario, 'upgrade', 3, true));
  assert.equal(shifted.closures.get('upgrade').start, 7);
  assert.equal(shifted.closures.get('second').start, 21);
  assert.throws(() => new Scenario(shiftClosure(scenario, 'upgrade', 3, false)), /dependency/);
  document.closures[0].requires = ['second'];
  assert.throws(() => new Scenario(document), /dependency/);
  assert.equal(scenario.closures.get('upgrade').start, 4);
});

test('heap orders discharge capacity arrival timeout deterministically', () => {
  const heap = new EventHeap();
  heap.push(5, 'timeout', { id: 1 });
  heap.push(5, 'arrival', { id: 2 });
  heap.push(5, 'capacity', { id: 3 });
  heap.push(5, 'discharge', { id: 4 });
  heap.push(3, 'arrival', { id: 5 });
  assert.equal(heap.pop().time, 3);
  assert.deepEqual(heap.takeTime(5).map(row => row.kind), ['discharge', 'capacity', 'arrival', 'timeout']);
  assert.equal(heap.peek(), null);
  assert.equal(heap.pop(), null);
  assert.throws(() => heap.push(1, 'unknown'), /unknown/);
  assert.throws(() => heap.push(-1, 'arrival'), /integer/);
});

test('heap preserves insertion sequence for identical time and kind', () => {
  const heap = new EventHeap();
  for (let index = 0; index < 30; index += 1) {
    heap.push(index % 3, 'arrival', { index });
  }
  const saved = heap.export();
  const restored = EventHeap.restore(saved);
  const original = [];
  const repeated = [];
  while (heap.peek()) {
    original.push(heap.pop());
    repeated.push(restored.pop());
  }
  assert.deepEqual(original, repeated);
  assert.deepEqual(original.filter(row => row.time === 0).map(row => row.payload.index), [0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
  saved.items[0].time = 100;
  assert.throws(() => EventHeap.restore(saved), /order/);
});

test('keyed random streams reproduce values independently of call ordering', () => {
  const first = uniform(1, 'person-1', 'stay');
  uniform(1, 'person-2', 'arrival');
  assert.equal(uniform(1, 'person-1', 'stay'), first);
  assert.ok(first > 0 && first < 1);
  assert.notEqual(uniform(1, 'person-1', 'arrival'), first);
  assert.notEqual(uniform(2, 'person-1', 'stay'), first);
  assert.equal(discrete(1, 'person', [{ value: 7, weight: 10 }]), 7);
  assert.throws(() => discrete(1, 'person', []), /nonempty/);
  assert.deepEqual(seeds(0xffffffff, 3), [0xffffffff, 0, 1]);
  assert.throws(() => seeds(1, 101), /integer/);
});

test('generated demand stays inside declared local profile', () => {
  const first = arrivals(profile(), 48, 42);
  const second = arrivals(profile(), 48, 42);
  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  assert.equal(new Set(first.map(row => row.id)).size, 12);
  assert.ok(first.every(row => row.arrival >= 0 && row.arrival < 48));
  assert.ok(first.every(row => [5, 12].includes(row.stay)));
  assert.ok(first.every(row => [1, 3].includes(row.priority)));
  assert.ok(first.every(row => row.specialty === 'care'));
  assert.notDeepEqual(first, arrivals(profile(), 48, 43));
  assert.equal(arrivals({ ...profile(), count: 0 }, 48, 42).length, 0);
});

test('paired scenarios require identical demand and horizon', () => {
  const scenario = new Scenario(fixture());
  const self = paired(scenario, scenario);
  assert.ok(Object.values(self.delta).every(value => value === 0));
  assert.equal(self.direction, 'right_minus_left');
  assert.equal(self.patients.length, 6);
  const changed = scenario.export();
  changed.patients[0].stay += 1;
  assert.throws(() => paired(scenario, new Scenario(changed)), /identical patient/);
  changed.patients = scenario.export().patients;
  changed.horizon = 49;
  assert.throws(() => paired(scenario, new Scenario(changed)), /horizon/);
  assert.equal(scenario.fingerprint, self.left_input);
});

test('replications use common draws and report paired uncertainty', () => {
  const document = fixture();
  document.wards.forEach(ward => { ward.initial = []; });
  const scenario = new Scenario(document);
  const result = replicate(scenario, scenario, profile(), 5, 3);
  assert.equal(result.replications, 3);
  assert.deepEqual(result.runs.map(row => row.seed), [5, 6, 7]);
  assert.ok(Object.values(result.estimates).every(row => row.mean === 0));
  assert.deepEqual(result.estimates.admitted.interval_95, [0, 0]);
  assert.equal(result.source, 'synthetic_demand');
  assert.equal(result.experiment_digest, replicate(scenario, scenario, profile(), 5, 3).experiment_digest);
  assert.equal(meanInterval([]).mean, null);
  assert.equal(meanInterval([2]).interval_95, null);
  assert.equal(meanInterval([1, 2, 3]).variance, 1);
});

test('closure frontier records invalid calendars without claiming feasible outcomes', () => {
  const scenario = new Scenario(fixture());
  const frontier = closureFrontier(scenario, 'upgrade', [-10, 0, 1]);
  assert.equal(frontier.rows.length, 3);
  assert.equal(frontier.rows[0].feasible_calendar, false);
  assert.equal(frontier.rows[0].comparison, null);
  assert.ok(frontier.rows[0].reason.length > 0);
  assert.equal(frontier.rows[1].feasible_calendar, true);
  assert.ok(Object.values(frontier.rows[1].comparison.delta).every(value => value === 0));
  assert.equal(frontier.rows[2].feasible_calendar, true);
  assert.throws(() => closureFrontier(scenario, 'upgrade', [0, 0]), /unique/);
  assert.equal(scenario.closures.get('upgrade').start, 4);
});

test('policy comparison and attribution retain the same demand snapshot', () => {
  const scenario = new Scenario(fixture());
  const policies = policyComparison(scenario);
  assert.equal(policies.rows.length, 4);
  assert.equal(policies.demand_held_fixed, true);
  const attribution = closureAttribution(scenario);
  assert.equal(attribution.rows.length, 1);
  assert.deepEqual(attribution.rows[0].removed_with_dependents, ['upgrade']);
  assert.equal(attribution.effects_are_not_additive, true);
  assert.equal(noConstruction(scenario).closures.size, 0);
  assert.equal(scenario.closures.size, 1);
  assert.equal(attribution.all_construction.admitted, vector(scenario, new Engine(scenario).run()).admitted);
});

test('design grids enforce cardinality and Pareto direction correctly', () => {
  const dimensions = [{ closure: 'upgrade', shifts: [0, 1, 2] }];
  assert.equal(cartesianDimensions(dimensions, 3).length, 3);
  assert.throws(() => cartesianDimensions(dimensions, 2), /maximum/);
  assert.throws(() => cartesianDimensions(dimensions.concat(dimensions)), /duplicate/);
  const objectives = [{ metric: 'waiting_time', direction: 'min' }, { metric: 'admitted', direction: 'max' }];
  assert.equal(dominates({ waiting_time: 1, admitted: 3 }, { waiting_time: 2, admitted: 2 }, objectives), true);
  const ranked = pareto([{ id: 'a', metrics: { waiting_time: 1, admitted: 3 } }, { id: 'b', metrics: { waiting_time: 2, admitted: 2 } }], objectives);
  assert.equal(ranked[0].non_dominated, true);
  assert.deepEqual(ranked[1].dominated_by, ['a']);
  assert.throws(() => pareto([], []), /at least/);
});

test('exhaustive design reports rejected and accepted candidates with source bindings', () => {
  const scenario = new Scenario(fixture());
  const definition = {
    dimensions: [{ closure: 'upgrade', shifts: [-10, 0, 1] }],
    objectives: [{ metric: 'waiting_time', direction: 'min' }],
    maximum_combinations: 10,
    maximum_capacity_debt: 10000
  };
  const result = evaluateDesign(scenario, definition);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].stage, 'calendar_validation');
  assert.equal(result.exhaustive_within_declared_grid, true);
  assert.equal(result.global_optimum_not_claimed, true);
  assert.equal(result.source_digest, scenario.fingerprint);
  assert.ok(result.candidates.some(row => row.non_dominated));
});

test('equity and arrival windows expose denominator and followup limits', () => {
  const scenario = new Scenario(fixture());
  const result = new Engine(scenario).run();
  const equity = matchedAccessibility(scenario, result);
  assert.ok(equity.rows.length > 0);
  assert.ok(equity.limitation.includes('case_mix'));
  const windows = arrivalWindows(scenario, result, 10);
  assert.equal(windows.rows.reduce((sum, row) => sum + row.arrivals, 0), 5);
  assert.ok(windows.warning.includes('shorter_followup'));
  assert.equal(deprivation(scenario, result, 0).action, 'simulation_capacity_review_not_real_patient_triage');
  assert.equal(destinationChanges(result, result).changed_paths, 0);
  assert.throws(() => arrivalWindows(scenario, result, 0), /integer/);
  assert.throws(() => deprivation(scenario, result, -1), /integer/);
});

test('invalid design objectives fail before any optimization claim', () => {
  const scenario = new Scenario(fixture());
  const definition = {
    dimensions: [{ closure: 'upgrade', shifts: [0] }],
    objectives: [{ metric: 'unknown', direction: 'min' }],
    maximum_combinations: 5,
    maximum_capacity_debt: 1000
  };
  assert.throws(() => evaluateDesign(scenario, definition), /invalid Pareto/);
  definition.objectives = [{ metric: 'admitted', direction: 'max' }];
  definition.dimensions[0].closure = 'missing';
  assert.throws(() => evaluateDesign(scenario, definition), /unknown closure/);
  assert.equal(scenario.closures.size, 1);
  assert.equal(scenario.patients.size, 6);
  assert.equal(scenario.document.policy.queue, 'priority');
});

test('accessible capacity cannot exceed remaining total capacity', () => {
  const document = fixture();
  document.closures[0].beds = 2;
  document.closures[0].accessible = 0;
  const scenario = new Scenario(document);
  assert.throws(() => validateCalendar(scenario), /invalid capacity/);
  assert.throws(() => new Engine(scenario), /invalid capacity/);
  document.closures[0].accessible = 1;
  const corrected = new Scenario(document);
  assert.equal(validateCalendar(corrected).valid, true);
  assert.equal(closureCapacity(corrected, 'north', 4).accessible, 0);
  assert.equal(closureCapacity(corrected, 'north', 16).accessible, 1);
  assert.equal(corrected.patients.size, 6);
});

test('replication refuses changing initial patients behind common random demand', () => {
  const scenario = new Scenario(fixture());
  assert.throws(() => replicate(scenario, scenario, profile(), 1, 2), /empty initial/);
  const empty = scenario.export();
  empty.wards.forEach(ward => { ward.initial = []; });
  const template = new Scenario(empty);
  const result = replicate(template, template, profile(), 0xffffffff, 2);
  assert.deepEqual(result.runs.map(row => row.seed), [0xffffffff, 0]);
  assert.equal(result.runs[0].result.patients.length, 12);
  assert.equal(result.runs[1].result.patients.length, 12);
  assert.equal(result.estimates.admitted.mean, 0);
  assert.equal(result.estimates.waiting_time.mean, 0);
  assert.equal(result.replications, 2);
  assert.equal(scenario.patients.size, 6);
  assert.equal(template.wards.get('north').initial.length, 0);
  assert.equal(result.source, 'synthetic_demand');
});
