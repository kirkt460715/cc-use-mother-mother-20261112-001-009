import { mkdirSync, existsSync, writeFileSync, readFileSync, renameSync, rmSync, mkdtempSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { Scenario } from '../ward_calendar/model.js';
import { verify } from '../simulation/audit.js';
import { patientMetrics, wardMetrics, summary, queueArea } from '../patient_flow/metrics.js';
import { canonical, load, Invalid } from './values.js';

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function contents(scenario, result) {
  const audit = verify(scenario, result, true);
  const files = {
    'scenario.json': canonical(scenario.export()),
    'result.json': canonical(result),
    'audit.json': canonical(audit),
    'patients.csv': csv(patientMetrics(scenario, result)),
    'wards.csv': csv(wardMetrics(scenario, result)),
    'summary.json': canonical({
      by_specialty: summary(scenario, result),
      by_accessibility: summary(scenario, result, 'accessible'),
      queue: queueArea(result)
    })
  };
  const manifest = {
    version: 1,
    input_digest: scenario.fingerprint,
    result_digest: result.result_digest,
    source: 'local_synthetic_scenario',
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, checksum(body)]))
  };
  return {
    ...files,
    'manifest.json': canonical(manifest)
  };
}

export function csv(rows) {
  if (!rows.length) {
    return '';
  }
  const columns = Object.keys(rows[0]).sort();
  function cell(value) {
    if (value === null || value === undefined) {
      return '';
    }
    const text = typeof value === 'object' ? canonical(value) : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\n') + '\n';
}

export function exportArchive(scenario, result, directory) {
  if (existsSync(directory)) {
    throw new Invalid('archive destination exists');
  }
  const files = contents(scenario, result);
  mkdirSync(dirname(directory), { recursive: true });
  const stage = mkdtempSync(join(dirname(directory), '.ward-archive-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(stage, name), body, { flag: 'wx' });
    }
    inspectArchive(stage);
    renameSync(stage, directory);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return inspectArchive(directory);
}

export function inspectArchive(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Invalid('regular archive directory required');
  }
  const manifest = load(join(directory, 'manifest.json'));
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object') {
    throw new Invalid('invalid archive manifest');
  }
  const expected = [...Object.keys(manifest.files), 'manifest.json'].sort();
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected)) {
    throw new Invalid('archive file set mismatch');
  }
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (basename(name) !== name || name === '.' || name === '..') {
      throw new Invalid('archive path traversal');
    }
    const path = join(directory, name);
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 200000000) {
      throw new Invalid('invalid archive file');
    }
    if (checksum(readFileSync(path)) !== hash) {
      throw new Invalid('archive checksum mismatch');
    }
  }
  const scenario = new Scenario(load(join(directory, 'scenario.json')));
  const result = load(join(directory, 'result.json'));
  for (const [name, body] of Object.entries(contents(scenario, result))) {
    if (readFileSync(join(directory, name), 'utf8') !== body) {
      throw new Invalid('archive semantic replay mismatch');
    }
  }
  return {
    valid: true,
    files: expected.length,
    result_digest: result.result_digest
  };
}
