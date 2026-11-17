// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and may add
// pre-token protocols below the watchlist floor: the early rows the radar exists to find. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed into
// the ranked board.
//
// Implied value follows only from the snapshot's own figures, in two steps.
//
// Step one is the market's own yardstick. Every live-token protocol in the snapshot carries a market
// cap against its TVL, so for each category the model takes the median market-cap-to-TVL multiple of
// that category's tokenized protocols (ratios winsorized to [0.005, 5] so one broken record cannot
// bend a category), then shrinks it toward the snapshot-wide median with a prior weight of
// COMP_PRIOR_WEIGHT tokenized peers: a category with many peers mostly speaks for itself, a category
// with none falls back to the market-wide multiple. The applied multiple is clamped to
// [MULTIPLE_FLOOR, MULTIPLE_CAP]. On this snapshot the categories genuinely differ (Dexs peers carry
// a median near 0.34, Lending near 0.13, Liquid Staking near 0.03), so a flat multiple would overprice
// staking and lending protocols and underprice exchanges. No protocol name is ever special-cased: a row's category is the
// only thing that chooses its multiple, and the same function scores every row.
//
// Step two adjusts that base for the protocol itself:
//
//   base       = tvl_usd x category_multiple
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied    = max(1, round(base x growthMult x maturity))
//
// The constants are the model's, stated in the dashboard and changeable in the model sandbox; each row
// also carries the exact multiple the board applied to it, so the page can recompute every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  comp_prior_weight: number;
  multiple_floor: number;
  multiple_cap: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.169,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  comp_prior_weight: 5,
  multiple_floor: 0.02,
  multiple_cap: 1.5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's comp set: how many tokenized peers, and the multiple the board applies. */
export interface CategoryMultiple {
  peers: number;
  median: number;
  applied: number;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  category_multiples: Record<string, CategoryMultiple>;
  global_multiple: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Winsorize one market-cap-to-TVL ratio so a single broken record cannot bend a category. */
function winsorize(ratio: number): number {
  return Math.min(5, Math.max(0.005, ratio));
}

/**
 * The comp table: for every category, the median market-cap-to-TVL multiple of its tokenized
 * protocols in this snapshot, shrunk toward the snapshot-wide median by the prior weight and
 * clamped to the model's band. Exchange (CEX) records are not comps: an exchange token's cap is
 * not a protocol launch value, and the board never ranks exchanges either.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { table: Map<string, CategoryMultiple>; globalMultiple: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0 || p.category === 'CEX') continue;
    const ratio = winsorize(p.mcap_usd / p.tvl_usd);
    all.push(ratio);
    if (p.category !== null) {
      const list = byCategory.get(p.category) ?? [];
      list.push(ratio);
      byCategory.set(p.category, list);
    }
  }
  const globalMultiple = all.length > 0 ? median(all) : model.base_multiple;
  const clampMultiple = (v: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, v));
  const table = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of byCategory) {
    const med = median(ratios);
    const applied = clampMultiple((ratios.length * med + model.comp_prior_weight * globalMultiple) / (ratios.length + model.comp_prior_weight));
    table.set(category, { peers: ratios.length, median: med, applied });
  }
  return { table, globalMultiple };
}

/** The multiple one protocol's category earns; the clamped market-wide median when it has no peers. */
export function multipleFor(category: string | null, table: Map<string, CategoryMultiple>, globalMultiple: number, model: ModelConstants = MODEL): number {
  if (category !== null) {
    const entry = table.get(category);
    if (entry !== undefined) return entry.applied;
  }
  return Math.min(model.multiple_cap, Math.max(model.multiple_floor, globalMultiple));
}

/** The growth and maturity multipliers and the implied value one protocol gets under a multiple. */
export function impliedValueWithMultiple(protocol: SnapshotProtocol, asOf: string, model: ModelConstants, multiple: number): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/** The three multipliers and the implied value one protocol gets under the flat fallback multiple. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  return impliedValueWithMultiple(protocol, asOf, model, model.base_multiple);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const { table, globalMultiple } = categoryMultiples(snapshot, model);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a replacement
  // for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    // The applied multiple is rounded to the precision the row carries, so the dashboard's own
    // recompute of a row from data.js lands on the board's number to the dollar.
    const multiple = round4(multipleFor(p.category, table, globalMultiple, model));
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValueWithMultiple(p, snapshot.as_of, model, multiple);
    return { p, implied, growthPct, growthMult, maturityMult, age, multiple };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: round4(s.multiple),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step rendered as one line of the plan: the action, then its cost, then its time. */
export function stepText(step: FarmStep): string {
  const parts = [step.text, `Cost: ${step.cost}.`, `Time: ${step.time}.`];
  let line = parts.join(' ');
  if (line.length > 600) line = `${line.slice(0, 596)}...`;
  if (line.length < 20) line = `${line} Keep the position open and recheck the protocol's own page.`;
  return line;
}

/** Where a protocol mainly lives: its first named chain, or a neutral phrase when it names none. */
function homeChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Position sizes by protocol scale: the bigger the protocol, the more a qualifying position costs. */
const CAPITAL_TIERS: [number, number][] = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

function capitalFor(p: SnapshotProtocol): number {
  for (const [floor, capital] of CAPITAL_TIERS) if (p.tvl_usd >= floor) return capital;
  return 50;
}

/** Holding windows by age: a young protocol needs a longer window to count in two snapshots. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}

type PlanWords = (name: string, capital: number, chain: string) => string;

/** Category wording for the plan's core action, in precedence order: the first match speaks. */
const ACTION_RULES: { match: string[]; say: PlanWords }[] = [
  { match: ['lend', 'cdp', 'collateral'], say: (n, x, ch) => `Supply $${x} of USDC to ${n} on ${ch} and keep the position open.` },
  { match: ['dex', 'yield', 'leveraged farm'], say: (n, x, ch) => `Provide $${x} of liquidity to ${n}'s main pool on ${ch} and keep the position open.` },
  { match: ['bridge'], say: (n, x, ch) => `Bridge $${x} of USDC to ${ch} through ${n} and use the bridged funds in its app.` },
  { match: ['staking', 'restak'], say: (n, x) => `Stake $${x} of the chain's staking asset through ${n} and keep the receipt.` },
  { match: ['perpetual', 'derivative'], say: (n, x) => `Deposit $${x} of USDC as margin on ${n} and open one small hedge.` },
  { match: ['prediction'], say: (n, x) => `Fund $${x} and place one market position on ${n}.` },
  { match: ['curator', 'allocator'], say: (n, x, ch) => `Deposit $${x} into a ${n} vault on ${ch} and keep the shares.` },
  { match: ['stable'], say: (n, x, ch) => `Mint or deposit $${x} of the stable asset through ${n} on ${ch}.` },
  { match: ['rwa'], say: (n, x, ch) => `Mint $${x} of the protocol's yield asset on ${ch} and hold it.` },
  { match: ['insurance'], say: (n, x, ch) => `Buy $${x} of cover from ${n} on ${ch} and keep the policy.` },
  { match: ['basis'], say: (n, x, ch) => `Deposit $${x} of USDC into ${n}'s basis vault on ${ch} and keep the shares.` },
  { match: ['payments'], say: (n, x, ch) => `Route a $${x} payment through ${n} on ${ch} and keep the balance parked there.` },
  { match: ['governance'], say: (n, x, ch) => `Deposit $${x} into ${n}'s incentive program on ${ch} and keep the position open.` },
];

/** The plan's core action for one protocol, from its category alone. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.match.some((m) => c.includes(m))) return rule.say(p.name, capital, chain);
  }
  if (c === 'chain') return `Bridge $${capital} of USDC to ${p.name} and use it in the chain's own apps.`;
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/** Category wording for the weekly qualifying action, in the same precedence order. */
const WEEKLY_RULES: { match: string[]; say: (name: string) => string }[] = [
  { match: ['lend', 'cdp', 'collateral'], say: (n) => `Make one qualifying action each week, such as a small borrow against the position or a partial repay on ${n}.` },
  { match: ['dex'], say: (n) => `Make one qualifying action each week, such as a small swap through ${n} or a rebalance of the pool position.` },
  { match: ['curator', 'allocator'], say: (n) => `Make one qualifying action each week, such as a small top-up deposit or a move between ${n} vaults.` },
  { match: ['bridge'], say: (n) => `Make one qualifying action each week, such as a small bridge transfer through ${n} in either direction.` },
  { match: ['staking', 'restak'], say: (n) => `Make one qualifying action each week, such as a small additional stake or a claim of staking rewards on ${n}.` },
  { match: ['perpetual', 'derivative'], say: (n) => `Make one qualifying action each week, such as one small hedged trade on ${n} that you close the same day.` },
  { match: ['rwa', 'stable'], say: (n) => `Make one qualifying action each week, such as a small additional mint or a partial redeem on ${n}.` },
];

/** The weekly qualifying action, matched to how the category's users actually stay active. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  for (const rule of WEEKLY_RULES) {
    if (rule.match.some((m) => c.includes(m))) return rule.say(p.name);
  }
  return `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote on ${p.name}.`;
}

/**
 * One protocol's farm plan: six steps, each an action with its cost and its time. Every word of it
 * derives from the protocol's own record (category, chains, TVL, age); no plan is written by hand
 * for a named protocol.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = homeChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: `Start from a fresh wallet funded only with what this one farm needs, and keep its seed phrase written down offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Leave the position untouched for at least ${hold} days, so it shows up in more than one weekly snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `When you are ready to exit, check the protocol's own points or rewards page first, and claim only through the link published there.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Log the wallet address, the dates and every transaction hash, so the position can be repeated or unwound later.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The dashboard's Live token view: protocols that already trade, biggest market cap first. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const byCapThenTvl = (a: SnapshotProtocol, b: SnapshotProtocol): number =>
    (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd;
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  return live.sort(byCapThenTvl).slice(0, LIVE_ROWS).map((p) => {
    const { slug, name, category, chains, tvl_usd, mcap_usd, change_7d } = p;
    return { slug, name, category, chains, tvl_usd, mcap_usd, change_7d };
  });
}

/** A board row squeezed for data.js: the page regenerates the farm plan from these same fields. */
export function radarRow(row: BoardRow): RadarRow {
  const { rank, slug, name, category, chains, tvl_usd, change_7d, mcap_usd, listed_at, age_days, implied_value_usd } = row;
  const { base_multiple, growth_multiplier, maturity_multiplier } = row.model;
  return { rank, slug, name, category, chains, tvl_usd, change_7d, mcap_usd, listed_at, age_days, implied_value_usd, base_multiple, growth_multiplier, maturity_multiplier };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { table, globalMultiple } = categoryMultiples(snapshot, model);
  const category_multiples: Record<string, CategoryMultiple> = {};
  for (const [category, entry] of table) {
    category_multiples[category] = { peers: entry.peers, median: round4(entry.median), applied: round4(entry.applied) };
  }
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    category_multiples,
    global_multiple: round4(globalMultiple),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** Read one optional text field: the string itself, or null when it is absent or not a string. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Read one optional measure: the finite number itself, or null when it is absent or not finite. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse and validate the sealed snapshot; anything off-shape is a SnapshotError, never a guess. */
export function parseSnapshot(text: string): Snapshot {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new SnapshotError('the snapshot is not valid JSON');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new SnapshotError('the snapshot is not a JSON object');
  }
  const head = doc as Record<string, unknown>;
  const asOf = textOrNull(head.as_of);
  if (asOf === null || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new SnapshotError('the snapshot carries no as_of date');
  const source = textOrNull(head.source);
  if (source === null) throw new SnapshotError('the snapshot carries no source');
  const floor = head.floor_usd;
  if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor <= 0) {
    throw new SnapshotError('the snapshot carries no usable floor_usd');
  }
  if (!Array.isArray(head.protocols)) throw new SnapshotError('the snapshot carries no protocols array');
  if (!Array.isArray(head.watchlist) || head.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('the snapshot carries no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = head.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`protocol ${i} in the snapshot is not an object`);
    }
    const p = entry as Record<string, unknown>;
    const slug = textOrNull(p.slug);
    const name = textOrNull(p.name);
    const tvl = numberOrNull(p.tvl_usd);
    if (slug === null || name === null || tvl === null) {
      throw new SnapshotError(`protocol ${i} in the snapshot lacks a slug, a name or a TVL`);
    }
    const chains = Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [];
    return {
      slug,
      name,
      category: textOrNull(p.category),
      chains,
      tvl_usd: tvl,
      change_7d: numberOrNull(p.change_7d),
      mcap_usd: numberOrNull(p.mcap_usd),
      listed_at: textOrNull(p.listed_at),
      gecko_id: textOrNull(p.gecko_id),
      symbol: textOrNull(p.symbol),
    };
  });
  return { as_of: asOf, source, floor_usd: floor, protocols, watchlist: head.watchlist as string[] };
}

/**
 * The gate over a finished board, as a sentence about the first flaw found, or null when the board
 * is sound: full watchlist coverage, ranks 1..n in order, values descending, a real spread of
 * values, and every row carrying a usable plan and a positive whole-dollar value.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const covered = new Set(board.map((r) => r.slug));
  const absent = snapshot.watchlist.filter((s) => !covered.has(s));
  if (absent.length > 0) {
    return `the board leaves out ${absent.length} watchlist slug${absent.length === 1 ? '' : 's'}: ${absent.slice(0, 5).join(', ')}`;
  }
  const ordered = board.map((r) => r.rank).sort((a, b) => a - b);
  const badRank = ordered.findIndex((rank, i) => rank !== i + 1);
  if (badRank >= 0) return `rank ${badRank + 1} reads ${ordered[badRank]} instead`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} sits above row ${i} while carrying the smaller implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `every one of the ${board.length} rows carries the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug} carries ${row.farm_steps.length} farm steps`;
    }
    const badStep = row.farm_steps.find((s) => s.length < 20 || s.length > 600);
    if (badStep !== undefined) return `${row.slug} carries a farm step of ${badStep.length} characters`;
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} carries implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** data.js, the dashboard's whole dataset as one assignment: no fetch, no network, no build step. */
export function dataScript(radar: RadarData): string {
  return ['window.RADAR=', JSON.stringify(radar), ';\n'].join('');
}
