import { fields, integer, id, array, index, clone, digest, Invalid } from '../scenarios/values.js';

export class Scenario {
  constructor(document) {
    fields(document, ['version', 'horizon', 'wards', 'closures', 'patients', 'policy']);
    integer(document.version, 'version', 1, 1);
    integer(document.horizon, 'horizon', 1, 100000);
    this.document = clone(document);
    this.horizon = document.horizon;
    array(this.document.wards, 'wards', 100);
    array(this.document.closures, 'closures', 1000);
    array(this.document.patients, 'patients', 10000);
    this.wards = index(this.document.wards, 'ward');
    this.closures = index(this.document.closures, 'closure');
    this.patients = index(this.document.patients, 'patient');
    if (!this.wards.size) {
      throw new Invalid('at least one ward required');
    }
    for (const ward of this.wards.values()) {
      fields(ward, ['id', 'specialty', 'beds', 'accessible', 'initial']);
      id(ward.specialty, 'specialty');
      integer(ward.beds, 'beds', 1, 10000);
      integer(ward.accessible, 'accessible', 0, ward.beds);
      array(ward.initial, 'initial', ward.beds);
      if (new Set(ward.initial).size !== ward.initial.length) {
        throw new Invalid('duplicate initial occupant');
      }
    }
    for (const closure of this.closures.values()) {
      fields(closure, ['id', 'ward', 'start', 'end', 'beds', 'accessible', 'requires', 'mode']);
      if (!this.wards.has(closure.ward)) {
        throw new Invalid('closure ward missing');
      }
      integer(closure.start, 'start', 0, this.horizon);
      integer(closure.end, 'end', closure.start + 1, this.horizon);
      const ward = this.wards.get(closure.ward);
      integer(closure.beds, 'closure beds', 1, ward.beds);
      integer(closure.accessible, 'closure accessible', 0, Math.min(closure.beds, ward.accessible));
      array(closure.requires, 'requires', 1000);
      if (new Set(closure.requires).size !== closure.requires.length) {
        throw new Invalid('duplicate construction dependency');
      }
      if (!['drain', 'relocate'].includes(closure.mode)) {
        throw new Invalid('closure mode must be drain or relocate');
      }
    }
    for (const closure of this.closures.values()) {
      for (const key of closure.requires) {
        const parent = this.closures.get(key);
        if (!parent || parent.id === closure.id || parent.end > closure.start) {
          throw new Invalid('construction dependency missing, cyclic, or finishes too late');
        }
      }
    }
    const initial = new Set();
    for (const ward of this.wards.values()) {
      for (const key of ward.initial) {
        if (!this.patients.has(key) || initial.has(key)) {
          throw new Invalid('initial patient missing or assigned twice');
        }
        initial.add(key);
      }
    }
    for (const patient of this.patients.values()) {
      fields(patient, ['id', 'arrival', 'stay', 'specialty', 'accessible', 'priority', 'patience']);
      integer(patient.arrival, 'arrival', 0, this.horizon);
      integer(patient.stay, 'stay', 1, 100000);
      integer(patient.priority, 'priority', 0, 10);
      integer(patient.patience, 'patience', 0, this.horizon);
      id(patient.specialty, 'specialty');
      if (typeof patient.accessible !== 'boolean') {
        throw new Invalid('patient accessibility must be boolean');
      }
      if (![...this.wards.values()].some(ward => ward.specialty === patient.specialty)) {
        throw new Invalid('patient specialty absent from wards');
      }
      if (initial.has(patient.id) && patient.arrival !== 0) {
        throw new Invalid('initial occupant must arrive at time zero');
      }
    }
    for (const ward of this.wards.values()) {
      if (ward.initial.some(key => this.patients.get(key).specialty !== ward.specialty)) {
        throw new Invalid('initial specialty incompatible');
      }
      const accessible = ward.initial.filter(key => this.patients.get(key).accessible).length;
      if (accessible > ward.accessible) {
        throw new Invalid('initial accessible capacity exceeded');
      }
    }
    fields(this.document.policy, ['queue', 'reserve_accessible', 'max_events']);
    if (!['priority', 'fifo'].includes(this.document.policy.queue)) {
      throw new Invalid('unknown queue policy');
    }
    if (typeof this.document.policy.reserve_accessible !== 'boolean') {
      throw new Invalid('reserve_accessible must be boolean');
    }
    integer(this.document.policy.max_events, 'max_events', 100, 1000000);
    this.document.wards.sort((a, b) => a.id.localeCompare(b.id));
    this.document.closures.sort((a, b) => a.id.localeCompare(b.id));
    this.document.patients.sort((a, b) => a.id.localeCompare(b.id));
    this.fingerprint = digest(this.document);
  }

  export() {
    return clone(this.document);
  }
}

export function closureCapacity(scenario, wardId, time) {
  const ward = scenario.wards.get(wardId);
  if (!ward) {
    throw new Invalid('unknown ward');
  }
  integer(time, 'time', 0, scenario.horizon);
  let beds = ward.beds;
  let accessible = ward.accessible;
  const active = [];
  for (const closure of scenario.closures.values()) {
    if (closure.ward === wardId && closure.start <= time && time < closure.end) {
      beds -= closure.beds;
      accessible -= closure.accessible;
      active.push(closure.id);
    }
  }
  if (beds < 0 || accessible < 0 || accessible > beds) {
    throw new Invalid('overlapping closures produce invalid capacity');
  }
  return {
    beds,
    accessible,
    active: active.sort()
  };
}
