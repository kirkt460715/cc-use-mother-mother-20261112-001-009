import { verify } from './audit.js';
import { extendedQuery } from './report-query.js';
import { array, fields, id, digest, Invalid } from '../scenarios/values.js';

export function reportPlan(scenario, result, definition) {
  fields(definition, ['version', 'operations']);
  if (definition.version !== 1) {
    throw new Invalid('unsupported report plan version');
  }
  array(definition.operations, 'operations', 100);
  const identities = new Set();
  for (const operation of definition.operations) {
    fields(operation, ['id', 'kind', 'options']);
    id(operation.id, 'operation id');
    if (identities.has(operation.id)) {
      throw new Invalid('duplicate report operation');
    }
    identities.add(operation.id);
    if (typeof operation.kind !== 'string') {
      throw new Invalid('report kind must be text');
    }
    if (!operation.options || typeof operation.options !== 'object' || Array.isArray(operation.options)) {
      throw new Invalid('report options must be object');
    }
  }
  verify(scenario, result);
  const rows = [];
  for (const operation of definition.operations) {
    const output = extendedQuery(scenario, result, operation.kind, operation.options);
    rows.push({
      id: operation.id,
      kind: operation.kind,
      output,
      output_digest: digest(output)
    });
  }
  const body = {
    version: 1,
    input_digest: scenario.fingerprint,
    result_digest: result.result_digest,
    definition,
    definition_digest: digest(definition),
    rows,
    complete: true
  };
  return {
    ...body,
    report_digest: digest(body)
  };
}

export function verifyReport(scenario, result, report) {
  const { report_digest, ...body } = report;
  if (digest(body) !== report_digest) {
    throw new Invalid('report checksum mismatch');
  }
  if (report.input_digest !== scenario.fingerprint || report.result_digest !== result.result_digest) {
    throw new Invalid('report source binding mismatch');
  }
  if (digest(reportPlan(scenario, result, report.definition)) !== digest(report)) {
    throw new Invalid('report operation replay mismatch');
  }
  return {
    valid: true,
    operations: report.rows.length
  };
}

export function compactSummary(scenario, result) {
  const definition = {
    version: 1,
    operations: [
      { id: 'capacity', kind: 'capacity-summary', options: {} },
      { id: 'wards', kind: 'ward-metrics', options: {} },
      { id: 'queues', kind: 'queue', options: {} },
      { id: 'service', kind: 'service-levels', options: { thresholds: [0, Math.min(6, scenario.horizon)] } },
      { id: 'unfinished', kind: 'unfinished', options: {} },
      { id: 'equity', kind: 'equity', options: {} },
      { id: 'invariants', kind: 'invariants', options: {} }
    ]
  };
  return reportPlan(scenario, result, definition);
}
