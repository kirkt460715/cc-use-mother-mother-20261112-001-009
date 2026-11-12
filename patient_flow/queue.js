import { Invalid } from '../scenarios/values.js';

export function orderedQueue(scenario, states) {
  const queue = [...states.values()].filter(row => row.status === 'waiting' || row.status === 'boarding');
  queue.sort((left, right) => {
    const a = scenario.patients.get(left.id);
    const b = scenario.patients.get(right.id);
    if (scenario.document.policy.queue === 'priority' && a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    if (left.status !== right.status) {
      return left.status === 'boarding' ? -1 : 1;
    }
    return left.queued_at - right.queued_at || left.id.localeCompare(right.id);
  });
  return queue;
}

export function usage(states, wardId) {
  const counts = {
    occupied: 0,
    accessible: 0,
    ordinary: 0
  };
  for (const row of states.values()) {
    if (row.status === 'admitted' && row.ward === wardId) {
      counts.occupied += 1;
      counts[row.seat] += 1;
    }
  }
  return counts;
}

export function availableSeat(scenario, ward, capacity, states, patient) {
  if (ward.specialty !== patient.specialty) {
    return null;
  }
  const used = usage(states, ward.id);
  const ordinary = capacity.beds - capacity.accessible - used.ordinary;
  const accessible = capacity.accessible - used.accessible;
  if (used.occupied >= capacity.beds) {
    return null;
  }
  if (patient.accessible) {
    return accessible > 0 ? 'accessible' : null;
  }
  if (ordinary > 0) {
    return 'ordinary';
  }
  if (!scenario.document.policy.reserve_accessible && accessible > 0) {
    return 'accessible';
  }
  return null;
}

export function chooseWard(scenario, capacities, states, patient) {
  const candidates = [];
  for (const ward of scenario.wards.values()) {
    const capacity = capacities.get(ward.id);
    const seat = availableSeat(scenario, ward, capacity, states, patient);
    if (seat) {
      const used = usage(states, ward.id);
      candidates.push({
        ward: ward.id,
        seat,
        free: capacity.beds - used.occupied,
        accessible_only_penalty: !patient.accessible && seat === 'accessible' ? 1 : 0
      });
    }
  }
  candidates.sort((a, b) => a.accessible_only_penalty - b.accessible_only_penalty || b.free - a.free || a.ward.localeCompare(b.ward));
  return candidates.length ? candidates[0] : null;
}

export function relocationVictims(scenario, states, wardId, capacity) {
  const ward = scenario.wards.get(wardId);
  const occupants = [...states.values()].filter(row => row.status === 'admitted' && row.ward === wardId);
  occupants.sort((a, b) => {
    const first = scenario.patients.get(a.id);
    const last = scenario.patients.get(b.id);
    return first.priority - last.priority || b.last_admitted - a.last_admitted || a.id.localeCompare(b.id);
  });
  const selected = new Set();
  for (const seat of ['accessible', 'ordinary']) {
    const maximum = seat === 'accessible' ? capacity.accessible : capacity.beds - capacity.accessible;
    const sameType = occupants.filter(row => row.seat === seat);
    const excess = Math.max(0, sameType.length - maximum);
    for (const row of sameType.slice(0, excess)) {
      selected.add(row.id);
    }
  }
  return occupants.filter(row => selected.has(row.id));
}

export function queueReasons(scenario, capacities, states, patient) {
  const compatible = [...scenario.wards.values()].filter(ward => ward.specialty === patient.specialty);
  if (!compatible.length) {
    return ['no_specialty'];
  }
  const reasons = new Set();
  for (const ward of compatible) {
    const capacity = capacities.get(ward.id);
    const used = usage(states, ward.id);
    if (capacity.beds === 0) {
      reasons.add('ward_closed');
    } else if (used.occupied >= capacity.beds) {
      reasons.add('occupied_or_draining');
    } else if (patient.accessible) {
      reasons.add('accessible_beds_unavailable');
    } else {
      reasons.add('accessible_beds_reserved');
    }
  }
  return [...reasons].sort();
}
