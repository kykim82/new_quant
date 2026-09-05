// 실제 SQLite와 모의 업비트 응답으로 D1 잠금·재시작·전체 종목 순회·호출 상한을 통합 검증한다
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { acquireCycle, ensureCycleSchema, releaseCycle, writeStoredPlans, type MarketResult } from '../lib/cycle-store';
import { getDashboard, refreshDashboard } from '../lib/scanner';
import { createSavedPlan } from '../lib/plan-lifecycle';
import type { Candidate } from '../lib/domain';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE scan_results (id INTEGER PRIMARY KEY AUTOINCREMENT, generated_at INTEGER, status TEXT, payload_json TEXT, created_at INTEGER)');
  function prepared(sql: string, args: (string | number | null)[] = []): unknown {
    return { bind: (...values: (string | number | null)[]) => prepared(sql, values),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => ({ success: true, meta: sqlite.prepare(sql).run(...args) }) };
  }
  const db = { prepare: prepared, batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
    sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}

test('D1 잠금은 중복 수집과 해제 토큰 오용을 방지하고 다음 분에 재개한다', async () => {
  const { db, close } = database();
  try {
    await ensureCycleSchema(db); await ensureCycleSchema(db);
    const token = await acquireCycle(db, 1_000_000);
    assert.ok(token);
    assert.equal(await acquireCycle(db, 1_060_000), null);
    await releaseCycle(db, 'wrong-token');
    assert.equal(await acquireCycle(db, 1_060_000), null);
    await releaseCycle(db, token);
    assert.ok(await acquireCycle(db, 1_060_000));
  } finally { close(); }
});

test('저거래대금은 1시간만 순회하고 고정 계획은 보존하며 각 실행은 45회 이하 호출한다', async () => {
  const { db, close } = database();
  const originalFetch = globalThis.fetch;
  const markets = ['KRW-BTC', ...Array.from({ length: 40 }, (_, index) => `KRW-H${index}`), ...Array.from({ length: 20 }, (_, index) => `KRW-X${index}`)];
  let simulatedNow = Date.now();
  let calls = 0;
  const candleRequests: Array<{ market: string; unit: number }> = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls++;
    const address = new URL(String(url));
    const path = address.pathname;
    let body: unknown;
    if (path.endsWith('/market/all')) body = [...markets, 'KRW-WARN'].map(market => ({ market, korean_name: market, english_name: market, market_event: { warning: market === 'KRW-WARN', caution: {} } }));
    else if (path.endsWith('/ticker/all')) body = [...markets, 'KRW-WARN'].map(market => ({ market, trade_price: 2000, signed_change_rate: 0, acc_trade_price_24h: market === 'KRW-BTC' || market.startsWith('KRW-H') ? 20_000_000_000 : 10_000_000, timestamp: simulatedNow }));
    else if (path.includes('/candles/minutes/')) {
      const unit = Number(path.split('/').at(-1));
      candleRequests.push({ market: address.searchParams.get('market')!, unit });
      const to = Date.parse(address.searchParams.get('to')!);
      body = Array.from({ length: 200 }, (_, index) => ({ market: address.searchParams.get('market'), unit,
        candle_date_time_utc: new Date(to - (index + 1) * unit * 60_000).toISOString().slice(0, -1),
        opening_price: 2000, high_price: 2002, low_price: 1998, trade_price: 2000,
        candle_acc_trade_price: 100000, candle_acc_trade_volume: 50 }));
    } else if (path.endsWith('/orderbook/instruments')) body = address.searchParams.get('markets')!.split(',').map(market => ({ market, tick_size: 1 }));
    else if (path.endsWith('/orderbook')) body = address.searchParams.get('markets')!.split(',').map(market => ({ market, timestamp: simulatedNow,
      orderbook_units: [{ ask_price: 2001, bid_price: 2000, ask_size: 10000, bid_size: 10000 }] }));
    else throw new Error(`예상하지 않은 요청 ${path}`);
    return Response.json(body);
  }) as typeof fetch;
  try {
    const seen: number[] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      calls = 0;
      const payload = await refreshDashboard(db, { now: simulatedNow });
      assert.equal(payload.error, undefined);
      assert.ok(calls <= 45, `요청 수 ${calls}`);
      seen.push(payload.coverage.analyzedMarketCount);
      assert.equal(payload.coverage.eligibleMarketCount, 41);
      assert.equal(payload.coverage.monitoringMarketCount, 20);
      assert.equal(payload.watchlist?.some(o => o.market.startsWith('KRW-X')), false);
      if (cycle === 0) {
        const row = await db.prepare('SELECT result_json FROM market_analysis WHERE market = ?').bind('KRW-BTC').first<{ result_json: string }>();
        const result = JSON.parse(row!.result_json) as MarketResult;
        const signalTime = (Math.floor(simulatedNow / 900_000) - 1) * 900_000;
        const candidate: Candidate = { market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', strategy: 'scalp', setup: 'breakout',
          score: 80, rank: 0, currentPrice: 2000, signedChangeRate: 0, quoteVolume24h: 20e9, signalTime, reasons: [], warnings: [],
          metrics: { rsi: 55, atrPct: 1, rvol: 2, spreadPct: 0.1, slippagePct: 0 }, charts: { '15': [], '60': [], '240': [] },
          plan: { entryLow: 1990, entryAnchor: 2000, entryHigh: 2010, stop: 1900, targets: [2200, 2300, 2400], riskPct: 5,
            netRewardRiskAtTarget2: 3, expiresAt: signalTime + 900_000, id: 'persisted-plan', version: 'confluence-v3', issuedAt: signalTime } };
        result.plans = [createSavedPlan(candidate)];
        await writeStoredPlans(db, result);
      }
      if (cycle > 0) {
        const saved = payload.savedPlans!.find(c => c.market === 'KRW-BTC')!;
        assert.equal(saved.plan.id, 'persisted-plan');
        assert.deepEqual(saved.plan.targets, [2200, 2300, 2400]);
        assert.equal(saved.entryStatus, 'waiting');
      }
      simulatedNow += 60_000;
    }
    assert.ok(seen[1] > seen[0]);
    assert.equal(seen[4], 41);
    assert.equal(seen.at(-1), 41);
    assert.ok(candleRequests.filter(r => r.market.startsWith('KRW-X')).every(r => r.unit === 60));
    assert.ok(candleRequests.filter(r => r.market.startsWith('KRW-H')).every(r => r.unit !== 15));
    assert.ok(candleRequests.some(r => r.market === 'KRW-BTC' && r.unit === 15));
    const stored = await db.prepare('SELECT market FROM market_analysis').all<{ market: string }>();
    assert.ok(stored.results.some(row => row.market === 'KRW-X19'));
    assert.ok(!stored.results.some(row => row.market === 'KRW-WARN'));
    const stale = await getDashboard(db, simulatedNow + 1_800_000);
    assert.equal(stale!.stale, true); assert.equal(stale!.scalp.length, 0);
    assert.equal(stale!.savedPlans!.find(c => c.market === 'KRW-BTC')!.plan.id, 'persisted-plan');
  } finally { globalThis.fetch = originalFetch; close(); }
});
