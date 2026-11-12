import { mkdirSync, existsSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, lstatSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Scenario } from '../ward_calendar/model.js';
import { Engine } from '../simulation/engine.js';
import { verify } from '../simulation/audit.js';
import { capture, restore } from '../simulation/checkpoint.js';
import { canonical, digest, id, load, integer, Conflict, Invalid } from './values.js';

export class Store {
  constructor(directory) {
    this.root = resolve(directory);
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) {
      throw new Invalid('store cannot be symlink');
    }
    mkdirSync(this.root, { recursive: true });
    for (const section of ['scenarios', 'runs', 'checkpoints', 'labels']) {
      mkdirSync(join(this.root, section), { recursive: true });
      if (lstatSync(join(this.root, section)).isSymbolicLink()) {
        throw new Invalid('store section cannot be symlink');
      }
    }
  }

  path(section, key) {
    if (!['scenarios', 'runs', 'checkpoints', 'labels'].includes(section)) {
      throw new Invalid('unknown store section');
    }
    id(key, 'store key');
    return join(this.root, section, key + '.json');
  }

  atomic(section, key, body) {
    const target = this.path(section, key);
    const lock = target + '.lock';
    let descriptor;
    try {
      descriptor = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Conflict('store key is locked; inspect interrupted writer');
      }
      throw error;
    }
    const stage = target + '.staging';
    try {
      if (existsSync(target)) {
        const old = load(target);
        if (digest(old) !== digest(body)) {
          throw new Conflict('immutable store identity already binds different content');
        }
        return old;
      }
      const output = openSync(stage, 'wx', 0o600);
      try {
        writeFileSync(output, canonical(body));
        fsyncSync(output);
      } finally {
        closeSync(output);
      }
      renameSync(stage, target);
      return body;
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      rmSync(stage, { force: true });
      rmSync(lock, { force: true });
    }
  }

  putScenario(key, document) {
    const scenario = new Scenario(document);
    const body = {
      version: 1,
      document: scenario.export(),
      input_digest: scenario.fingerprint
    };
    return this.atomic('scenarios', key, body);
  }

  scenario(key) {
    const body = load(this.path('scenarios', key));
    const scenario = new Scenario(body.document);
    if (body.version !== 1 || scenario.fingerprint !== body.input_digest) {
      throw new Invalid('stored scenario integrity failure');
    }
    return scenario;
  }

  run(key, scenarioKey) {
    const scenario = this.scenario(scenarioKey);
    const result = new Engine(scenario).run();
    verify(scenario, result, true);
    return this.atomic('runs', key, {
      scenario: scenarioKey,
      input_digest: scenario.fingerprint,
      result
    });
  }

  result(key) {
    const body = load(this.path('runs', key));
    const scenario = this.scenario(body.scenario);
    if (scenario.fingerprint !== body.input_digest) {
      throw new Invalid('run source binding mismatch');
    }
    verify(scenario, body.result);
    return body;
  }

  checkpoint(key, scenarioKey, steps) {
    integer(steps, 'steps', 0, 1000000);
    const scenario = this.scenario(scenarioKey);
    const engine = new Engine(scenario);
    for (let step = 0; step < steps && !engine.done; step += 1) {
      engine.step();
    }
    return this.atomic('checkpoints', key, {
      scenario: scenarioKey,
      checkpoint: capture(engine)
    });
  }

  resume(key, checkpointKey) {
    const saved = load(this.path('checkpoints', checkpointKey));
    const scenario = this.scenario(saved.scenario);
    const result = restore(scenario, saved.checkpoint).run();
    verify(scenario, result, true);
    return this.atomic('runs', key, {
      scenario: saved.scenario,
      input_digest: scenario.fingerprint,
      result
    });
  }

  label(key, runKey) {
    const run = this.result(runKey);
    return this.atomic('labels', key, {
      run: runKey,
      result_digest: run.result.result_digest
    });
  }

  publication(key) {
    const body = load(this.path('labels', key));
    if (this.result(body.run).result.result_digest !== body.result_digest) {
      throw new Invalid('label result binding mismatch');
    }
    return body;
  }

  keys(section) {
    this.path(section, 'check');
    const entries = readdirSync(join(this.root, section));
    const output = [];
    for (const name of entries) {
      if (name.endsWith('.lock') || name.endsWith('.staging')) {
        throw new Conflict('interrupted store write requires inspection');
      }
      if (!name.endsWith('.json')) {
        throw new Invalid('unknown file in store section');
      }
      const key = name.slice(0, -5);
      id(key, 'stored identity');
      const stat = lstatSync(join(this.root, section, name));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Invalid('store record must be regular file');
      }
      output.push(key);
    }
    return output.sort();
  }

  audit() {
    for (const key of this.keys('scenarios')) {
      this.scenario(key);
    }
    for (const key of this.keys('runs')) {
      const body = this.result(key);
      verify(this.scenario(body.scenario), body.result, true);
    }
    for (const key of this.keys('checkpoints')) {
      const body = load(this.path('checkpoints', key));
      restore(this.scenario(body.scenario), body.checkpoint);
    }
    for (const key of this.keys('labels')) {
      this.publication(key);
    }
    return {
      valid: true,
      scenarios: this.keys('scenarios').length,
      runs: this.keys('runs').length,
      checkpoints: this.keys('checkpoints').length,
      labels: this.keys('labels').length
    };
  }
}
