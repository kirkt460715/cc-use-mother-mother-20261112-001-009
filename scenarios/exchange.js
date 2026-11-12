import { Scenario } from '../ward_calendar/model.js';
import { Invalid, integer } from './values.js';

export function parseCSV(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 50000000) {
    throw new Invalid('bounded CSV input required');
  }
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        value += char;
      }
      continue;
    }
    if (afterQuote && ![',', '\n', '\r'].includes(char)) {
      throw new Invalid('characters after closing CSV quote');
    }
    if (char === '"') {
      if (value || afterQuote) {
        throw new Invalid('quote inside unquoted CSV field');
      }
      quoted = true;
    } else if (char === ',') {
      row.push(value);
      value = '';
      afterQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      afterQuote = false;
    } else {
      value += char;
    }
    if (rows.length > 100001) {
      throw new Invalid('CSV row bound exceeded');
    }
  }
  if (quoted) {
    throw new Invalid('unterminated CSV quote');
  }
  if (value || row.length || afterQuote) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

export function patientsFromCSV(scenario, content) {
  const rows = parseCSV(content);
  const header = rows.shift();
  const columns = ['id', 'arrival', 'stay', 'specialty', 'accessible', 'priority', 'patience'];
  if (!header || new Set(header).size !== header.length || header.length !== columns.length || header.some(key => !columns.includes(key))) {
    throw new Invalid('patient CSV header mismatch');
  }
  const patients = [];
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Invalid('patient CSV record width mismatch');
    }
    const patient = Object.fromEntries(header.map((key, index) => [key, row[index]]));
    for (const key of ['arrival', 'stay', 'priority', 'patience']) {
      if (!/^(0|[1-9][0-9]*)$/.test(patient[key])) {
        throw new Invalid('CSV numeric fields require canonical nonnegative integers');
      }
      patient[key] = Number(patient[key]);
    }
    if (!['true', 'false'].includes(patient.accessible)) {
      throw new Invalid('CSV accessibility requires true or false');
    }
    patient.accessible = patient.accessible === 'true';
    patients.push(patient);
  }
  const document = scenario.export();
  document.patients = patients;
  return new Scenario(document);
}

export function inputProfile(scenario) {
  const specialty = new Map();
  for (const patient of scenario.patients.values()) {
    if (!specialty.has(patient.specialty)) {
      specialty.set(patient.specialty, {
        specialty: patient.specialty,
        arrivals: 0,
        accessible: 0,
        requested_care_time: 0,
        minimum_arrival: scenario.horizon,
        maximum_arrival: 0
      });
    }
    const row = specialty.get(patient.specialty);
    row.arrivals += 1;
    row.accessible += Number(patient.accessible);
    row.requested_care_time += patient.stay;
    row.minimum_arrival = Math.min(row.minimum_arrival, patient.arrival);
    row.maximum_arrival = Math.max(row.maximum_arrival, patient.arrival);
  }
  return {
    horizon: scenario.horizon,
    input_digest: scenario.fingerprint,
    wards: scenario.wards.size,
    closures: scenario.closures.size,
    patients: scenario.patients.size,
    specialties: [...specialty.values()].sort((a, b) => a.specialty.localeCompare(b.specialty))
  };
}
