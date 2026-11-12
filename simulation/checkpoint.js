import { Engine } from './engine.js';
import { EventHeap } from './heap.js';
import { clone, digest, fields, integer, Invalid } from '../scenarios/values.js';

export function capture(engine) {
  const body = {
    version: 1,
    input_digest: engine.scenario.fingerprint,
    clock: engine.clock,
    processed: engine.processed,
    done: engine.done,
    heap: engine.heap.export(),
    states: [...engine.states.entries()],
    capacities: [...engine.capacities.entries()],
    events: engine.events,
    intervals: engine.intervals,
    snapshots: engine.snapshots,
    previous_hash: engine.previous_hash
  };
  return clone({ ...body, checkpoint_digest: digest(body) });
}

export function restore(scenario, document, replay = true) {
  fields(document, ['version', 'input_digest', 'clock', 'processed', 'done', 'heap',
    'states', 'capacities', 'events', 'intervals', 'snapshots', 'previous_hash', 'checkpoint_digest']);
  const { checkpoint_digest, ...body } = document;
  if (document.version !== 1 || digest(body) !== checkpoint_digest) {
    throw new Invalid('checkpoint checksum mismatch');
  }
  if (document.input_digest !== scenario.fingerprint) {
    throw new Invalid('checkpoint belongs to another scenario');
  }
  integer(document.clock, 'checkpoint clock', 0, scenario.horizon);
  integer(document.processed, 'processed events', 0, scenario.document.policy.max_events);
  if (typeof document.done !== 'boolean') {
    throw new Invalid('checkpoint done flag invalid');
  }
  const engine = new Engine(scenario);
  if (replay) {
    while (engine.snapshots.length < document.snapshots.length && !engine.done) {
      engine.step();
    }
    if (digest(capture(engine)) !== digest(document)) {
      throw new Invalid('checkpoint differs from deterministic prefix replay');
    }
    return engine;
  }
  engine.clock = document.clock;
  engine.processed = document.processed;
  engine.done = document.done;
  engine.heap = EventHeap.restore(document.heap);
  engine.states = new Map(clone(document.states));
  engine.capacities = new Map(clone(document.capacities));
  engine.events = clone(document.events);
  engine.intervals = clone(document.intervals);
  engine.snapshots = clone(document.snapshots);
  engine.previous_hash = document.previous_hash;
  if (engine.states.size !== scenario.patients.size || engine.capacities.size !== scenario.wards.size) {
    throw new Invalid('checkpoint population or ward set mismatch');
  }
  for (const key of scenario.patients.keys()) {
    if (!engine.states.has(key)) {
      throw new Invalid('checkpoint patient missing');
    }
  }
  if (engine.heap.peek() && engine.heap.peek().time < engine.clock) {
    throw new Invalid('checkpoint has past pending event');
  }
  return engine;
}

export function resume(scenario, checkpoint) {
  const engine = restore(scenario, checkpoint);
  return engine.run();
}
