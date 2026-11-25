// Token Launch Radar — model "radar-2".
//
// One sealed DefiLlama snapshot in, one ranked board out. Everything below is derived from the
// snapshot's own ten fields per protocol; no protocol name is ever special-cased and no figure
// comes from outside the file.
//
// The board ranks every protocol that records no token (no market cap, no CoinGecko id, no
// symbol), is not an exchange (CEX) and is not a versioned pool of another protocol. The house
// watchlist (TVL at or above the floor, not a wrapped/staked/bridged product) is a subset of the
// board: the floor, never the ceiling. Protocols whose token already trades are never ranked;
// the dashboard shows the largest of them apart, at the market's own values, as the peer set.
//
// Implied value — what a launch would be worth if the protocol's record stayed as it is — comes
// from comparable tokenised peers ("comps") in the same snapshot. Market cap per TVL dollar is
// wildly dispersed across DeFi (in this snapshot the middle 80% of peers span a factor of 230),
// so no single multiple is honest. For each protocol the model takes the 24 peers nearest to it
// — distance is the gap in log10 TVL, halved when the category matches — and reads off the
// kernel-weighted geometric mean of their market-cap/TVL multiples, winsorised to the peer
// set's 5th–95th percentile. The weighted quartiles of the same comps give a range, and the
// dashboard shows the range beside the point value:
//
//   base       = tvl * weightedGeometricMean(comp multiples)
//   range      = tvl * [weighted 25th, 75th percentile of comp multiples]
//   growthMult = 1 + clamp(change_7d, -60, 120) / 100 * 0.5      (seven-day TVL momentum)
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 * 0.4        (unknown age: 365 days)
//   implied    = max(1, round(base * growthMult * maturityMult))
//
// Peers whose recorded market cap is zero carry no pricing information and are excluded from
// the comp set (128 of the 144 tokenised protocols remain). The estimator is validated the way
// a sceptic would: five-fold cross-validation over the peers (folds assigned by a hash of the
// slug, so the split is deterministic and reproducible), rebuilding the comp set on four folds
// and pricing the fifth with the full formula. The dashboard publishes the result: the median
// absolute log10 error, the fold error (10 ^ that error), and the shares of held-out peers
// priced within a factor of two and of three.
//
// Launch propensity — a second, separate model — is a logistic regression over all 758
// protocols in the census. The outcome is observable for every one of them: the protocol
// already carries a token, or it records none. Features are log10(TVL) and age in years,
// standardised. For a pre-token protocol the fitted probability reads as: of the protocols
// that look like this one (this size, this age), the share that already carry a token. It is
// a cross-sectional propensity, not a dated prediction, and the dashboard says so. Its
// five-fold cross-validated Brier score is published next to the base-rate Brier score of
// guessing the census rate for everyone.
//
// Farm plans are generated per protocol from its own record: the core action follows its
// category, the capital tier follows its TVL, gas follows its first chain, the holding
// window follows its age, and every step states what it costs and how long it takes. A
// season verdict (Farm first / Farm cheap / Watch / Skip) weighs the launch propensity and
// the implied value against the plan's cash cost; capital itself is recoverable and is
// never counted as a cost.

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

export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;
const GROWTH_WEIGHT = 0.5;
const MATURITY_FLOOR = 0.6;
const MATURITY_RANGE = 0.4;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;


/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol already carries a token in DefiLlama's record. */
export function hasToken(p: SnapshotProtocol): boolean {
  return !isPreToken(p);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The house's product rule, the one that built the watchlist: a wrapped, staked or bridged
 * product of a token that already trades is not a protocol waiting on a launch of its own —
 * WBTC is Bitcoin on Ethereum, Binance staked ETH is ETH in a staking product. The board
 * applies the same rule at every size, not only above the floor: a category of Bridge,
 * Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX, a whole word
 * wrapped, staked or staking in the name, or a name that begins with an exchange's.
 */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

export function isProductOfTraded(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return true;
  return EXCHANGE_PREFIX.test(p.name);
}

/** Whether a protocol is one the board may rank: pre-token, not a product of a traded token, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !VERSIONED.test(p.name) && !isProductOfTraded(p);
}

/* ------------------------------------------------------------------ */
/* The valuation estimator: nearest-peer comps                         */
/* ------------------------------------------------------------------ */

const COMP_COUNT = 24;
const COMP_KERNEL = 1.25;
const COMP_CATEGORY_BOOST = 0.5;

/** One tokenised peer in comp form: its log10 TVL, category and log10 market-cap/TVL multiple. */
export interface CompPeer {
  slug: string;
  category: string | null;
  log_tvl: number;
  log_multiple: number;
}

/** The comp set: the usable peers plus the winsor bounds for their multiples. */
export interface PeerFit {
  peers: CompPeer[];
  peer_count: number;
  mult_lo: number;
  mult_hi: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** The comp set out of the tokenised peers: a recorded market cap of zero prices nothing. */
export function fitPeers(peers: SnapshotProtocol[]): PeerFit {
  const usable = peers.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const comps = usable.map((p) => ({
    slug: p.slug,
    category: p.category,
    log_tvl: Math.log10(p.tvl_usd),
    log_multiple: Math.log10(p.mcap_usd! / p.tvl_usd),
  }));
  const mults = comps.map((c) => c.log_multiple).sort((a, b) => a - b);
  return { peers: comps, peer_count: comps.length, mult_lo: quantile(mults, 0.05), mult_hi: quantile(mults, 0.95) };
}

/** A weighted quantile of values, weights aligned by index. */
function weightedQuantile(values: number[], weights: number[], q: number): number {
  const pairs = values.map((v, i) => ({ v, w: weights[i]! })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= q * total) return p.v;
  }
  return pairs[pairs.length - 1]!.v;
}

/** The comp estimate for one protocol: the weighted geometric-mean multiple and its quartiles. */
export function compEstimate(
  fit: PeerFit,
  tvl: number,
  category: string | null,
  excludeSlug?: string,
): { multiple: number; mult_lo: number; mult_hi: number; comp_count: number } {
  const logTvl = Math.log10(Math.max(1, tvl));
  const dist = (c: CompPeer): number => {
    const d = Math.abs(c.log_tvl - logTvl);
    return c.category === category ? d * COMP_CATEGORY_BOOST : d;
  };
  const near = fit.peers
    .filter((c) => c.slug !== excludeSlug)
    .sort((a, b) => dist(a) - dist(b) || (a.slug < b.slug ? -1 : 1))
    .slice(0, COMP_COUNT);
  const weights = near.map((c) => Math.exp(-(dist(c) ** 2) / (2 * COMP_KERNEL * COMP_KERNEL)));
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  const clamped = near.map((c) => clamp(c.log_multiple, fit.mult_lo, fit.mult_hi));
  const mean = clamped.reduce((s, v, i) => s + v * weights[i]!, 0) / wsum;
  return {
    multiple: Math.pow(10, mean),
    mult_lo: Math.pow(10, weightedQuantile(clamped, weights, 0.25)),
    mult_hi: Math.pow(10, weightedQuantile(clamped, weights, 0.75)),
    comp_count: near.length,
  };
}

/** A deterministic fold index 0..4 from a slug, so the validation split never moves. */
function foldOf(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h % 5;
}

/** Held-out accuracy of the valuation estimator over the usable tokenised peers. */
export interface ValidationStats {
  peer_count: number;
  folds: number;
  median_abs_log10_error: number;
  fold_error: number;
  within_2x_share: number;
  within_3x_share: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The growth and maturity multipliers of the production formula, for one protocol. */
function growthMaturity(p: SnapshotProtocol, asOf: string): { growthMult: number; maturityMult: number } {
  const growthPct = clamp(finite(p.change_7d, 0), GROWTH_FLOOR, GROWTH_CAP);
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = MATURITY_FLOOR + (clamp(ageForModel, 0, MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE;
  return { growthMult, maturityMult };
}

/**
 * Five-fold cross-validation of the whole pricing formula: rebuild the comp set on four folds,
 * price the fifth (comps, growth and maturity adjustments and all), compare with the recorded
 * market cap. Peers with a zero recorded market cap carry no price and are left out entirely.
 */
export function validatePeers(peers: SnapshotProtocol[], asOf: string): ValidationStats {
  const usable = peers.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const errors: number[] = [];
  let within2 = 0;
  let within3 = 0;
  for (let fold = 0; fold < 5; fold++) {
    const train = usable.filter((p) => foldOf(p.slug) !== fold);
    const test = usable.filter((p) => foldOf(p.slug) === fold);
    if (train.length < 10 || test.length === 0) continue;
    const fit = fitPeers(train);
    for (const p of test) {
      const est = compEstimate(fit, p.tvl_usd, p.category, p.slug);
      const { growthMult, maturityMult } = growthMaturity(p, asOf);
      const predicted = Math.log10(Math.max(1, p.tvl_usd * est.multiple * growthMult * maturityMult));
      const actual = Math.log10(Math.max(1, p.mcap_usd ?? 1));
      const err = Math.abs(predicted - actual);
      errors.push(err);
      if (err <= Math.log10(2)) within2++;
      if (err <= Math.log10(3)) within3++;
    }
  }
  const med = errors.length > 0 ? median(errors) : 0;
  return {
    peer_count: usable.length,
    folds: 5,
    median_abs_log10_error: round4(med),
    fold_error: round4(Math.pow(10, med)),
    within_2x_share: errors.length > 0 ? round4(within2 / errors.length) : 0,
    within_3x_share: errors.length > 0 ? round4(within3 / errors.length) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* The launch-propensity fit                                           */
/* ------------------------------------------------------------------ */

/** The fitted logistic propensity: weights over standardised [log10 tvl, age years]. */
export interface OddsFit {
  weights: [number, number, number];
  mean: [number, number];
  sd: [number, number];
  base_rate: number;
}

function oddsFeatures(p: SnapshotProtocol, asOf: string): [number, number] {
  const age = ageDays(asOf, p.listed_at);
  const years = (age ?? UNKNOWN_AGE_DAYS) / 365;
  return [Math.log10(Math.max(1, p.tvl_usd)), Math.min(years, 6)];
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-clamp(z, -30, 30)));

/** Logistic regression by full-batch gradient descent: fixed rate and steps, so runs agree byte for byte. */
export function fitOdds(protocols: SnapshotProtocol[], asOf: string): OddsFit {
  const feats = protocols.map((p) => oddsFeatures(p, asOf));
  const y = protocols.map((p) => (hasToken(p) ? 1 : 0));
  const n = protocols.length;
  const mean: [number, number] = [
    feats.reduce((s, f) => s + f[0], 0) / n,
    feats.reduce((s, f) => s + f[1], 0) / n,
  ];
  const sd: [number, number] = [
    Math.sqrt(feats.reduce((s, f) => s + (f[0] - mean[0]) ** 2, 0) / n) || 1,
    Math.sqrt(feats.reduce((s, f) => s + (f[1] - mean[1]) ** 2, 0) / n) || 1,
  ];
  const z = feats.map((f): [number, number] => [(f[0] - mean[0]) / sd[0], (f[1] - mean[1]) / sd[1]]);
  const base = y.reduce((s, v) => s + v, 0) / n;
  let w: [number, number, number] = [Math.log(base / (1 - base)), 0, 0];
  const lr = 0.2;
  for (let step = 0; step < 1500; step++) {
    const g: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(w[0] + w[1] * z[i]![0] + w[2] * z[i]![1]);
      const d = pred - y[i]!;
      g[0] += d;
      g[1] += d * z[i]![0];
      g[2] += d * z[i]![1];
    }
    w = [w[0] - (lr * g[0]) / n, w[1] - (lr * g[1]) / n, w[2] - (lr * g[2]) / n];
  }
  return { weights: w, mean, sd, base_rate: round4(base) };
}

/** The fitted propensity that a protocol with this record already carries a token. */
export function launchOdds(fit: OddsFit, p: SnapshotProtocol, asOf: string): number {
  const f = oddsFeatures(p, asOf);
  const z0 = (f[0] - fit.mean[0]) / fit.sd[0];
  const z1 = (f[1] - fit.mean[1]) / fit.sd[1];
  return sigmoid(fit.weights[0] + fit.weights[1] * z0 + fit.weights[2] * z1);
}

/** Held-out calibration of the propensity fit, against guessing the census rate for everyone. */
export interface OddsValidation {
  brier_cv: number;
  brier_base_rate: number;
  census: number;
  tokenised: number;
}

export function validateOdds(protocols: SnapshotProtocol[], asOf: string): OddsValidation {
  let se = 0;
  let count = 0;
  const base = protocols.filter((p) => hasToken(p)).length / protocols.length;
  let seBase = 0;
  for (const p of protocols) {
    const yv = hasToken(p) ? 1 : 0;
    seBase += (base - yv) ** 2;
  }
  for (let fold = 0; fold < 5; fold++) {
    const train = protocols.filter((p) => foldOf(p.slug) !== fold);
    const test = protocols.filter((p) => foldOf(p.slug) === fold);
    if (train.length < 50 || test.length === 0) continue;
    const fit = fitOdds(train, asOf);
    for (const p of test) {
      const yv = hasToken(p) ? 1 : 0;
      se += (launchOdds(fit, p, asOf) - yv) ** 2;
      count++;
    }
  }
  return {
    brier_cv: count > 0 ? round4(se / count) : 0,
    brier_base_rate: round4(seBase / protocols.length),
    census: protocols.length,
    tokenised: protocols.filter((p) => hasToken(p)).length,
  };
}

/* ------------------------------------------------------------------ */
/* Farm plans                                                          */
/* ------------------------------------------------------------------ */

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** Cash cost of one transaction on a chain, from the chain's fee class. */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 8;
  if (c.includes('solana')) return 0.05;
  if (c.includes('bsc') || c.includes('binance')) return 0.3;
  if (c.includes('base') || c.includes('arbitrum') || c.includes('optimism') || c.includes('zksync') || c.includes('linea') || c.includes('scroll') || c.includes('mantle') || c.includes('blast') || c.includes('mode')) return 0.4;
  if (c.includes('polygon') || c.includes('avalanche') || c.includes('fantom') || c.includes('sonic') || c.includes('berachain') || c.includes('monad') || c.includes('hyperliquid') || c.includes('sui') || c.includes('aptos') || c.includes('near') || c.includes('tron')) return 0.2;
  return 1;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the supply position open`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token in the wallet`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged trade`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one position in a liquid market`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it in the wallet`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active`;
  if (c.includes('risk')) return `Deposit $${capital} of USDC into a ${name}-curated vault on ${chain} and keep the shares`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`;
}

/** The category's second, diversifying action. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `Borrow a small amount against the supply on ${name}, repay it a week later, so the wallet shows both sides of the market`;
  if (c.includes('dex')) return `Make two swaps through ${name}'s own interface on ${chain}, a week apart, so the wallet is a user and not only a provider`;
  if (c.includes('bridge')) return `Bridge a second, smaller amount back through ${name} after two weeks, leaving the first position in place`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close the hedge after a week and open a second small trade, keeping total volume modest and regular`;
  return `Repeat the core action once with a smaller amount after two weeks, so the wallet's history spans more than one day`;
}

/** The whole cash cost of one farm season under the plan: gas and fees only, never the capital. */
export function seasonCostUsd(p: SnapshotProtocol, age: number | null): number {
  const gas = gasUsd(chainOf(p));
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const txs = 4 + weeks; // setup, core, second action, weekly cadence, claim check, unwind
  return Math.max(1, Math.round(gas * txs + 2));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text}. Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's own record (category, first chain, TVL, age), never from a hand-written list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const gas = gasUsd(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gasText = gas < 1 ? `about $${gas.toFixed(2)}` : `about $${Math.round(gas)}`;
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm with, write its seed phrase on paper and keep it offline`,
      cost: 'nothing to create; the first funding transaction pays network gas',
      time: '5 minutes',
    },
    {
      text: `Fund the wallet with $${capital} of USDC plus a small amount of ${chain}'s gas token`,
      cost: `$${capital} of capital (recoverable) and ${gasText} of gas to move it`,
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `${gasText} of gas; the $${capital} stays in the position`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, chain),
      cost: `${gasText} of gas for the extra transaction`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week — a deposit, a swap, a vote or a claim — so the wallet stays active in every weekly snapshot`,
      cost: `${gasText} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days before withdrawing anything, so the activity is counted across more than one snapshot`,
      cost: `the $${capital} stays in the position for ${hold} days`,
      time: `${hold} days`,
    },
    {
      text: `Each month, open the protocol's own points or rewards page from the link on its official site, and log the wallet, the dates and every transaction in a farm log`,
      cost: 'nothing to check; never pay a fee to claim a reward',
      time: '10 minutes a month',
    },
  ];
}

/** The season verdict: propensity and implied value weighed against the plan's cash cost. */
export type Verdict = 'Farm first' | 'Farm cheap' | 'Watch' | 'Skip';

export function verdictFor(odds: number, implied: number): Verdict {
  if (odds >= 0.55 && implied >= 25_000_000) return 'Farm first';
  if (odds >= 0.42 && implied >= 5_000_000) return 'Farm cheap';
  if (odds >= 0.28) return 'Watch';
  return 'Skip';
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

/** One row of board.json: the ranked board's row, with the model's working shown. */
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
  on_watchlist: boolean;
  product_rule: 'ranked';
  age_days: number | null;
  implied_value_usd: number;
  launch_odds: number;
  verdict: Verdict;
  season_cost_usd: number;
  model: {
    comp_multiple: number;
    comp_count: number;
    peer_base_usd: number;
    implied_low_usd: number;
    implied_high_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row: everything the detail view needs, farm plan included. */
export interface RadarRow extends BoardRow {}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  census_size: number;
  pre_token_size: number;
  products_set_aside: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  fit: { peer_count: number; comp_count: number; kernel: number };
  validation: ValidationStats;
  odds_validation: OddsValidation;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The comp estimate, the adjustments and the implied value one protocol gets. */
export function impliedValue(
  fit: PeerFit,
  protocol: SnapshotProtocol,
  asOf: string,
): {
  implied: number;
  impliedLow: number;
  impliedHigh: number;
  peerBase: number;
  compMultiple: number;
  compCount: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(finite(protocol.change_7d, 0), GROWTH_FLOOR, GROWTH_CAP);
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = MATURITY_FLOOR + (clamp(ageForModel, 0, MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE;
  const est = compEstimate(fit, protocol.tvl_usd, protocol.category);
  const peerBase = protocol.tvl_usd * est.multiple;
  const adj = growthMult * maturityMult;
  return {
    implied: Math.max(1, Math.round(peerBase * adj)),
    impliedLow: Math.max(1, Math.round(protocol.tvl_usd * est.mult_lo * adj)),
    impliedHigh: Math.max(1, Math.round(protocol.tvl_usd * est.mult_hi * adj)),
    peerBase: Math.round(peerBase),
    compMultiple: round4(est.multiple),
    compCount: est.comp_count,
    growthPct,
    growthMult,
    maturityMult,
    age,
  };
}

/** The board: every rankable pre-token protocol, strongest first, ranks 1..n. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; fit: PeerFit; oddsFit: OddsFit } {
  const peers = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const fit = fitPeers(peers);
  const oddsFit = fitOdds(snapshot.protocols, snapshot.as_of);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p) || watch.has(p.slug));
  const scored = chosen.map((p) => {
    const v = impliedValue(fit, p, snapshot.as_of);
    const odds = round4(launchOdds(oddsFit, p, snapshot.as_of));
    return { p, ...v, odds, verdict: verdictFor(odds, v.implied), cost: seasonCostUsd(p, v.age) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board = scored.map((s, i) => ({
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
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(s.p.slug),
    product_rule: 'ranked' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    launch_odds: s.odds,
    verdict: s.verdict,
    season_cost_usd: s.cost,
    model: {
      comp_multiple: s.compMultiple,
      comp_count: s.compCount,
      peer_base_usd: s.peerBase,
      implied_low_usd: s.impliedLow,
      implied_high_usd: s.impliedHigh,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  return { board, fit, oddsFit };
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard needs: the board, the live set, the fits and their validation. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, fit } = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const peers = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    census_size: snapshot.protocols.length,
    pre_token_size: snapshot.protocols.filter(isPreToken).length,
    products_set_aside: snapshot.protocols.filter((p) => isPreToken(p) && isProductOfTraded(p)).length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    fit: { peer_count: fit.peer_count, comp_count: COMP_COUNT, kernel: COMP_KERNEL },
    validation: validatePeers(peers, snapshot.as_of),
    odds_validation: validateOdds(snapshot.protocols, snapshot.as_of),
    rows: board,
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (slugs.size !== board.length) return 'a slug appears on the board twice';
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'all rows share the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
