import { existsSync, mkdirSync, readdirSync, lstatSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Store } from './store.js';
import { digest, canonical, load, Invalid } from './values.js';

export function backup(store, destination) {
  const audit = store.audit();
  if (existsSync(destination)) {
    throw new Invalid('backup destination exists');
  }
  mkdirSync(destination, { recursive: true });
  const files = {};
  try {
    for (const section of ['scenarios', 'runs', 'checkpoints', 'labels']) {
      mkdirSync(join(destination, section));
      for (const key of store.keys(section)) {
        const name = section + '/' + key + '.json';
        const body = load(store.path(section, key));
        files[name] = digest(body);
        copyFileSync(store.path(section, key), join(destination, name));
      }
    }
    const manifest = {
      version: 1,
      audit,
      files
    };
    writeFileSync(join(destination, 'backup.json'), canonical(manifest), { flag: 'wx' });
    const restored = new Store(destination);
    if (digest(restored.audit()) !== digest(audit)) {
      throw new Invalid('backup semantic audit mismatch');
    }
    return {
      manifest_digest: digest(manifest),
      files: Object.keys(files).length,
      audit
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function restoreBackup(source, destination, manifestDigest) {
  const manifest = load(join(source, 'backup.json'));
  if (manifest.version !== 1 || digest(manifest) !== manifestDigest) {
    throw new Invalid('backup manifest checksum mismatch');
  }
  const actual = [];
  for (const section of ['scenarios', 'runs', 'checkpoints', 'labels']) {
    const path = join(source, section);
    if (lstatSync(path).isSymbolicLink()) {
      throw new Invalid('backup section symlink');
    }
    for (const name of readdirSync(path)) {
      actual.push(section + '/' + name);
    }
  }
  if (digest(actual.sort()) !== digest(Object.keys(manifest.files).sort())) {
    throw new Invalid('backup file set mismatch');
  }
  for (const [name, signature] of Object.entries(manifest.files)) {
    if (!/^(scenarios|runs|checkpoints|labels)\/[A-Za-z0-9][A-Za-z0-9_.:-]*\.json$/.test(name)) {
      throw new Invalid('backup file name unsafe');
    }
    if (digest(load(join(source, name))) !== signature) {
      throw new Invalid('backup content checksum mismatch');
    }
  }
  if (existsSync(destination)) {
    throw new Invalid('restore destination exists');
  }
  mkdirSync(destination, { recursive: true });
  try {
    for (const name of Object.keys(manifest.files)) {
      mkdirSync(dirname(join(destination, name)), { recursive: true });
      copyFileSync(join(source, name), join(destination, name));
    }
    const restored = new Store(destination);
    const audit = restored.audit();
    if (digest(audit) !== digest(manifest.audit)) {
      throw new Invalid('restore semantic audit mismatch');
    }
    return {
      restored: true,
      audit
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
