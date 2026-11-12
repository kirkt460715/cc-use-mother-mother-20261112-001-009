import { Engine } from './engine.js';
import { clone, digest, Invalid } from '../scenarios/values.js';
import { patientMetrics, wardMetrics, queueArea } from '../patient_flow/metrics.js';
import { closureCapacity } from '../ward_calendar/model.js';

export function verify(scenario, result, replay = false) {
  const { result_digest, ...body } = result;
  if (result.version !== 1 || digest(body) !== result_digest) {
    throw new Invalid('simulation checksum mismatch');
  }
  if (result.input_digest !== scenario.fingerprint || result.horizon !== scenario.horizon) {
    throw new Invalid('simulation source binding mismatch');
  }
  const identities = new Set(result.patients.map(row => row.id));
  if (identities.size !== scenario.patients.size || result.patients.length !== identities.size) {
    throw new Invalid('patient population does not conserve');
  }
  if (!result.snapshots.length || result.snapshots.at(-1).time !== result.horizon) {
    throw new Invalid('terminal snapshot missing');
  }
  if (digest(result.snapshots.at(-1).counts) !== digest(result.counts)) {
    throw new Invalid('terminal snapshot counts disagree');
  }
  for (const snapshot of result.snapshots) {
    const population = Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0);
    if (population !== scenario.patients.size) {
      throw new Invalid('snapshot patient population does not conserve');
    }
  }
  let previous = null;
  let time = 0;
  for (let index = 0; index < result.events.length; index += 1) {
    const event = result.events[index];
    const { hash, ...record } = event;
    if (event.sequence !== index || event.previous !== previous || digest(record) !== hash || event.time < time) {
      throw new Invalid('event chain integrity failure');
    }
    previous = hash;
    time = event.time;
  }
  if (previous !== result.event_root) {
    throw new Invalid('event root mismatch');
  }
  let end = 0;
  for (const interval of result.intervals) {
    if (interval.start !== end || interval.end <= interval.start || interval.duration !== interval.end - interval.start) {
      throw new Invalid('interval partition invalid');
    }
    for (const row of interval.wards) {
      const capacity = closureCapacity(scenario, row.ward, interval.start);
      if (row.beds !== capacity.beds || row.accessible !== capacity.accessible) {
        throw new Invalid('interval capacity does not match calendar');
      }
      if (row.occupied < 0 || row.occupied_accessible > row.occupied) {
        throw new Invalid('invalid occupancy');
      }
    }
    end = interval.end;
  }
  if (end !== result.horizon) {
    throw new Invalid('simulation horizon not fully integrated');
  }
  const counts = Object.fromEntries(Object.keys(result.counts).map(key => [key, 0]));
  for (const state of result.patients) {
    if (!scenario.patients.has(state.id) || !Object.hasOwn(counts, state.status)) {
      throw new Invalid('unknown patient or state');
    }
    counts[state.status] += 1;
    let priorEnd = scenario.patients.get(state.id).arrival;
    for (const episode of state.episodes) {
      if (!scenario.wards.has(episode.ward) || episode.start < priorEnd) {
        throw new Invalid('invalid care episode ordering');
      }
      if (!['ordinary', 'accessible'].includes(episode.seat)) {
        throw new Invalid('unknown bed class');
      }
      const stop = episode.end ?? result.horizon;
      if (stop < episode.start || stop > result.horizon) {
        throw new Invalid('care episode outside horizon');
      }
      priorEnd = stop;
    }
  }
  if (digest(counts) !== digest(result.counts)) {
    throw new Invalid('terminal counts do not match patients');
  }
  const metrics = patientMetrics(scenario, result);
  const queue = queueArea(result);
  if (metrics.reduce((sum, row) => sum + row.initial_wait, 0) !== queue.waiting_person_time) {
    throw new Invalid('waiting time integral differs from patient records');
  }
  if (metrics.reduce((sum, row) => sum + row.boarding_time, 0) !== queue.boarding_person_time) {
    throw new Invalid('boarding time integral differs from patient records');
  }
  const patientCare = metrics.reduce((sum, row) => sum + row.care_time, 0);
  const wardCare = wardMetrics(scenario, result).reduce((sum, row) => sum + row.occupied_bed_time, 0);
  if (patientCare !== wardCare) {
    throw new Invalid('patient and ward care time do not conserve');
  }
  for (const row of metrics) {
    if (row.care_time > row.requested_care || (row.completed && row.care_time !== row.requested_care)) {
      throw new Invalid('care duration differs from requested stay');
    }
  }
  if (replay && digest(new Engine(scenario).run()) !== digest(result)) {
    throw new Invalid('deterministic simulation replay mismatch');
  }
  return {
    valid: true,
    replayed: replay,
    patients: identities.size,
    care_time: patientCare,
    event_root: result.event_root
  };
}
