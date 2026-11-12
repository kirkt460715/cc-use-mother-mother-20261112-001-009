import { patientMetrics, describe } from './metrics.js';
import { ratio, integer, Invalid } from '../scenarios/values.js';

export function matchedAccessibility(scenario, result) {
  const groups = new Map();
  for (const row of patientMetrics(scenario, result)) {
    const key = `${row.specialty}:${row.priority}`;
    if (!groups.has(key)) {
      groups.set(key, { ordinary: [], accessible: [] });
    }
    groups.get(key)[row.accessible ? 'accessible' : 'ordinary'].push(row);
  }
  const output = [];
  for (const [stratum, values] of groups) {
    const a = values.accessible;
    const b = values.ordinary;
    const first = a.filter(row => row.admitted).length;
    const second = b.filter(row => row.admitted).length;
    output.push({
      stratum,
      accessible: {
        people: a.length,
        admitted: first,
        fraction: ratio(first, a.length),
        observed_wait: describe(a.map(row => row.initial_wait))
      },
      ordinary: {
        people: b.length,
        admitted: second,
        fraction: ratio(second, b.length),
        observed_wait: describe(b.map(row => row.initial_wait))
      },
      comparable: a.length > 0 && b.length > 0,
      admission_fraction_difference: a.length && b.length ? ratio(first * b.length - second * a.length, a.length * b.length) : null
    });
  }
  output.sort((a, b) => a.stratum.localeCompare(b.stratum));
  return {
    rows: output,
    limitation: 'stratifies_specialty_and_priority_only_not_all_case_mix'
  };
}

export function deprivation(scenario, result, threshold) {
  integer(threshold, 'threshold', 0, result.horizon);
  const rows = patientMetrics(scenario, result).filter(row => row.initial_wait > threshold || row.boarding_time > threshold);
  return {
    threshold,
    rows: rows.map(row => ({
      patient: row.id,
      initial_wait: row.initial_wait,
      boarding_time: row.boarding_time,
      status: row.status,
      accessible: row.accessible,
      priority: row.priority,
      censored: row.wait_censored
    })),
    action: 'simulation_capacity_review_not_real_patient_triage'
  };
}

export function arrivalWindows(scenario, result, width = 24) {
  integer(width, 'width', 1, result.horizon);
  const patients = patientMetrics(scenario, result);
  const output = [];
  for (let start = 0; start < result.horizon; start += width) {
    const end = Math.min(result.horizon, start + width);
    const rows = patients.filter(row => row.arrival >= start && row.arrival < end);
    const admitted = rows.filter(row => row.admitted);
    output.push({
      start,
      end,
      arrivals: rows.length,
      admitted: admitted.length,
      abandoned: rows.filter(row => row.status === 'abandoned').length,
      wait: describe(admitted.map(row => row.initial_wait)),
      followup_minimum: result.horizon - end,
      admission_fraction: ratio(admitted.length, rows.length)
    });
  }
  return {
    width,
    rows: output,
    warning: 'later_arrival_cohorts_have_shorter_followup'
  };
}

export function destinationChanges(leftResult, rightResult) {
  const right = new Map(rightResult.patients.map(row => [row.id, row]));
  const output = [];
  for (const first of leftResult.patients) {
    const last = right.get(first.id);
    if (!last) {
      throw new Invalid('paired cohort mismatch');
    }
    const left = first.episodes.map(row => row.ward);
    const rightPath = last.episodes.map(row => row.ward);
    if (JSON.stringify(left) !== JSON.stringify(rightPath)) {
      output.push({
        patient: first.id,
        left_wards: left,
        right_wards: rightPath,
        left_moves: first.moves,
        right_moves: last.moves
      });
    }
  }
  return {
    rows: output,
    changed_paths: output.length
  };
}
