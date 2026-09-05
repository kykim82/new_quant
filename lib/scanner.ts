// 원화마켓을 선별해 단타·스윙 전략을 실행하고 대시보드 결과를 만든다
import type {
  Candidate,
  DashboardPayload,
  ExecutionQuality,
  MarketDefinition,
  MarketTicker,
  RejectionSummary,
} from '@/lib/domain';
import { getLatestDashboard, saveDashboard } from '@/lib/database';
import {
  deriveBtcRegime,
  evaluateScalp,
  evaluateSwing,
  rankCandidates,
  type StrategyEvaluation,
} from '@/lib/strategy';
import {
  fetchCandlesForMarkets,
  fetchExecutionQualities,
  fetchKrwMarkets,
  fetchKrwTickers,
} from '@/lib/upbit';

export const ANALYSIS_NOTIONAL_KRW = 1_000_000;
export const ASSUMED_FEE_RATE = 0.0005;
const MAX_ANALYZED_MARKETS = 9;
const MIN_SWING_VOLUME_KRW = 5_000_000_000;
const MIN_SCALP_VOLUME_KRW = 10_000_000_000;
const REFRESH_COOLDOWN_MS = 60_000;
const STALE_AFTER_MS = 22 * 60_000;

function emptyRejections(): RejectionSummary {
  return {
    lowLiquidity: 0,
    marketWarning: 0,
    technicalConditions: 0,
    executionQuality: 0,
    insufficientData: 0,
  };
}

function recordEvaluation(
  evaluation: StrategyEvaluation,
  accepted: Candidate[],
  rejections: RejectionSummary,
): void {
  if (evaluation.accepted) accepted.push(evaluation.candidate);
  else rejections[evaluation.category] += 1;
}

function selectUniverse(
  markets: readonly MarketDefinition[],
  tickers: readonly MarketTicker[],
): {
  selected: Array<{ market: MarketDefinition; ticker: MarketTicker }>;
  eligibleCount: number;
  rejections: RejectionSummary;
} {
  const rejections = emptyRejections();
  const tickersByMarket = new Map(tickers.map((ticker) => [ticker.market, ticker]));
  const safeMarkets = markets.filter((market) => {
    if (market.warned) {
      rejections.marketWarning += 1;
      return false;
    }
    return true;
  });
  const liquid = safeMarkets
    .map((market) => ({ market, ticker: tickersByMarket.get(market.market) }))
    .filter((item): item is { market: MarketDefinition; ticker: MarketTicker } => Boolean(item.ticker))
    .filter((item) => {
      const passes = item.ticker.quoteVolume24h >= MIN_SWING_VOLUME_KRW;
      if (!passes) rejections.lowLiquidity += 1;
      return passes;
    })
    .sort((left, right) => right.ticker.quoteVolume24h - left.ticker.quoteVolume24h);

  const selected = liquid.slice(0, MAX_ANALYZED_MARKETS);
  if (!selected.some((item) => item.market.market === 'KRW-BTC')) {
    const btc = liquid.find((item) => item.market.market === 'KRW-BTC');
    if (btc) selected.splice(Math.max(selected.length - 1, 0), 1, btc);
  }
  return { selected, eligibleCount: liquid.length, rejections };
}

function unavailableExecution(): ExecutionQuality {
  return {
    spreadPct: Number.POSITIVE_INFINITY,
    buySlippagePct: Number.POSITIVE_INFINITY,
    sufficientDepth: false,
    tickSize: 1,
    tickSizeReferencePrice: 0,
  };
}

export async function scanMarkets(asOf = Date.now()): Promise<DashboardPayload> {
  const [markets, tickers] = await Promise.all([fetchKrwMarkets(), fetchKrwTickers()]);
  const { selected, eligibleCount, rejections } = selectUniverse(markets, tickers);
  if (selected.length === 0) throw new Error('거래대금 기준을 통과한 원화마켓이 없습니다.');

  const selectedCodes = selected.map((item) => item.market.market);
  const candlesByMarket = await fetchCandlesForMarkets(selectedCodes, asOf);
  const btcCandles = candlesByMarket.get('KRW-BTC');
  if (!btcCandles || btcCandles['60'].length < 55 || btcCandles['240'].length < 205) {
    throw new Error('BTC 시장 위험도를 판단할 완성 봉이 부족합니다.');
  }
  const completedMarketCodes = selectedCodes.filter((market) => {
    const candles = candlesByMarket.get(market);
    return Boolean(candles
      && candles['15'].length >= 60
      && candles['60'].length >= 60
      && candles['240'].length >= 220);
  });
  const minimumCompleted = Math.max(1, Math.ceil(selectedCodes.length * 0.7));
  if (completedMarketCodes.length < minimumCompleted) {
    throw new Error(`캔들 수집 완료 종목이 부족합니다. ${completedMarketCodes.length}/${selectedCodes.length}`);
  }
  const executionByMarket = await fetchExecutionQualities(selectedCodes, ANALYSIS_NOTIONAL_KRW, asOf);
  const btcTicker = tickers.find((ticker) => ticker.market === 'KRW-BTC');
  const marketRegime = deriveBtcRegime(btcCandles['60'], btcCandles['240']);
  const btcChangeRate = btcTicker?.signedChangeRate ?? 0;
  const accepted: Candidate[] = [];
  const completedMarketCount = completedMarketCodes.length;

  for (const item of selected) {
    const candles = candlesByMarket.get(item.market.market);
    if (!candles) {
      rejections.insufficientData += 2;
      continue;
    }
    const input = {
      market: item.market,
      ticker: item.ticker,
      candles,
      execution: executionByMarket.get(item.market.market) ?? unavailableExecution(),
      marketRegime,
      btcChangeRate,
      feeRate: ASSUMED_FEE_RATE,
    };
    if (item.ticker.quoteVolume24h >= MIN_SCALP_VOLUME_KRW) {
      recordEvaluation(evaluateScalp(input), accepted, rejections);
    } else {
      rejections.lowLiquidity += 1;
    }
    recordEvaluation(evaluateSwing(input), accepted, rejections);
  }

  return {
    generatedAt: asOf,
    source: 'live',
    stale: false,
    analysisNotionalKrw: ANALYSIS_NOTIONAL_KRW,
    marketRegime,
    btcPrice: btcTicker?.tradePrice ?? null,
    btcChangeRate: btcTicker?.signedChangeRate ?? null,
    coverage: {
      krwMarketCount: markets.length,
      eligibleMarketCount: eligibleCount,
      analyzedMarketCount: selected.length,
      completedMarketCount,
    },
    scalp: rankCandidates(accepted, 'scalp'),
    swing: rankCandidates(accepted, 'swing'),
    rejections,
    notice: `기준 주문금액 ${ANALYSIS_NOTIONAL_KRW.toLocaleString('ko-KR')}원 · 예상 수수료 편도 ${(ASSUMED_FEE_RATE * 100).toFixed(2)}% · 자동주문 없음`,
  };
}

function cachedPayload(payload: DashboardPayload, now: number, error?: unknown): DashboardPayload {
  const stale = now - payload.generatedAt > STALE_AFTER_MS || Boolean(error);
  return {
    ...payload,
    source: 'cached',
    stale,
    scalp: payload.scalp.filter((candidate) => candidate.plan.expiresAt > now),
    swing: payload.swing.filter((candidate) => candidate.plan.expiresAt > now),
    error: error instanceof Error ? error.message : error ? '시세 갱신에 실패했습니다.' : undefined,
  };
}

export async function getDashboard(db: D1Database, now = Date.now()): Promise<DashboardPayload | null> {
  const latest = await getLatestDashboard(db);
  return latest ? cachedPayload(latest, now) : null;
}

export async function refreshDashboard(
  db: D1Database,
  options: { force?: boolean; now?: number } = {},
): Promise<DashboardPayload> {
  const now = options.now ?? Date.now();
  let latest: DashboardPayload | null = null;
  try {
    latest = await getLatestDashboard(db);
  } catch {
    latest = null;
  }
  if (!options.force && latest && now - latest.generatedAt < REFRESH_COOLDOWN_MS) {
    return cachedPayload(latest, now);
  }

  try {
    const payload = await scanMarkets(now);
    try {
      await saveDashboard(db, payload);
    } catch {
      return { ...payload, error: '분석 결과를 임시로 표시하며 저장소에는 기록하지 못했습니다.' };
    }
    return payload;
  } catch (error) {
    if (latest) return cachedPayload(latest, now, error);
    throw error;
  }
}
