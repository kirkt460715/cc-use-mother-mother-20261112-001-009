import { ratio, integer, Invalid } from '../scenarios/values.js';

export function describe(values) {
  if (!values.length) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      median: null,
      p90: null
    };
  }
  const ordered = [...values].sort((a, b) => a - b);
  const size = ordered.length;
  const median = size % 2 ? ordered[Math.floor(size / 2)] : (ordered[size / 2 - 1] + ordered[size / 2]) / 2;
  return {
    count: size,
    min: ordered[0],
    max: ordered.at(-1),
    mean: ratio(ordered.reduce((sum, value) => sum + value, 0), size),
    median,
    p90: ordered[Math.ceil(size * 0.9) - 1]
  };
}

export function patientMetrics(scenario, result) {
  const rows = [];
  for (const state of result.patients) {
    const patient = scenario.patients.get(state.id);
    const care = state.episodes.reduce((sum, episode) => sum + ((episode.end ?? result.horizon) - episode.start), 0);
    const boarding = state.boarding_time + (state.status === 'boarding' ? result.horizon - state.boarding_started : 0);
    const initialWait = (state.first_admitted ?? state.abandoned ?? result.horizon) - patient.arrival;
    rows.push({
      id: patient.id,
      specialty: patient.specialty,
      accessible: patient.accessible,
      priority: patient.priority,
      arrival: patient.arrival,
      status: state.status,
      admitted: state.first_admitted !== null,
      completed: state.status === 'discharged',
      initial_wait: initialWait,
      wait_censored: state.status === 'waiting',
      wait_ended_by_abandonment: state.status === 'abandoned',
      boarding_time: boarding,
      care_time: care,
      requested_care: patient.stay,
      moves: state.moves,
      end: state.discharged ?? state.abandoned ?? result.horizon
    });
  }
  return rows;
}

export function summary(scenario, result, dimension = 'specialty') {
  if (!['specialty', 'accessible', 'priority'].includes(dimension)) {
    throw new Invalid('unsupported metric dimension');
  }
  const buckets = new Map();
  for (const row of patientMetrics(scenario, result)) {
    const key = row[dimension];
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(row);
  }
  const output = [];
  for (const [key, rows] of buckets) {
    const admitted = rows.filter(row => row.admitted);
    output.push({
      group: key,
      arrivals: rows.length,
      admitted: admitted.length,
      discharged: rows.filter(row => row.completed).length,
      abandoned: rows.filter(row => row.status === 'abandoned').length,
      waiting_at_horizon: rows.filter(row => row.status === 'waiting').length,
      boarding_at_horizon: rows.filter(row => row.status === 'boarding').length,
      admitted_wait: describe(admitted.map(row => row.initial_wait)),
      boarding: describe(rows.map(row => row.boarding_time)),
      admission_fraction: ratio(admitted.length, rows.length),
      completed_fraction: ratio(rows.filter(row => row.completed).length, rows.length)
    });
  }
  output.sort((a, b) => String(a.group).localeCompare(String(b.group)));
  return {
    dimension,
    rows: output,
    admitted_only_wait_is_selection_biased: true
  };
}

export function wardMetrics(scenario, result) {
  const output = [];
  for (const ward of scenario.wards.values()) {
    let occupied = 0;
    let available = 0;
    let accessible = 0;
    let debt = 0;
    let maximum = 0;
    for (const interval of result.intervals) {
      const row = interval.wards.find(item => item.ward === ward.id);
      occupied += row.occupied * interval.duration;
      available += row.beds * interval.duration;
      accessible += row.occupied_accessible * interval.duration;
      debt += (row.ordinary_debt + row.accessible_debt) * interval.duration;
      maximum = Math.max(maximum, row.occupied);
    }
    output.push({
      ward: ward.id,
      specialty: ward.specialty,
      occupied_bed_time: occupied,
      available_bed_time: available,
      accessible_occupied_time: accessible,
      capacity_debt_time: debt,
      maximum_occupied: maximum,
      utilization: ratio(occupied, available),
      utilization_can_exceed_one_under_drain: true
    });
  }
  return output;
}

export function serviceLevels(scenario, result, thresholds = [0, 6, 24]) {
  if (!Array.isArray(thresholds) || thresholds.length > 100) {
    throw new Invalid('bounded thresholds required');
  }
  const rows = patientMetrics(scenario, result);
  return thresholds.map(threshold => {
    integer(threshold, 'threshold', 0, scenario.horizon);
    const mature = rows.filter(row => row.arrival + threshold <= result.horizon);
    const numerator = mature.filter(row => row.admitted && row.initial_wait <= threshold).length;
    return {
      threshold,
      denominator: mature.length,
      numerator,
      fraction: ratio(numerator, mature.length),
      denominator_definition: 'all_arrivals_with_full_threshold_followup_including_abandoned'
    };
  });
}

export function queueArea(result) {
  let waiting = 0;
  let boarding = 0;
  let maxWaiting = 0;
  let maxBoarding = 0;
  for (const interval of result.intervals) {
    waiting += interval.waiting * interval.duration;
    boarding += interval.boarding * interval.duration;
    maxWaiting = Math.max(maxWaiting, interval.waiting);
    maxBoarding = Math.max(maxBoarding, interval.boarding);
  }
  return {
    waiting_person_time: waiting,
    boarding_person_time: boarding,
    maximum_waiting: maxWaiting,
    maximum_boarding: maxBoarding,
    mean_waiting_queue: ratio(waiting, result.horizon),
    mean_boarding_queue: ratio(boarding, result.horizon)
  };
}
