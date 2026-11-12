import { fields } from '../scenarios/values.js';
import { query } from './explorer.js';
import { matchedAccessibility, deprivation, arrivalWindows } from '../patient_flow/equity.js';
import { bedLedger, constructionEffects, windows } from './capacity-audit.js';
import { blockedDemand, eventWorkload, horizonRemainders, warmup, invariantDetails } from './diagnostics.js';

export function extendedQuery(scenario, result, kind, options = {}) {
  const withoutOptions = ['blocked-demand', 'event-workload', 'unfinished', 'invariants', 'bed-ledger', 'construction-effects', 'equity'];
  if (withoutOptions.includes(kind)) {
    fields(options, []);
  }
  if (['capacity-windows', 'arrival-windows'].includes(kind)) {
    fields(options, [], ['width']);
  }
  if (kind === 'warmup') {
    fields(options, [], ['cutoff']);
  }
  if (kind === 'deprivation') {
    fields(options, [], ['threshold']);
  }
  if (kind === 'blocked-demand') {
    return blockedDemand(scenario, result);
  }
  if (kind === 'event-workload') {
    return eventWorkload(result);
  }
  if (kind === 'unfinished') {
    return horizonRemainders(scenario, result);
  }
  if (kind === 'warmup') {
    return warmup(scenario, result, options.cutoff ?? 0);
  }
  if (kind === 'invariants') {
    return invariantDetails(scenario, result);
  }
  if (kind === 'bed-ledger') {
    return bedLedger(scenario, result);
  }
  if (kind === 'construction-effects') {
    return constructionEffects(scenario, result);
  }
  if (kind === 'capacity-windows') {
    return windows(scenario, result, options.width ?? Math.min(24, result.horizon));
  }
  if (kind === 'arrival-windows') {
    return arrivalWindows(scenario, result, options.width ?? Math.min(24, result.horizon));
  }
  if (kind === 'equity') {
    return matchedAccessibility(scenario, result);
  }
  if (kind === 'deprivation') {
    return deprivation(scenario, result, options.threshold ?? 0);
  }
  return query(scenario, result, kind, options);
}

