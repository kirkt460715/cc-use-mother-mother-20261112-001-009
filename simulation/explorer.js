import { digest, integer, fields, Invalid } from '../scenarios/values.js';
import { patientMetrics, wardMetrics, summary, serviceLevels, queueArea } from '../patient_flow/metrics.js';
import { capacitySummary, segments, dependencyOrder } from '../ward_calendar/calendar.js';
import { verify } from './audit.js';

export function stateAt(scenario, result, time) {
  integer(time, 'time', 0, result.horizon);
  const states = new Map();
  for (const patient of scenario.patients.values()) {
    states.set(patient.id, {
      id: patient.id,
      status: 'future',
      ward: null,
      seat: null
    });
  }
  for (const event of result.events) {
    if (event.time > time) {
      break;
    }
    const state = states.get(event.details.patient);
    if (!state) {
      continue;
    }
    if (event.kind === 'arrived') {
      state.status = 'waiting';
    }
    if (['initial', 'admitted', 'relocated'].includes(event.kind)) {
      state.status = 'admitted';
      state.ward = event.details.ward;
      state.seat = event.details.seat;
    }
    if (event.kind === 'displaced') {
      state.status = 'boarding';
      state.ward = null;
      state.seat = null;
    }
    if (event.kind === 'discharged' || event.kind === 'abandoned') {
      state.status = event.kind;
      state.ward = null;
      state.seat = null;
    }
  }
  return {
    time,
    convention: 'after_all_events_at_time',
    patients: [...states.values()].sort((a, b) => a.id.localeCompare(b.id))
  };
}

export function patientTrace(scenario, result, key) {
  const state = result.patients.find(row => row.id === key);
  if (!state) {
    throw new Invalid('unknown patient');
  }
  return {
    input: scenario.patients.get(key),
    state,
    metrics: patientMetrics(scenario, result).find(row => row.id === key),
    events: result.events.filter(row => row.details.patient === key),
    source_digest: scenario.fingerprint,
    result_digest: result.result_digest
  };
}

export function page(result, table, options = {}) {
  fields(options, [], ['limit', 'cursor', 'patient', 'kind', 'from', 'to']);
  const limit = options.limit ?? 100;
  integer(limit, 'limit', 1, 1000);
  const source = {
    patients: result.patients,
    events: result.events,
    intervals: result.intervals,
    snapshots: result.snapshots
  }[table];
  if (!source) {
    throw new Invalid('unknown result table');
  }
  let rows = source;
  if (options.patient !== undefined) {
    if (!['patients', 'events'].includes(table)) {
      throw new Invalid('patient filter incompatible with table');
    }
    rows = rows.filter(row => (table === 'patients' ? row.id : row.details.patient) === options.patient);
  }
  if (options.kind !== undefined) {
    if (table !== 'events') {
      throw new Invalid('kind filter only applies to events');
    }
    rows = rows.filter(row => row.kind === options.kind);
  }
  for (const key of ['from', 'to']) {
    if (options[key] !== undefined) {
      integer(options[key], key, 0, result.horizon);
    }
  }
  rows = rows.filter(row => {
    const time = row.time ?? row.start ?? 0;
    return (options.from === undefined || time >= options.from) && (options.to === undefined || time <= options.to);
  });
  const { cursor, ...bound } = options;
  const context = digest({ result: result.result_digest, table, options: bound });
  let offset = 0;
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Invalid('invalid query cursor');
    }
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    } catch {
      throw new Invalid('malformed query cursor');
    }
    if (decoded.context !== context) {
      throw new Invalid('cursor belongs to another query');
    }
    offset = integer(decoded.offset, 'offset', 0, rows.length);
  }
  const selected = rows.slice(offset, offset + limit);
  const next = offset + selected.length;
  return {
    rows: selected,
    total: rows.length,
    next_cursor: next < rows.length ? Buffer.from(JSON.stringify({ context, offset: next })).toString('base64url') : null
  };
}

export function query(scenario, result, kind, options = {}) {
  if (['patients', 'events', 'intervals', 'snapshots'].includes(kind)) {
    return page(result, kind, options);
  }
  if (kind === 'patient') {
    fields(options, ['id']);
    return patientTrace(scenario, result, options.id);
  }
  if (kind === 'state-at') {
    fields(options, ['time']);
    return stateAt(scenario, result, options.time);
  }
  if (kind === 'summary') {
    fields(options, [], ['dimension']);
    return summary(scenario, result, options.dimension);
  }
  if (kind === 'service-levels') {
    fields(options, [], ['thresholds']);
    return serviceLevels(scenario, result, options.thresholds ?? [0, Math.min(6, result.horizon)]);
  }
  fields(options, []);
  if (kind === 'ward-metrics') {
    return wardMetrics(scenario, result);
  }
  if (kind === 'patient-metrics') {
    return patientMetrics(scenario, result);
  }
  if (kind === 'queue') {
    return queueArea(result);
  }
  if (kind === 'calendar') {
    return segments(scenario);
  }
  if (kind === 'capacity-summary') {
    return capacitySummary(scenario);
  }
  if (kind === 'construction-order') {
    return dependencyOrder(scenario);
  }
  if (kind === 'audit') {
    return verify(scenario, result, true);
  }
  throw new Invalid('unknown query');
}
