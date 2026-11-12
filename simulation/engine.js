import { EventHeap } from './heap.js';
import { closureCapacity } from '../ward_calendar/model.js';
import { validateCalendar } from '../ward_calendar/calendar.js';
import { orderedQueue, chooseWard, usage, relocationVictims, queueReasons } from '../patient_flow/queue.js';
import { clone, digest, integer, Invalid } from '../scenarios/values.js';

export class Engine {
  constructor(scenario) {
    validateCalendar(scenario);
    this.scenario = scenario;
    this.clock = 0;
    this.processed = 0;
    this.done = false;
    this.heap = new EventHeap();
    this.states = new Map();
    this.capacities = new Map();
    this.events = [];
    this.intervals = [];
    this.snapshots = [];
    this.previous_hash = null;
    const initial = new Map();
    for (const ward of scenario.wards.values()) {
      this.capacities.set(ward.id, {
        beds: ward.beds,
        accessible: ward.accessible,
        active: []
      });
      for (const key of ward.initial) {
        initial.set(key, ward.id);
      }
    }
    for (const patient of scenario.patients.values()) {
      this.states.set(patient.id, {
        id: patient.id,
        status: 'future',
        ward: null,
        seat: null,
        queued_at: patient.arrival,
        first_admitted: null,
        last_admitted: null,
        discharged: null,
        abandoned: null,
        finish: null,
        remaining: patient.stay,
        generation: 0,
        moves: 0,
        boarding_time: 0,
        boarding_started: null,
        episodes: []
      });
      if (!initial.has(patient.id)) {
        this.heap.push(patient.arrival, 'arrival', { patient: patient.id });
        this.heap.push(patient.arrival + patient.patience, 'timeout', { patient: patient.id });
      }
    }
    const initialOrder = [...initial].sort((a, b) => Number(scenario.patients.get(b[0]).accessible) - Number(scenario.patients.get(a[0]).accessible) || a[0].localeCompare(b[0]));
    for (const [key, wardId] of initialOrder) {
      const patient = scenario.patients.get(key);
      const state = this.states.get(key);
      const ward = scenario.wards.get(wardId);
      const used = usage(this.states, wardId);
      let seat = patient.accessible ? 'accessible' : 'ordinary';
      if (!patient.accessible && used.ordinary >= ward.beds - ward.accessible) {
        seat = 'accessible';
      }
      this.admit(state, wardId, seat, true);
    }
    for (const closure of scenario.closures.values()) {
      this.heap.push(closure.start, 'capacity', { closure: closure.id, action: 'start' });
      this.heap.push(closure.end, 'capacity', { closure: closure.id, action: 'end' });
    }
    this.heap.push(0, 'capacity', { action: 'initial' });
    this.heap.push(scenario.horizon, 'horizon');
  }

  log(kind, details) {
    const body = {
      sequence: this.events.length,
      time: this.clock,
      kind,
      details: clone(details),
      previous: this.previous_hash
    };
    const hash = digest(body);
    this.events.push({ ...body, hash });
    this.previous_hash = hash;
  }

  admit(state, wardId, seat, initial = false) {
    const previouslyAdmitted = state.first_admitted !== null;
    if (state.status === 'boarding') {
      state.boarding_time += this.clock - state.boarding_started;
      state.boarding_started = null;
    }
    state.status = 'admitted';
    state.ward = wardId;
    state.seat = seat;
    state.last_admitted = this.clock;
    state.first_admitted ??= this.clock;
    state.finish = this.clock + state.remaining;
    state.generation += 1;
    state.episodes.push({
      ward: wardId,
      seat,
      start: this.clock,
      end: null
    });
    this.heap.push(state.finish, 'discharge', {
      patient: state.id,
      generation: state.generation
    });
    this.log(initial ? 'initial' : previouslyAdmitted ? 'relocated' : 'admitted', {
      patient: state.id,
      ward: wardId,
      seat,
      finish: state.finish
    });
  }

  closeEpisode(state) {
    const episode = state.episodes.at(-1);
    if (!episode || episode.end !== null) {
      throw new Invalid('open inpatient episode missing');
    }
    episode.end = this.clock;
  }

  displace(state, closures) {
    const priorWard = state.ward;
    this.closeEpisode(state);
    state.remaining = state.finish - this.clock;
    if (state.remaining <= 0) {
      throw new Invalid('completed care displaced before discharge processing');
    }
    state.status = 'boarding';
    state.boarding_started = this.clock;
    state.queued_at = this.clock;
    state.ward = null;
    state.seat = null;
    state.finish = null;
    state.generation += 1;
    state.moves += 1;
    this.log('displaced', {
      patient: state.id,
      ward: priorWard,
      remaining: state.remaining,
      closures
    });
  }

  integrate(until) {
    const duration = until - this.clock;
    if (duration < 0) {
      throw new Invalid('event clock reversed');
    }
    if (!duration) {
      return;
    }
    const wards = [];
    for (const ward of this.scenario.wards.values()) {
      const capacity = this.capacities.get(ward.id);
      const used = usage(this.states, ward.id);
      wards.push({
        ward: ward.id,
        beds: capacity.beds,
        accessible: capacity.accessible,
        occupied: used.occupied,
        occupied_accessible: used.accessible,
        ordinary_debt: Math.max(0, used.ordinary - (capacity.beds - capacity.accessible)),
        accessible_debt: Math.max(0, used.accessible - capacity.accessible),
        active_closures: capacity.active
      });
    }
    const waiting = [...this.states.values()].filter(row => row.status === 'waiting').length;
    const boarding = [...this.states.values()].filter(row => row.status === 'boarding').length;
    this.intervals.push({
      start: this.clock,
      end: until,
      duration,
      waiting,
      boarding,
      wards
    });
    this.clock = until;
  }

  applyCapacity(events) {
    for (const ward of this.scenario.wards.values()) {
      const capacity = closureCapacity(this.scenario, ward.id, this.clock);
      this.capacities.set(ward.id, capacity);
      const starting = events.filter(event => event.payload.action === 'start')
        .map(event => this.scenario.closures.get(event.payload.closure))
        .filter(closure => closure.ward === ward.id && closure.mode === 'relocate');
      if (starting.length) {
        const victims = relocationVictims(this.scenario, this.states, ward.id, capacity);
        for (const victim of victims) {
          this.displace(victim, starting.map(row => row.id).sort());
        }
      }
      this.log('capacity', {
        ward: ward.id,
        ...capacity
      });
    }
  }

  allocate() {
    for (const state of orderedQueue(this.scenario, this.states)) {
      const patient = this.scenario.patients.get(state.id);
      const choice = chooseWard(this.scenario, this.capacities, this.states, patient);
      if (choice) {
        this.admit(state, choice.ward, choice.seat);
      }
    }
  }

  step() {
    if (this.done) {
      return false;
    }
    const next = this.heap.peek();
    if (!next || next.time > this.scenario.horizon) {
      throw new Invalid('horizon marker missing');
    }
    this.integrate(next.time);
    const batch = this.heap.takeTime(next.time);
    this.processed += batch.length;
    if (this.processed > this.scenario.document.policy.max_events) {
      throw new Invalid('maximum event budget exceeded');
    }
    for (const event of batch.filter(row => row.kind === 'discharge')) {
      const state = this.states.get(event.payload.patient);
      if (state.status !== 'admitted' || state.generation !== event.payload.generation) {
        continue;
      }
      this.closeEpisode(state);
      const ward = state.ward;
      state.status = 'discharged';
      state.discharged = this.clock;
      state.remaining = 0;
      state.ward = null;
      state.seat = null;
      state.finish = null;
      this.log('discharged', { patient: state.id, ward });
    }
    const capacityEvents = batch.filter(row => row.kind === 'capacity');
    if (capacityEvents.length) {
      this.applyCapacity(capacityEvents);
    }
    for (const event of batch.filter(row => row.kind === 'arrival')) {
      const state = this.states.get(event.payload.patient);
      if (state.status !== 'future') {
        throw new Invalid('patient arrived twice');
      }
      state.status = 'waiting';
      this.log('arrived', { patient: state.id });
    }
    this.allocate();
    for (const event of batch.filter(row => row.kind === 'timeout')) {
      const state = this.states.get(event.payload.patient);
      if (state.status === 'waiting') {
        state.status = 'abandoned';
        state.abandoned = this.clock;
        this.log('abandoned', {
          patient: state.id,
          reasons: queueReasons(this.scenario, this.capacities, this.states, this.scenario.patients.get(state.id))
        });
      }
    }
    this.snapshots.push({
      time: this.clock,
      counts: this.counts(),
      event_hash: this.previous_hash
    });
    this.done = batch.some(row => row.kind === 'horizon');
    return true;
  }

  counts() {
    const result = {
      future: 0,
      waiting: 0,
      boarding: 0,
      admitted: 0,
      discharged: 0,
      abandoned: 0
    };
    for (const state of this.states.values()) {
      result[state.status] += 1;
    }
    return result;
  }

  run() {
    while (this.step()) {
      if (this.done) {
        break;
      }
    }
    return this.result();
  }

  result() {
    if (!this.done) {
      throw new Invalid('simulation incomplete');
    }
    const body = {
      version: 1,
      input_digest: this.scenario.fingerprint,
      horizon: this.scenario.horizon,
      patients: [...this.states.values()].sort((a, b) => a.id.localeCompare(b.id)),
      counts: this.counts(),
      intervals: clone(this.intervals),
      snapshots: clone(this.snapshots),
      events: clone(this.events),
      processed_events: this.processed,
      event_root: this.previous_hash,
      conventions: [
        'half_open_occupancy_intervals',
        'discharge_then_capacity_then_arrival_then_allocate_then_timeout',
        'admission_allowed_at_patience_deadline',
        'relocation_pauses_remaining_care_while_boarding',
        'drain_closure_retains_existing_occupants_and_records_capacity_debt'
      ]
    };
    return { ...body, result_digest: digest(body) };
  }
}
