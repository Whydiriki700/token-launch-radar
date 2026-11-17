// Token Radar entrypoint (Node 22, standard library only).
//
// Flow: read the sealed DefiLlama snapshot, score it with the model in lib/model.ts, refuse the
// board if the gate in the model finds a flaw, then publish board.json, data.js, the static
// dashboard/ and screenshots/ folders, and finally dossier.json, which the vendored make.fun
// library builds from the finished output folder (the scorer rebuilds it and compares bytes, so
// it must be written last and from the same bytes).
//
// Input comes from /input/snapshot.json in the grader, or --input <file|dir> anywhere else.
// Output goes to --output, else $MAKEFUN_OUTPUT_DIR, else /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

// The scorer's caps for the dossier (reference/gate.json): text is trimmed to its cap, the rest refuse.
const DOSSIER_CAPS = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** One `--name value` or `--name=value` argument, else the fallback. */
function flag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const pair = args.find((a) => a.startsWith(`--${name}=`));
  if (pair !== undefined) return pair.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1]! : fallback;
}

function die(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

const inputPath = flag('input', '/input');
const snapshotFile = inputPath.endsWith('.json') ? inputPath : join(inputPath, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  die(`no snapshot at ${snapshotFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const flaw = boardIssue(board, snapshot);
if (flaw !== null) die(`the model wrote a board the gate refuses: ${flaw}`, 1);

/** Copy a folder's regular files (dotfiles skipped) into the output; returns the names copied. */
function publish(folder: string, into: string): string[] {
  const names: string[] = [];
  if (!existsSync(folder)) return names;
  mkdirSync(into, { recursive: true });
  for (const name of readdirSync(folder)) {
    if (name.startsWith('.')) continue;
    const from = join(folder, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(into, name));
    names.push(name);
  }
  return names;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));
const dashFiles = publish(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = publish(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  die(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) die(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
}

// Written last, from the finished output, exactly as the scorer will rebuild it.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, DOSSIER_CAPS));

const money = (n: number): string => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: top of the board: ${board.slice(0, 3).map((r) => `${r.name} ${money(r.implied_value_usd)}`).join(', ')}\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashFiles.length} files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
