import { extendedQuery } from './simulation/report-query.js';
import { reportPlan, verifyReport } from './simulation/report.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateDesign } from './comparison/design.js';
import { blockedDemand, eventWorkload, horizonRemainders, warmup, invariantDetails } from './simulation/diagnostics.js';
import { Scenario } from './ward_calendar/model.js';
import { Engine } from './simulation/engine.js';
import { verify } from './simulation/audit.js';
import { Store } from './scenarios/store.js';
import { backup, restoreBackup } from './scenarios/recovery.js';
import { exportArchive, inspectArchive, csv } from './scenarios/archive.js';
import { load, canonical, integer, fields, Invalid } from './scenarios/values.js';
import { query } from './simulation/explorer.js';
import { paired, replicate } from './comparison/paired.js';
import { closureFrontier, policyComparison, closureAttribution, noConstruction } from './comparison/frontier.js';
import { matchedAccessibility, deprivation, arrivalWindows } from './patient_flow/equity.js';
import { bedLedger, constructionEffects, windows } from './simulation/capacity-audit.js';
import { patientsFromCSV, inputProfile } from './scenarios/exchange.js';

export function demo(path) {
  const scenario = new Scenario(load(path));
  const root = mkdtempSync(join(tmpdir(), 'ward-demo-'));
  try {
    const store = new Store(join(root, 'workspace'));
    store.putScenario('renovation', scenario.export());
    const result = store.run('full', 'renovation');
    store.checkpoint('middle', 'renovation', 3);
    const resumed = store.resume('resumed', 'middle');
    if (resumed.result.result_digest !== result.result.result_digest) {
      throw new Invalid('resume differs from uninterrupted run');
    }
    store.label('approved-scenario', 'full');
    const archive = exportArchive(scenario, result.result, join(root, 'archive'));
    const saved = backup(store, join(root, 'backup'));
    const restored = restoreBackup(join(root, 'backup'), join(root, 'restored'), saved.manifest_digest);
    return {
      source: 'local_synthetic_fixture',
      input: inputProfile(scenario),
      audit: verify(scenario, result.result, true),
      counts: result.result.counts,
      queue: query(scenario, result.result, 'queue'),
      wards: query(scenario, result.result, 'ward-metrics'),
      construction: constructionEffects(scenario, result.result),
      comparison: paired(noConstruction(scenario), scenario),
      archive,
      restored,
      checkpoint_resume_identical: true,
      store_audit: store.audit()
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function number(value, name) {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) {
    throw new Invalid(name + ' requires integer text');
  }
  return Number(value);
}

function argumentsFor(argv) {
  const [command, ...parts] = argv;
  if (!command) {
    throw new Invalid('command required; use help');
  }
  return { command, parts };
}

function arity(parts, minimum, maximum = minimum) {
  if (parts.length < minimum || parts.length > maximum) {
    throw new Invalid('incorrect command argument count');
  }
}

export function execute(argv) {
  const { command, parts } = argumentsFor(argv);
  if (command === 'help') {
    return {
      commands: {
        demo: 'fixture.json',
        simulate: 'scenario.json',
        compare: 'left.json right.json',
        experiment: 'left.json right.json profile.json seed count',
        frontier: 'scenario.json closure shifts.json',
        policies: 'scenario.json',
        attribution: 'scenario.json',
        query: 'scenario.json result.json kind [options.json]',
        import: 'workspace key scenario.json',
        run: 'workspace run-key scenario-key',
        checkpoint: 'workspace checkpoint-key scenario-key steps',
        resume: 'workspace run-key checkpoint-key',
        label: 'workspace label run-key',
        audit: 'workspace',
        archive: 'scenario.json result.json destination',
        'verify-archive': 'directory',
        backup: 'workspace destination',
        restore: 'backup destination manifest-digest',
        'csv-demand': 'scenario.json patients.csv destination.json'
      }
    };
  }
  if (command === 'demo') {
    arity(parts, 1);
    return demo(parts[0]);
  }
  if (command === 'simulate') {
    arity(parts, 1);
    const scenario = new Scenario(load(parts[0]));
    const result = new Engine(scenario).run();
    verify(scenario, result, true);
    return result;
  }
  if (command === 'compare') {
    arity(parts, 2);
    return paired(new Scenario(load(parts[0])), new Scenario(load(parts[1])));
  }
  if (command === 'experiment') {
    arity(parts, 5);
    return replicate(new Scenario(load(parts[0])), new Scenario(load(parts[1])), load(parts[2]), number(parts[3], 'seed'), number(parts[4], 'count'));
  }
  if (command === 'design') {
    arity(parts, 2);
    return evaluateDesign(new Scenario(load(parts[0])), load(parts[1]));
  }
  if (command === 'report-plan') {
    arity(parts, 3);
    const scenario = new Scenario(load(parts[0]));
    const result = load(parts[1]);
    const report = reportPlan(scenario, result, load(parts[2]));
    verifyReport(scenario, result, report);
    return report;
  }
  if (command === 'frontier') {
    arity(parts, 3);
    return closureFrontier(new Scenario(load(parts[0])), parts[1], load(parts[2]));
  }
  if (command === 'policies' || command === 'attribution') {
    arity(parts, 1);
    const scenario = new Scenario(load(parts[0]));
    return command === 'policies' ? policyComparison(scenario) : closureAttribution(scenario);
  }
  if (command === 'query') {
    arity(parts, 3, 4);
    const scenario = new Scenario(load(parts[0]));
    const result = load(parts[1]);
    verify(scenario, result);
    return extendedQuery(scenario, result, parts[2], parts[3] ? load(parts[3]) : {});
  }
  if (command === 'archive') {
    arity(parts, 3);
    return exportArchive(new Scenario(load(parts[0])), load(parts[1]), parts[2]);
  }
  if (command === 'verify-archive') {
    arity(parts, 1);
    return inspectArchive(parts[0]);
  }
  if (command === 'restore') {
    arity(parts, 3);
    return restoreBackup(parts[0], parts[1], parts[2]);
  }
  if (command === 'csv-demand') {
    arity(parts, 3);
    const stat = lstatSync(parts[1]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50000000) {
      throw new Invalid('bounded regular CSV required');
    }
    const scenario = patientsFromCSV(new Scenario(load(parts[0])), readFileSync(parts[1], 'utf8'));
    writeFileSync(parts[2], canonical(scenario.export()), { flag: 'wx' });
    return inputProfile(scenario);
  }
  const counts = {
    import: 3,
    run: 3,
    checkpoint: 4,
    resume: 3,
    label: 3,
    audit: 1,
    backup: 2
  };
  if (!Object.hasOwn(counts, command)) {
    throw new Invalid('unknown command');
  }
  arity(parts, counts[command]);
  const store = new Store(parts[0]);
  if (command === 'import') {
    return store.putScenario(parts[1], load(parts[2]));
  }
  if (command === 'run') {
    return store.run(parts[1], parts[2]);
  }
  if (command === 'checkpoint') {
    return store.checkpoint(parts[1], parts[2], number(parts[3], 'steps'));
  }
  if (command === 'resume') {
    return store.resume(parts[1], parts[2]);
  }
  if (command === 'label') {
    return store.label(parts[1], parts[2]);
  }
  if (command === 'backup') {
    return backup(store, parts[1]);
  }
  return store.audit();
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = execute(argv);
    process.stdout.write(canonical(result) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(canonical({ error: error.message, type: error.name }) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
