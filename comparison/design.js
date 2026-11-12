import { Scenario } from '../ward_calendar/model.js';
import { validateCalendar } from '../ward_calendar/calendar.js';
import { Engine } from '../simulation/engine.js';
import { verify } from '../simulation/audit.js';
import { vector } from './paired.js';
import { array, integer, fields, digest, Invalid } from '../scenarios/values.js';

export function cartesianDimensions(dimensions, maximum = 100) {
  array(dimensions, 'dimensions', 5);
  integer(maximum, 'maximum combinations', 1, 1000);
  const names = new Set();
  let combinations = [{}];
  for (const dimension of dimensions) {
    fields(dimension, ['closure', 'shifts']);
    if (names.has(dimension.closure)) {
      throw new Invalid('duplicate design dimension');
    }
    names.add(dimension.closure);
    array(dimension.shifts, 'shifts', 20);
    if (!dimension.shifts.length || new Set(dimension.shifts).size !== dimension.shifts.length) {
      throw new Invalid('nonempty unique shift grid required');
    }
    const expanded = [];
    for (const combination of combinations) {
      for (const shift of dimension.shifts) {
        integer(shift, 'shift', -100000, 100000);
        expanded.push({
          ...combination,
          [dimension.closure]: shift
        });
        if (expanded.length > maximum) {
          throw new Invalid('design grid exceeds maximum combinations');
        }
      }
    }
    combinations = expanded;
  }
  return combinations;
}

export function dominates(left, right, objectives) {
  let strictly = false;
  for (const objective of objectives) {
    const sign = objective.direction === 'min' ? 1 : -1;
    const difference = (left[objective.metric] - right[objective.metric]) * sign;
    if (difference > 0) {
      return false;
    }
    strictly ||= difference < 0;
  }
  return strictly;
}

export function pareto(rows, objectives) {
  array(objectives, 'objectives', 8);
  if (!objectives.length) {
    throw new Invalid('at least one objective required');
  }
  const metrics = new Set(['admitted', 'completed', 'abandoned', 'waiting_time', 'boarding_time', 'care_time', 'capacity_debt_time', 'displaced']);
  for (const objective of objectives) {
    fields(objective, ['metric', 'direction']);
    if (!metrics.has(objective.metric) || !['min', 'max'].includes(objective.direction)) {
      throw new Invalid('invalid Pareto objective');
    }
  }
  return rows.map(row => {
    const dominators = rows.filter(other => other.id !== row.id && dominates(other.metrics, row.metrics, objectives));
    return {
      ...row,
      non_dominated: dominators.length === 0,
      dominated_by: dominators.map(other => other.id).sort()
    };
  });
}

export function evaluateDesign(scenario, definition) {
  fields(definition, ['dimensions', 'objectives', 'maximum_combinations', 'maximum_capacity_debt']);
  integer(definition.maximum_capacity_debt, 'maximum debt', 0, 1000000000);
  const combinations = cartesianDimensions(definition.dimensions, definition.maximum_combinations);
  const valid = [];
  const rejected = [];
  for (let index = 0; index < combinations.length; index += 1) {
    const shifts = combinations[index];
    const key = `candidate-${index}`;
    const document = scenario.export();
    for (const closureId of Object.keys(shifts)) {
      const closure = document.closures.find(row => row.id === closureId);
      if (!closure) {
        throw new Invalid('design references unknown closure');
      }
      closure.start += shifts[closureId];
      closure.end += shifts[closureId];
    }
    let candidate;
    try {
      candidate = new Scenario(document);
      validateCalendar(candidate);
    } catch (error) {
      if (!(error instanceof Invalid)) {
        throw error;
      }
      rejected.push({
        id: key,
        shifts,
        reason: error.message,
        stage: 'calendar_validation'
      });
      continue;
    }
    const result = new Engine(candidate).run();
    verify(candidate, result);
    const metrics = vector(candidate, result);
    if (metrics.capacity_debt_time > definition.maximum_capacity_debt) {
      rejected.push({
        id: key,
        shifts,
        reason: 'capacity_debt_limit',
        stage: 'operating_constraint',
        metrics
      });
      continue;
    }
    valid.push({
      id: key,
      shifts,
      metrics,
      input_digest: candidate.fingerprint,
      result_digest: result.result_digest
    });
  }
  const body = {
    source_digest: scenario.fingerprint,
    definition,
    candidates: pareto(valid, definition.objectives),
    rejected,
    exhaustive_within_declared_grid: true,
    global_optimum_not_claimed: true
  };
  return {
    ...body,
    design_digest: digest(body)
  };
}
