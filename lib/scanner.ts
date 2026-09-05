// 전체 원화시장을 D1 커서·캔들 캐시로 순회하고 진입 후보와 관찰 대상을 집계한다
import type { Candidate, DashboardPayload, ExecutionQuality, MarketDefinition, MarketRegime, MarketTicker, Observation } from './domain';
import { getLatestDashboard, saveDashboard } from './database';
import { acquireCycle, ensureCycleSchema, marketRows, readCandles, releaseCycle, writeMarket, type MarketResult } from './cycle-store';
import { activityRatio, candleCost, dueUnits, emptyCandles, entryStillValid, ENTRY_VOLUME, makeObservation, nextMarkets, REASONS, SIGNAL_FRESH_MS, type CandleCache } from './market-cycle';
import { deriveBtcRegime, evaluateScalp, evaluateSwing, rankCandidates, type StrategyInput } from './strategy';
import { evaluateScalp as legacyScalp, evaluateSwing as legacySwing } from './legacy-strategy';
import { fetchExecutionQualities, fetchKrwMarkets, fetchKrwTickers, updateCandleCache } from './upbit';
import { paperSummary, trackPaper } from './paper-trades';

export const ANALYSIS_NOTIONAL_KRW = 1_000_000;
export const ASSUMED_FEE_RATE = 0.0005;
// 목록·티커 3회 + 호가·호가단위 2회 + 캔들 최대 40회 = 외부 요청 최대 45회.
const CANDLE_BUDGET = 40;
const MARKET_BATCH = 24;

export function summarizeMarkets(results: MarketResult[], markets: MarketDefinition[], tickers: MarketTicker[], regime: MarketRegime, now: number, executions: Map<string, ExecutionQuality> = new Map()): DashboardPayload {
  const safe = new Map(markets.filter(m => !m.warned).map(m => [m.market, m]));
  const prices = new Map(tickers.map(t => [t.market, t]));
  const valid = results.filter(r => safe.has(r.market));
  const observations: Observation[] = [];
  const accepted: Candidate[] = [];
  const legacy: Candidate[] = [];
  const diagnostics: Record<string, number> = {};
  let fresh = 0;
  for (const result of valid) {
    const ticker = prices.get(result.market);
    if (!ticker) continue;
    const isFresh = now - result.analyzedAt <= SIGNAL_FRESH_MS;
    if (isFresh && result.complete) fresh++;
    for (const candidate of result.candidates) {
      const execution = executions.get(candidate.market);
      const cost = ASSUMED_FEE_RATE + (execution?.buySlippagePct ?? Infinity) / 100;
      const plan = candidate.plan;
      const netRR = (plan.targets[1] * (1 - cost) - plan.entryAnchor * (1 + cost))
        / (plan.entryAnchor * (1 + cost) - plan.stop * (1 - cost));
      const executionOk = execution?.sufficientDepth && execution.spreadPct <= (candidate.strategy === 'scalp' ? 0.2 : 0.35)
        && execution.buySlippagePct <= (candidate.strategy === 'scalp' ? 0.15 : 0.25) && netRR >= 1.5;
      if (isFresh && regime !== 'RISK_OFF' && ticker.quoteVolume24h >= ENTRY_VOLUME[candidate.strategy]
        && executionOk && entryStillValid(candidate, ticker.tradePrice, now)) {
        accepted.push({ ...candidate, currentPrice: ticker.tradePrice, quoteVolume24h: ticker.quoteVolume24h, signedChangeRate: ticker.signedChangeRate,
          plan: { ...candidate.plan, netRewardRiskAtTarget2: netRR },
          metrics: { ...candidate.metrics, spreadPct: execution.spreadPct, slippagePct: execution.buySlippagePct } });
      } else {
        const code = !isFresh ? 'DATA_DELAYED' : regime === 'RISK_OFF' ? 'BTC_RISK_OFF'
          : ticker.quoteVolume24h < ENTRY_VOLUME[candidate.strategy] ? 'LOW_LIQUIDITY' : !executionOk ? 'POOR_EXECUTION' : 'CURRENT_PRICE_OUTSIDE_ENTRY';
        observations.push({ market: candidate.market, koreanName: candidate.koreanName, strategy: candidate.strategy,
          currentPrice: ticker.tradePrice, quoteVolume24h: ticker.quoteVolume24h, analyzedAt: result.analyzedAt,
          code, reason: REASONS[code], trendScore: candidate.score });
        diagnostics[code] = (diagnostics[code] ?? 0) + 1;
      }
    }
    if (isFresh && regime !== 'RISK_OFF') legacy.push(...result.legacy.filter(c => ticker.quoteVolume24h >= (c.strategy === 'scalp' ? 10_000_000_000 : 5_000_000_000)
      && entryStillValid(c, ticker.tradePrice, now)));
    for (const observation of result.observations) {
      const code = !isFresh ? 'DATA_DELAYED' : regime === 'RISK_OFF' ? 'BTC_RISK_OFF'
        : ticker.quoteVolume24h < ENTRY_VOLUME[observation.strategy] ? 'LOW_LIQUIDITY' : observation.code;
      diagnostics[code] = (diagnostics[code] ?? 0) + 1;
      observations.push({ ...observation, currentPrice: ticker.tradePrice, quoteVolume24h: ticker.quoteVolume24h, code, reason: REASONS[code] ?? code });
    }
  }
  const btc = prices.get('KRW-BTC');
  return {
    schemaVersion: 2, generatedAt: now, priceUpdatedAt: now, source: 'live', stale: false,
    analysisNotionalKrw: ANALYSIS_NOTIONAL_KRW, marketRegime: regime,
    btcPrice: btc?.tradePrice ?? null, btcChangeRate: btc?.signedChangeRate ?? null,
    coverage: { krwMarketCount: markets.length, eligibleMarketCount: safe.size, analyzedMarketCount: valid.length,
      completedMarketCount: valid.filter(r => r.complete).length,
      pendingMarketCount: Math.max(0, safe.size - valid.length), freshMarketCount: fresh,
      delayedMarketCount: valid.filter(r => now - r.analyzedAt > SIGNAL_FRESH_MS).length,
      oldestAnalysisAt: valid.length ? Math.min(...valid.map(r => r.analyzedAt)) : undefined },
    scalp: rankCandidates(accepted, 'scalp', 10), swing: rankCandidates(accepted, 'swing', 10),
    watchlist: observations.sort((a, b) => b.trendScore - a.trendScore || b.quoteVolume24h - a.quoteVolume24h),
    diagnostics,
    comparison: { legacy: legacy.length, improved: accepted.length, note: '같은 전체시장 데이터에서 기존·개선 기준 비교. 기존 9종목 제한은 적용하지 않음. 점수는 승률이 아님.' },
    rejections: { lowLiquidity: diagnostics.LOW_LIQUIDITY ?? 0, marketWarning: markets.length - safe.size,
      technicalConditions: observations.filter(o => !['LOW_LIQUIDITY', 'POOR_EXECUTION', 'DATA_DELAYED', 'INSUFFICIENT_DATA'].includes(o.code)).length,
      executionQuality: diagnostics.POOR_EXECUTION ?? 0, insufficientData: diagnostics.INSUFFICIENT_DATA ?? 0 },
    notice: '진입 기준 단타 10억·스윙 5억 원 · 모의 주문금액 100만원 · 편도 수수료 가정 0.05% · 자동주문 없음',
  };
}

function cachedPayload(payload: DashboardPayload, now: number, error?: unknown): DashboardPayload {
  const stale = payload.schemaVersion !== 2 || now - payload.generatedAt > 3 * 60_000 || Boolean(error);
  return { ...payload, source: 'cached', stale,
    scalp: stale ? [] : payload.scalp.filter(c => c.plan.expiresAt > now),
    swing: stale ? [] : payload.swing.filter(c => c.plan.expiresAt > now),
    error: error instanceof Error ? error.message : error ? '시세 갱신 실패' : undefined };
}

export async function getDashboard(db: D1Database, now = Date.now()): Promise<DashboardPayload | null> {
  const latest = await getLatestDashboard(db);
  return latest ? cachedPayload(latest, now) : null;
}

export async function refreshDashboard(db: D1Database, options: { force?: boolean; now?: number } = {}): Promise<DashboardPayload> {
  const now = options.now ?? Date.now();
  const startedAt = Date.now();
  await ensureCycleSchema(db);
  const token = await acquireCycle(db, now);
  if (!token) {
    const latest = await getDashboard(db, now);
    if (latest) return latest;
    throw new Error('첫 묶음을 준비 중입니다. 잠시 후 다시 확인해 주세요.');
  }
  try {
    const markets = await fetchKrwMarkets();
    let tickers = await fetchKrwTickers();
    const rows = await marketRows(db);
    const checked = new Map(rows.map(row => [row.market, row.checked_at]));
    const results = new Map(rows.map(row => [row.market, JSON.parse(row.result_json) as MarketResult]));
    let budget = CANDLE_BUDGET;
    const btcCache = await readCandles(db, 'KRW-BTC') ?? emptyCandles();
    budget -= candleCost(btcCache, now);
    const btcCandles = await updateCandleCache('KRW-BTC', btcCache, now);
    if (btcCandles['60'].length < 55 || btcCandles['240'].length < 205 || dueUnits(btcCandles, now).length) {
      throw new Error('BTC 시장 위험도를 판단할 최신 캔들이 부족합니다.');
    }
    const regime = deriveBtcRegime(btcCandles['60'], btcCandles['240']);
    const prepared: Array<{ market: MarketDefinition; candles: CandleCache }> = [];
    const btcMarket = markets.find(m => m.market === 'KRW-BTC' && !m.warned);
    if (btcMarket) prepared.push({ market: btcMarket, candles: btcCandles });
    for (const market of nextMarkets(markets, tickers, checked)) {
      if (market.market === 'KRW-BTC') continue;
      if (prepared.length >= MARKET_BATCH || Date.now() - startedAt > 40_000) break;
      const cache = await readCandles(db, market.market) ?? emptyCandles();
      const cost = candleCost(cache, now);
      if (cost > budget) break;
      budget -= cost;
      try {
        const candles = await updateCandleCache(market.market, cache, now);
        prepared.push({ market, candles });
      } catch {
        const failure: MarketResult = { market: market.market, analyzedAt: now, complete: false,
          candidates: [], legacy: [], observations: (['scalp', 'swing'] as const).map(strategy => ({
            market: market.market, koreanName: market.koreanName, strategy, currentPrice: 0, quoteVolume24h: 0,
            analyzedAt: now, code: 'INSUFFICIENT_DATA', reason: REASONS.INSUFFICIENT_DATA, trendScore: 0 })) };
        await writeMarket(db, failure, cache); results.set(market.market, failure);
      }
    }
    tickers = await fetchKrwTickers();
    const tickerMap = new Map(tickers.map(t => [t.market, t]));
    const safeCodes = new Set(markets.filter(m => !m.warned).map(m => m.market));
    const executionCodes = [...new Set([...prepared.map(p => p.market.market),
      ...[...results.values()].filter(r => safeCodes.has(r.market) && now - r.analyzedAt <= SIGNAL_FRESH_MS && r.candidates.length > 0).map(r => r.market)])];
    const executions = await fetchExecutionQualities(executionCodes, ANALYSIS_NOTIONAL_KRW, Date.now());
    for (const { market, candles } of prepared) {
      const ticker = tickerMap.get(market.market);
      const execution = executions.get(market.market) ?? { spreadPct: Infinity, buySlippagePct: Infinity,
        sufficientDepth: false, tickSize: 1, tickSizeReferencePrice: 0 };
      if (!ticker) continue;
      const input: StrategyInput = { market, ticker, candles, execution, marketRegime: regime,
        btcChangeRate: tickerMap.get('KRW-BTC')?.signedChangeRate ?? 0, feeRate: ASSUMED_FEE_RATE };
      const result: MarketResult = { market: market.market, analyzedAt: now,
        complete: candles['15'].length >= 60 && candles['60'].length >= 60 && candles['240'].length >= 220,
        candidates: [], legacy: [], observations: [] };
      for (const strategy of ['scalp', 'swing'] as const) {
        const evaluation = strategy === 'scalp' ? evaluateScalp(input) : evaluateSwing(input);
        const activity = activityRatio(candles['60'], ticker.quoteVolume24h);
        if (evaluation.accepted && activity !== null) {
          evaluation.candidate.metrics.activityRatio = activity;
          evaluation.candidate.score = Math.min(100, evaluation.candidate.score + (activity >= 1.5 ? 5 : activity >= 1.1 ? 2 : 0));
          evaluation.candidate.reasons.push(`24시간 거래대금 / 이전 3일 일평균 ${activity.toFixed(2)}배`);
        }
        const threshold = strategy === 'scalp' ? 70 : 72;
        if (evaluation.accepted && evaluation.candidate.score >= threshold && ticker.quoteVolume24h >= ENTRY_VOLUME[strategy]) {
          result.candidates.push(evaluation.candidate);
        } else result.observations.push(makeObservation(input, strategy, evaluation, now));
        if (ticker.quoteVolume24h >= (strategy === 'scalp' ? 10_000_000_000 : 5_000_000_000)) {
          const baseline = strategy === 'scalp' ? legacyScalp(input) : legacySwing(input);
          if (baseline.accepted && baseline.candidate.score >= threshold) result.legacy.push(baseline.candidate);
        }
      }
      await trackPaper(db, market.market, candles['15'], result.candidates, result.legacy, now);
      await writeMarket(db, result, candles);
      results.set(market.market, result);
    }
    const payload = summarizeMarkets([...results.values()], markets, tickers, regime, now, executions);
    payload.paper = await paperSummary(db);
    await saveDashboard(db, payload);
    return payload;
  } catch (error) {
    const latest = await getLatestDashboard(db);
    if (latest) return cachedPayload(latest, now, error);
    throw error;
  } finally {
    await releaseCycle(db, token);
  }
}
