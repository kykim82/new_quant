// D1에 전체시장 순회 캐시와 작업 잠금을 영속 저장한다
import type { Candidate, Observation } from './domain';
import type { CandleCache } from './market-cycle';
import type { TrendState } from './trend-state';

export interface MarketResult {
  market: string;
  analyzedAt: number;
  complete: boolean;
  candidates: Candidate[];
  legacy: Candidate[];
  observations: Observation[];
  engineVersion?: 3;
  trends?: Record<'15' | '60' | '240', TrendState>;
}
export interface MarketRow { market: string; checked_at: number; result_json: string }

export async function ensureCycleSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS scan_results (id INTEGER PRIMARY KEY AUTOINCREMENT, generated_at INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS market_analysis (market TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, result_json TEXT NOT NULL, candles_json TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS scan_lease (id INTEGER PRIMARY KEY, until_ms INTEGER NOT NULL, token TEXT NOT NULL, last_run INTEGER NOT NULL)'),
    db.prepare("INSERT OR IGNORE INTO scan_lease VALUES (1, 0, '', 0)"),
    db.prepare('CREATE TABLE IF NOT EXISTS paper_signals (id TEXT PRIMARY KEY, variant TEXT NOT NULL, market TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS paper_market_status ON paper_signals (market, status)'),
  ]);
}

export async function acquireCycle(db: D1Database, now: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const row = await db.prepare('UPDATE scan_lease SET until_ms = ?, token = ?, last_run = ? WHERE id = 1 AND until_ms <= ? AND last_run <= ? RETURNING token')
    .bind(now + 180_000, token, now, now, now - 50_000).first<{ token: string }>();
  return row?.token ?? null;
}
export async function releaseCycle(db: D1Database, token: string): Promise<void> {
  await db.prepare('UPDATE scan_lease SET until_ms = 0 WHERE id = 1 AND token = ?').bind(token).run();
}
export async function marketRows(db: D1Database): Promise<MarketRow[]> {
  return (await db.prepare('SELECT market, checked_at, result_json FROM market_analysis').all<MarketRow>()).results;
}
export async function readCandles(db: D1Database, market: string): Promise<CandleCache | null> {
  const row = await db.prepare('SELECT candles_json FROM market_analysis WHERE market = ?').bind(market).first<{ candles_json: string }>();
  return row ? JSON.parse(row.candles_json) as CandleCache : null;
}
export async function writeMarket(db: D1Database, result: MarketResult, candles: CandleCache): Promise<void> {
  await db.prepare('INSERT INTO market_analysis VALUES (?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET checked_at=excluded.checked_at, result_json=excluded.result_json, candles_json=excluded.candles_json')
    .bind(result.market, result.analyzedAt, JSON.stringify(result), JSON.stringify(candles)).run();
}
