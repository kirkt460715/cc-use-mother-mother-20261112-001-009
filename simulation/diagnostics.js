import { integer, ratio, Invalid } from '../scenarios/values.js';
import { patientMetrics } from '../patient_flow/metrics.js';
import { stateAt } from './explorer.js';
import { closureCapacity } from '../ward_calendar/model.js';
import { queueReasons } from '../patient_flow/queue.js';

export function blockedDemand(scenario, result) {
  const rows = [];
  for (const interval of result.intervals) {
    const snapshot = stateAt(scenario, result, interval.start);
    const states = new Map(snapshot.patients.map(row => [row.id, row]));
    const capacities = new Map([...scenario.wards.keys()].map(key => [key, closureCapacity(scenario, key, interval.start)]));
    for (const state of states.values()) {
      if (state.status !== 'waiting' && state.status !== 'boarding') {
        continue;
      }
      const patient = scenario.patients.get(state.id);
      rows.push({
        patient: state.id,
        start: interval.start,
        end: interval.end,
        duration: interval.duration,
        state: state.status,
        specialty: patient.specialty,
        accessible: patient.accessible,
        reasons: queueReasons(scenario, capacities, states, patient)
      });
    }
  }
  const grouped = new Map();
  for (const row of rows) {
    const key = row.reasons.join('|');
    grouped.set(key, (grouped.get(key) ?? 0) + row.duration);
  }
  return {
    rows,
    reason_person_time: [...grouped].map(([reason, time]) => ({
      reason,
      person_time: time
    })).sort((a, b) => a.reason.localeCompare(b.reason)),
    reasons_are_coincident_not_additive_causal_attribution: true
  };
}

export function eventWorkload(result) {
  const kinds = new Map();
  const byTime = new Map();
  for (const event of result.events) {
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    byTime.set(event.time, (byTime.get(event.time) ?? 0) + 1);
  }
  const busiest = [...byTime].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10);
  return {
    processed_scheduled_events: result.processed_events,
    business_events: result.events.length,
    business_events_by_kind: Object.fromEntries([...kinds].sort()),
    busiest_times: busiest.map(([time, count]) => ({ time, events: count })),
    log_entries_are_not_equal_to_heap_pops: true
  };
}

export function horizonRemainders(scenario, result) {
  const metrics = new Map(patientMetrics(scenario, result).map(row => [row.id, row]));
  const output = [];
  for (const state of result.patients) {
    if (!['admitted', 'boarding', 'waiting'].includes(state.status)) {
      continue;
    }
    const row = metrics.get(state.id);
    output.push({
      patient: state.id,
      status: state.status,
      remaining_care: row.requested_care - row.care_time,
      observed_initial_wait: row.initial_wait,
      observed_boarding: row.boarding_time,
      ward: state.ward,
      completion_time_unknown: true
    });
  }
  return {
    rows: output,
    remaining_care_sum: output.reduce((sum, row) => sum + row.remaining_care, 0),
    note: 'do_not_treat_unfinished_patients_as_zero_length_stays'
  };
}

export function warmup(scenario, result, cutoff) {
  integer(cutoff, 'cutoff', 0, result.horizon - 1);
  const rows = patientMetrics(scenario, result).filter(row => row.arrival >= cutoff);
  const admitted = rows.filter(row => row.admitted).length;
  return {
    cutoff,
    patients: rows.length,
    admitted,
    completed: rows.filter(row => row.completed).length,
    abandoned: rows.filter(row => row.status === 'abandoned').length,
    admission_fraction: ratio(admitted, rows.length),
    excluded_initial_conditions: true,
    caveat: 'excluding_early_arrivals_does_not_remove_their_capacity_effects'
  };
}

export function invariantDetails(scenario, result) {
  const states = result.patients;
  const rows = [];
  for (const state of states) {
    const patient = scenario.patients.get(state.id);
    const care = state.episodes.reduce((sum, episode) => sum + (episode.end ?? result.horizon) - episode.start, 0);
    const events = result.events.filter(event => event.details.patient === state.id);
    const admissions = events.filter(event => ['initial', 'admitted', 'relocated'].includes(event.kind));
    const displacements = events.filter(event => event.kind === 'displaced');
    const discharges = events.filter(event => event.kind === 'discharged');
    const correct = care <= patient.stay && admissions.length === state.episodes.length && displacements.length === state.moves;
    rows.push({
      patient: state.id,
      care_time: care,
      planned_care: patient.stay,
      admission_events: admissions.length,
      displacement_events: displacements.length,
      discharge_events: discharges.length,
      episodes: state.episodes.length,
      valid: correct && discharges.length <= 1
    });
  }
  if (rows.some(row => !row.valid)) {
    throw new Invalid('patient event episode invariants failed');
  }
  return {
    valid: true,
    rows
  };
}
