// Stack invariants compose.sh checks around a run:
//   docker compose --profile app config --format json | node stack-guard.mjs mounts
//     only the import service binds the Section 1 directory, read-only at /seed; the worker binds nothing.
//     Prints the host path of the Section 1 file the import service loads.
//   node stack-guard.mjs stat FILE
//     size and mtime of FILE, FILE-wal and FILE-shm, compared before and after the run (never modified)
import { readFileSync, statSync } from 'node:fs';

const [mode, file] = process.argv.slice(2);

if (mode === 'mounts') {
  const { services } = JSON.parse(readFileSync(0, 'utf8'));
  const seed = (services.import?.volumes ?? []).find((v) => v.type === 'bind' && v.target === '/seed');
  const errors = seed?.read_only ? [] : ['the import service must bind the Section 1 directory read-only at /seed'];
  const within = (a, b) => a === b || a.startsWith(`${b.replace(/\/+$/, '')}/`);
  for (const [name, s] of Object.entries(services)) {
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind' || v === seed) continue;
      if (name === 'worker') errors.push(`worker binds ${v.source}`);
      else if (seed && (within(seed.source, v.source) || within(v.source, seed.source))) errors.push(`${name} binds ${v.source}`);
    }
  }
  if (errors.length) {
    console.error(`docker-compose.yml: ${errors.join('; ')}`);
    process.exit(1);
  }
  console.log(`${seed.source.replace(/\/+$/, '')}/${services.import.environment?.SECTION1_DB_FILE || 'leadmaker.db'}`);
} else if (mode === 'stat' && file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const s = statSync(f);
      console.log(`${f} ${s.size} ${s.mtimeMs}`);
    } catch {
      console.log(`${f} absent`);
    }
  }
} else {
  console.error('usage: stack-guard.mjs mounts | stat FILE');
  process.exit(2);
}
