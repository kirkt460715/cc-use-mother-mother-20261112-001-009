import { stateAt } from './explorer.js';
import { closureCapacity } from '../ward_calendar/model.js';
import { integer, ratio, Invalid } from '../scenarios/values.js';

export function bedLedger(scenario, result) {
  const rows = [];
  for (const interval of result.intervals) {
    const state = stateAt(scenario, result, interval.start);
    for (const ward of scenario.wards.values()) {
      const occupants = state.patients.filter(row => row.status === 'admitted' && row.ward === ward.id);
      const record = interval.wards.find(row => row.ward === ward.id);
      const capacity = closureCapacity(scenario, ward.id, interval.start);
      const accessible = occupants.filter(row => row.seat === 'accessible').length;
      if (occupants.length !== record.occupied || accessible !== record.occupied_accessible) {
        throw new Invalid('event replay and integrated occupancy disagree');
      }
      rows.push({
        start: interval.start,
        end: interval.end,
        ward: ward.id,
        occupants: occupants.map(row => row.id).sort(),
        beds: capacity.beds,
        accessible_beds: capacity.accessible,
        occupied: occupants.length,
        debt: record.ordinary_debt + record.accessible_debt,
        free: Math.max(0, capacity.beds - occupants.length),
        blocked_by_drain: occupants.length >= capacity.beds && capacity.active.length > 0
      });
    }
  }
  return rows;
}

export function constructionEffects(scenario, result) {
  const ledger = bedLedger(scenario, result);
  const output = [];
  for (const closure of scenario.closures.values()) {
    const intervals = ledger.filter(row => row.ward === closure.ward && row.start < closure.end && row.end > closure.start);
    let debt = 0;
    let occupied = 0;
    for (const row of intervals) {
      const duration = Math.min(row.end, closure.end) - Math.max(row.start, closure.start);
      debt += row.debt * duration;
      occupied += row.occupied * duration;
    }
    const displaced = result.events.filter(event => event.kind === 'displaced' && event.details.closures.includes(closure.id));
    output.push({
      closure: closure.id,
      ward: closure.ward,
      start: closure.start,
      end: closure.end,
      declared_closed_bed_time: closure.beds * (closure.end - closure.start),
      coincident_occupied_bed_time: occupied,
      coincident_capacity_debt_time: debt,
      displaced_people: [...new Set(displaced.map(event => event.details.patient))].sort(),
      effects_can_overlap_other_closures: true
    });
  }
  return output;
}

export function windows(scenario, result, width = 24) {
  integer(width, 'width', 1, result.horizon);
  const output = [];
  for (let start = 0; start < result.horizon; start += width) {
    const end = Math.min(result.horizon, start + width);
    let available = 0;
    let occupied = 0;
    let waiting = 0;
    let boarding = 0;
    let debt = 0;
    for (const interval of result.intervals) {
      const duration = Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start));
      if (!duration) {
        continue;
      }
      waiting += interval.waiting * duration;
      boarding += interval.boarding * duration;
      for (const ward of interval.wards) {
        available += ward.beds * duration;
        occupied += ward.occupied * duration;
        debt += (ward.ordinary_debt + ward.accessible_debt) * duration;
      }
    }
    output.push({
      start,
      end,
      available_bed_time: available,
      occupied_bed_time: occupied,
      waiting_person_time: waiting,
      boarding_person_time: boarding,
      capacity_debt_time: debt,
      utilization: ratio(occupied, available)
    });
  }
  return output;
}
