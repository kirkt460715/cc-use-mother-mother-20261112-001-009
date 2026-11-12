import { closureCapacity } from './model.js';
import { integer, Invalid } from '../scenarios/values.js';

export function validateCalendar(scenario) {
  const points = new Set([0, scenario.horizon]);
  for (const closure of scenario.closures.values()) {
    points.add(closure.start);
    points.add(closure.end);
  }
  const ordered = [...points].sort((a, b) => a - b);
  for (const time of ordered) {
    for (const ward of scenario.wards.values()) {
      closureCapacity(scenario, ward.id, time);
    }
  }
  return {
    valid: true,
    boundaries: ordered,
    closures: scenario.closures.size
  };
}

export function segments(scenario) {
  const checked = validateCalendar(scenario);
  const rows = [];
  for (let index = 0; index < checked.boundaries.length - 1; index += 1) {
    const start = checked.boundaries[index];
    const end = checked.boundaries[index + 1];
    for (const ward of scenario.wards.values()) {
      const capacity = closureCapacity(scenario, ward.id, start);
      rows.push({
        ward: ward.id,
        start,
        end,
        duration: end - start,
        beds: capacity.beds,
        accessible: capacity.accessible,
        active_closures: capacity.active
      });
    }
  }
  return rows;
}

export function capacitySummary(scenario) {
  const byWard = new Map();
  for (const segment of segments(scenario)) {
    if (!byWard.has(segment.ward)) {
      byWard.set(segment.ward, {
        ward: segment.ward,
        nominal_bed_time: scenario.wards.get(segment.ward).beds * scenario.horizon,
        available_bed_time: 0,
        accessible_bed_time: 0,
        closed_bed_time: 0,
        minimum_beds: Infinity
      });
    }
    const row = byWard.get(segment.ward);
    row.available_bed_time += segment.beds * segment.duration;
    row.accessible_bed_time += segment.accessible * segment.duration;
    row.minimum_beds = Math.min(row.minimum_beds, segment.beds);
  }
  for (const row of byWard.values()) {
    row.closed_bed_time = row.nominal_bed_time - row.available_bed_time;
  }
  return [...byWard.values()].sort((a, b) => a.ward.localeCompare(b.ward));
}

export function dependencyOrder(scenario) {
  const completed = new Set();
  const output = [];
  while (completed.size < scenario.closures.size) {
    const ready = [...scenario.closures.values()].filter(row => !completed.has(row.id) && row.requires.every(key => completed.has(key)));
    ready.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    if (!ready.length) {
      throw new Invalid('construction dependency cycle');
    }
    for (const row of ready) {
      completed.add(row.id);
      output.push(row.id);
    }
  }
  return output;
}

export function shiftClosure(scenario, closureId, delta, cascade = false) {
  integer(delta, 'delta', -scenario.horizon, scenario.horizon);
  if (typeof cascade !== 'boolean' || !scenario.closures.has(closureId)) {
    throw new Invalid('invalid closure shift request');
  }
  const document = scenario.export();
  const affected = new Set([closureId]);
  if (cascade) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const closure of document.closures) {
        if (!affected.has(closure.id) && closure.requires.some(key => affected.has(key))) {
          affected.add(closure.id);
          changed = true;
        }
      }
    }
  }
  for (const closure of document.closures) {
    if (affected.has(closure.id)) {
      closure.start += delta;
      closure.end += delta;
    }
  }
  return document;
}
