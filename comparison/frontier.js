import { Scenario } from '../ward_calendar/model.js';
import { shiftClosure, validateCalendar } from '../ward_calendar/calendar.js';
import { paired, vector } from './paired.js';
import { Engine } from '../simulation/engine.js';
import { array, integer, digest, Invalid } from '../scenarios/values.js';

export function closureFrontier(scenario, closureId, shifts, cascade = false) {
  array(shifts, 'shifts', 100);
  if (!shifts.length || new Set(shifts).size !== shifts.length) {
    throw new Invalid('unique nonempty shifts required');
  }
  const rows = [];
  for (const delta of shifts) {
    integer(delta, 'shift', -scenario.horizon, scenario.horizon);
    let variant;
    try {
      variant = new Scenario(shiftClosure(scenario, closureId, delta, cascade));
      validateCalendar(variant);
    } catch (error) {
      if (!(error instanceof Invalid)) {
        throw error;
      }
      rows.push({
        shift: delta,
        feasible_calendar: false,
        reason: error.message,
        comparison: null
      });
      continue;
    }
    rows.push({
      shift: delta,
      feasible_calendar: true,
      reason: null,
      comparison: paired(scenario, variant)
    });
  }
  return {
    closure: closureId,
    cascade,
    rows,
    source_digest: scenario.fingerprint
  };
}

export function policyComparison(scenario) {
  const variants = [];
  for (const queue of ['priority', 'fifo']) {
    for (const reserve of [false, true]) {
      const document = scenario.export();
      document.policy.queue = queue;
      document.policy.reserve_accessible = reserve;
      const variant = new Scenario(document);
      variants.push({
        queue,
        reserve_accessible: reserve,
        comparison: paired(scenario, variant)
      });
    }
  }
  return {
    rows: variants,
    demand_held_fixed: true,
    source_digest: scenario.fingerprint
  };
}

export function noConstruction(scenario) {
  const document = scenario.export();
  document.closures = [];
  return new Scenario(document);
}

export function closureAttribution(scenario) {
  const baseline = new Engine(noConstruction(scenario)).run();
  const total = new Engine(scenario).run();
  const baseVector = vector(noConstruction(scenario), baseline);
  const totalVector = vector(scenario, total);
  const rows = [];
  for (const closure of scenario.closures.values()) {
    const document = scenario.export();
    const dependent = new Set([closure.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of document.closures) {
        if (!dependent.has(row.id) && row.requires.some(key => dependent.has(key))) {
          dependent.add(row.id);
          changed = true;
        }
      }
    }
    document.closures = document.closures.filter(row => !dependent.has(row.id));
    const variant = new Scenario(document);
    const result = new Engine(variant).run();
    const metrics = vector(variant, result);
    rows.push({
      closure: closure.id,
      removed_with_dependents: [...dependent].sort(),
      marginal_withdrawal_effect: Object.fromEntries(Object.keys(metrics).map(key => [key, totalVector[key] - metrics[key]]))
    });
  }
  return {
    no_construction: baseVector,
    all_construction: totalVector,
    rows,
    effects_are_not_additive: true,
    method: 'leave_one_closure_and_dependency_descendants_out'
  };
}
