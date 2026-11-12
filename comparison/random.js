import { createHash } from 'node:crypto';
import { integer, id, fields, array, Invalid } from '../scenarios/values.js';

export function uniform(seed, key, stream = 'default') {
  integer(seed, 'seed', 0, 0xffffffff);
  const bytes = createHash('sha256').update(JSON.stringify([seed, stream, key])).digest();
  return (bytes.readUInt32BE(0) + 0.5) / 4294967296;
}

export function discrete(seed, key, values, stream = 'discrete') {
  array(values, 'distribution', 100);
  if (!values.length) {
    throw new Invalid('nonempty distribution required');
  }
  let total = 0;
  for (const row of values) {
    fields(row, ['value', 'weight']);
    integer(row.weight, 'weight', 1, 1000000);
    integer(row.value, 'value', 0, 100000);
    total += row.weight;
  }
  let point = uniform(seed, key, stream) * total;
  for (const row of values) {
    point -= row.weight;
    if (point < 0) {
      return row.value;
    }
  }
  return values.at(-1).value;
}

export function arrivals(profile, horizon, seed) {
  fields(profile, ['count', 'specialty', 'accessible_pct', 'stay', 'patience', 'priority']);
  integer(profile.count, 'count', 0, 10000);
  integer(profile.accessible_pct, 'accessible_pct', 0, 100);
  integer(profile.patience, 'patience', 0, horizon);
  id(profile.specialty, 'specialty');
  const output = [];
  for (let index = 0; index < profile.count; index += 1) {
    const key = `synthetic-${index.toString().padStart(5, '0')}`;
    const arrival = Math.floor(uniform(seed, key, 'arrival') * horizon);
    const stay = discrete(seed, key, profile.stay, 'stay');
    const priority = discrete(seed, key, profile.priority, 'priority');
    integer(stay, 'sampled stay', 1, 100000);
    integer(priority, 'sampled priority', 0, 10);
    output.push({
      id: key,
      arrival,
      stay,
      specialty: profile.specialty,
      accessible: uniform(seed, key, 'accessible') * 100 < profile.accessible_pct,
      priority,
      patience: profile.patience
    });
  }
  output.sort((a, b) => a.id.localeCompare(b.id));
  return output;
}

export function seeds(base, count) {
  integer(base, 'base seed', 0, 0xffffffff);
  integer(count, 'replications', 1, 100);
  return Array.from({ length: count }, (_, index) => (base + index) >>> 0);
}
