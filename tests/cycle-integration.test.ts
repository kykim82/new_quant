// 실제 SQLite와 모의 업비트 응답으로 D1 잠금·재시작·전체 종목 순회·호출 상한을 통합 검증한다
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { acquireCycle, ensureCycleSchema, releaseCycle } from '../lib/cycle-store';
import { refreshDashboard } from '../lib/scanner';

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

test('800봉 초기 수집도 전체 종목을 순회하고 각 실행은 45회 이하 호출한다', async () => {
  const { db, close } = database();
  const originalFetch = globalThis.fetch;
  const markets = ['KRW-BTC', ...Array.from({ length: 20 }, (_, index) => `KRW-X${index}`)];
  let simulatedNow = Date.now();
  let calls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls++;
    const address = new URL(String(url));
    const path = address.pathname;
    let body: unknown;
    if (path.endsWith('/market/all')) body = [...markets, 'KRW-WARN'].map(market => ({ market, korean_name: market, english_name: market, market_event: { warning: market === 'KRW-WARN', caution: {} } }));
    else if (path.endsWith('/ticker/all')) body = [...markets, 'KRW-WARN'].map(market => ({ market, trade_price: 2000, signed_change_rate: 0, acc_trade_price_24h: market === 'KRW-BTC' ? 20_000_000_000 : 10_000_000, timestamp: simulatedNow }));
    else if (path.includes('/candles/minutes/')) {
      const unit = Number(path.split('/').at(-1));
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
      assert.equal(payload.coverage.eligibleMarketCount, 21);
      simulatedNow += 60_000;
    }
    assert.ok(seen[1] > seen[0]); assert.equal(seen.at(-1), 21);
    const stored = await db.prepare('SELECT market FROM market_analysis').all<{ market: string }>();
    assert.ok(stored.results.some(row => row.market === 'KRW-X19'));
    assert.ok(!stored.results.some(row => row.market === 'KRW-WARN'));
  } finally { globalThis.fetch = originalFetch; close(); }
});
