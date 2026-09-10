// 가격 산식은 유지하면서 추천을 저장·추적하고 확정 종가로 손절을 판정한다.

// runtime/engine.ts
import { setTimeout as sleep2 } from "node:timers/promises";
import { createInterface } from "node:readline";

// lib/cycle-store.ts
async function writeStoredPlans(db, result) {
  await db.prepare("UPDATE market_analysis SET result_json = ? WHERE market = ?").bind(JSON.stringify(result), result.market).run();
}
async function ensureCycleSchema(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS scan_results (id INTEGER PRIMARY KEY AUTOINCREMENT, generated_at INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS market_analysis (market TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, result_json TEXT NOT NULL, candles_json TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS scan_lease (id INTEGER PRIMARY KEY, until_ms INTEGER NOT NULL, token TEXT NOT NULL, last_run INTEGER NOT NULL)"),
    db.prepare("INSERT OR IGNORE INTO scan_lease VALUES (1, 0, '', 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS paper_signals (id TEXT PRIMARY KEY, variant TEXT NOT NULL, market TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS paper_market_status ON paper_signals (market, status)"),
    db.prepare("CREATE TABLE IF NOT EXISTS symbol_detail_cache (market TEXT PRIMARY KEY, payload_json TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS candle_cache (market TEXT PRIMARY KEY, candles_json TEXT NOT NULL)")
  ]);
}
async function acquireCycle(db, now) {
  const token = crypto.randomUUID();
  const row = await db.prepare("UPDATE scan_lease SET until_ms = ?, token = ?, last_run = ? WHERE id = 1 AND until_ms <= ? AND last_run <= ? RETURNING token").bind(now + 18e4, token, now, now, now - 5e4).first();
  return row?.token ?? null;
}
async function releaseCycle(db, token) {
  await db.prepare("UPDATE scan_lease SET until_ms = 0 WHERE id = 1 AND token = ?").bind(token).run();
}
async function marketRows(db) {
  return (await db.prepare("SELECT market, checked_at, result_json FROM market_analysis").all()).results;
}
async function readCandles(db, market) {
  const row = await db.prepare("SELECT candles_json FROM candle_cache WHERE market = ?").bind(market).first()
    ?? await db.prepare("SELECT candles_json FROM market_analysis WHERE market = ?").bind(market).first();
  return row ? JSON.parse(row.candles_json) : null;
}
async function writeCandles(db, market, candles) {
  await db.prepare("INSERT INTO candle_cache VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET candles_json=excluded.candles_json")
    .bind(market, JSON.stringify(candles)).run();
}
async function writeMarket(db, result, candles, checkedAt = result.analyzedAt) {
  await db.prepare("INSERT INTO market_analysis VALUES (?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET checked_at=excluded.checked_at, result_json=excluded.result_json, candles_json=excluded.candles_json").bind(result.market, checkedAt, JSON.stringify(result), JSON.stringify(candles)).run();
}

// lib/database.ts
async function getLatestDashboard(db) {
  const row = await db.prepare("SELECT payload_json FROM scan_results ORDER BY generated_at DESC, id DESC LIMIT 1").first();
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}
async function saveDashboard(db, payload) {
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO scan_results (generated_at, status, payload_json, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(payload.generatedAt, payload.stale ? "partial" : "ok", JSON.stringify(payload), now),
    db.prepare(
      `DELETE FROM scan_results
       WHERE id NOT IN (SELECT id FROM scan_results ORDER BY generated_at DESC, id DESC LIMIT 96)`
    )
  ]);
}

// lib/indicators.ts
function finite(values) {
  return values.every(Number.isFinite);
}
function median(values) {
  if (values.length === 0 || !finite(values)) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function ema(values, period) {
  const result = Array(values.length).fill(null);
  if (period <= 0 || values.length < period || !finite(values)) return result;
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = seed;
  const alpha = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = values[index] * alpha + previous * (1 - alpha);
    result[index] = previous;
  }
  return result;
}
function rsi(values, period = 14) {
  const result = Array(values.length).fill(null);
  if (period <= 0 || values.length <= period || !finite(values)) return result;
  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gainSum += Math.max(change, 0);
    lossSum += Math.max(-change, 0);
  }
  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;
  const valueFromAverages = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    const strength = averageGain / averageLoss;
    return 100 - 100 / (1 + strength);
  };
  result[period] = valueFromAverages();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = valueFromAverages();
  }
  return result;
}
function trueRanges(candles) {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
}
function atr(candles, period = 14) {
  const ranges = trueRanges(candles);
  const result = Array(candles.length).fill(null);
  if (period <= 0 || ranges.length < period || !finite(ranges)) return result;
  let average = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = average;
  for (let index = period; index < ranges.length; index += 1) {
    average = (average * (period - 1) + ranges[index]) / period;
    result[index] = average;
  }
  return result;
}
function dmi(candles, period = 14) {
  const adx = Array(candles.length).fill(null);
  const plusDi = Array(candles.length).fill(null);
  const minusDi = Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period * 2) return { adx, plusDi, minusDi };
  const ranges = trueRanges(candles);
  const plusDm = candles.map((candle, index) => {
    if (index === 0) return 0;
    const up = candle.high - candles[index - 1].high;
    const down = candles[index - 1].low - candle.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = candles.map((candle, index) => {
    if (index === 0) return 0;
    const up = candle.high - candles[index - 1].high;
    const down = candles[index - 1].low - candle.low;
    return down > up && down > 0 ? down : 0;
  });
  let smoothedTr = ranges.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedPlus = plusDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  let smoothedMinus = minusDm.slice(1, period + 1).reduce((sum, value) => sum + value, 0);
  const dxValues = [];
  let previousAdx = null;
  for (let index = period; index < candles.length; index += 1) {
    if (index > period) {
      smoothedTr = smoothedTr - smoothedTr / period + ranges[index];
      smoothedPlus = smoothedPlus - smoothedPlus / period + plusDm[index];
      smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm[index];
    }
    if (smoothedTr <= 0) {
      plusDi[index] = 0;
      minusDi[index] = 0;
      dxValues.push(0);
    } else {
      const plus = 100 * smoothedPlus / smoothedTr;
      const minus = 100 * smoothedMinus / smoothedTr;
      plusDi[index] = plus;
      minusDi[index] = minus;
      dxValues.push(plus + minus === 0 ? 0 : 100 * Math.abs(plus - minus) / (plus + minus));
    }
    if (dxValues.length === period) {
      previousAdx = dxValues.reduce((sum, value) => sum + value, 0) / period;
      adx[index] = previousAdx;
    } else if (dxValues.length > period && previousAdx !== null) {
      previousAdx = (previousAdx * (period - 1) + dxValues.at(-1)) / period;
      adx[index] = previousAdx;
    }
  }
  return { adx, plusDi, minusDi };
}
function ppo(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const ppoSeries = values.map((_, index) => {
    const fastValue = fast[index];
    const slowValue = slow[index];
    return fastValue === null || slowValue === null || slowValue === 0 ? null : (fastValue - slowValue) / slowValue * 100;
  });
  const firstValid = ppoSeries.findIndex((value) => value !== null);
  const signal = Array(values.length).fill(null);
  if (firstValid >= 0) {
    const compact = ppoSeries.slice(firstValid);
    const compactSignal = ema(compact, signalPeriod);
    compactSignal.forEach((value, index) => {
      signal[firstValid + index] = value;
    });
  }
  const histogram = ppoSeries.map(
    (value, index) => value === null || signal[index] === null ? null : value - signal[index]
  );
  return { ppo: ppoSeries, signal, histogram };
}
function cmf(candles, period = 20) {
  const result = Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period) return result;
  const flows = candles.map((candle) => {
    const range = candle.high - candle.low;
    const multiplier = range === 0 ? 0 : (candle.close - candle.low - (candle.high - candle.close)) / range;
    return multiplier * candle.baseVolume;
  });
  for (let index = period - 1; index < candles.length; index += 1) {
    const start = index - period + 1;
    const volume = candles.slice(start, index + 1).reduce((sum, candle) => sum + candle.baseVolume, 0);
    const flow = flows.slice(start, index + 1).reduce((sum, value) => sum + value, 0);
    result[index] = volume === 0 ? null : flow / volume;
  }
  return result;
}
function rvol(candles, period = 20) {
  const result = Array(candles.length).fill(null);
  if (period <= 0) return result;
  for (let index = period; index < candles.length; index += 1) {
    const baseline = median(candles.slice(index - period, index).map((candle) => candle.quoteVolume));
    result[index] = baseline === null || baseline <= 0 ? null : candles[index].quoteVolume / baseline;
  }
  return result;
}
function donchianHigh(candles, period = 20) {
  const result = Array(candles.length).fill(null);
  if (period <= 0) return result;
  for (let index = period; index < candles.length; index += 1) {
    result[index] = Math.max(...candles.slice(index - period, index).map((candle) => candle.high));
  }
  return result;
}
function lastConfirmedPivotLow(candles, left = 2, right = 2) {
  if (left < 1 || right < 1 || candles.length < left + right + 1) return null;
  let latest = null;
  for (let index = left; index <= candles.length - right - 1; index += 1) {
    const candidate = candles[index].low;
    const neighbors = candles.slice(index - left, index + right + 1);
    if (neighbors.every((candle, offset) => offset === left || candidate <= candle.low)) {
      latest = { index, price: candidate };
    }
  }
  return latest;
}
function buildChartPoints(candles, limit = 64) {
  const visibleLimit = Math.max(0, Math.floor(limit));
  if (visibleLimit === 0) return [];
  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  return candles.slice(-visibleLimit).map((candle, visibleIndex) => {
    const index = candles.length - Math.min(visibleLimit, candles.length) + visibleIndex;
    return {
      time: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      quoteVolume: candle.quoteVolume,
      ema20: ema20[index],
      ema50: ema50[index],
      ema200: ema200[index]
    };
  });
}
function lastValue(series) {
  return series.length === 0 ? null : series[series.length - 1];
}

// lib/market-cycle.ts
var ENTRY_VOLUME = { scalp: 1e9, swing: 1e9 };
var SIGNAL_FRESH_MS = 20 * 6e4;
var HISTORY_BARS = 800;
var REASONS = {
  ST_SELL: "주 시간대 슈퍼트렌드 Sell · 신규 추천 제외",
  ST_PENDING: "주 시간대 완료봉·ST 이력 확인 대기",
  LOW_LIQUIDITY: "기본 시세 감시 · 24h 10억 또는 거래대금 증가 대기",
  UPPER_TREND_WAIT: "1시간·4시간 상승 구조 확인 대기",
  BTC_RISK_OFF: "BTC 위험회피 국면 · 신규 매수 대기",
  POOR_EXECUTION: "호가 데이터·물량 또는 예상 체결 비용 기준 미달",
  TREND_MISMATCH: "상승 추세 형성 대기",
  WEAK_TREND: "추세 강도 회복 대기",
  NO_BREAKOUT: "직전 20봉 고점 돌파 대기",
  NO_ENTRY_SETUP: "돌파 또는 눌림 회복 대기",
  LOW_RVOL: "신호봉 거래대금 증가 대기",
  RSI_OUT_OF_RANGE: "RSI 과열 또는 모멘텀 부족",
  OVEREXTENDED: "추격 구간 · 진입 가격으로 복귀 대기",
  PUMP_CANDLE: "비정상 급등 봉 · 안정 대기",
  CURRENT_PRICE_OUTSIDE_ENTRY: "현재가가 진입 허용 구간을 벗어남",
  RISK_TOO_WIDE: "손절 거리 과다",
  POOR_NET_RR: "비용 반영 손익비 부족",
  NO_CONFIRMED_SWING_LOW: "확인된 지지 저점 대기",
  INVALID_PRICE_PLAN: "유효한 가격 계획 없음",
  SCORE_TOO_LOW: "진입 신호는 있으나 종합 점수 부족",
  INSUFFICIENT_DATA: "캔들 이력 부족",
  MISSING_RECENT_CANDLES: "최근 무거래·누락 봉 확인 필요",
  INDICATOR_WARMUP: "지표 계산 이력 부족",
  ENTRY_DATA_MISSING: "진입 구간 이력 부족",
  ZERO_ATR: "가격 변동 데이터 부족",
  DATA_DELAYED: "분석 지연 · 재분석 대기",
  HISTORY_SHORT: "신규 상장 · 가격 계산 이력 부족",
  NO_TRADE: "최근 완료 시간대 무거래 · 신규 진입 보류",
  NO_RESISTANCE_ROOM: "가까운 목표 근거 부족 또는 비용 후 상승 여력 부족",
  ENGINE_WARMUP: "새 지표 이력 준비 · 순차 재분석 대기",
  SAVED_PLAN_WAITING: "가격 계획 보존 · 신규 진입 대기"
};
function isAnalysisMarket(market) {
  return !market.warned && market.market !== "KRW-USDT";
}
function nextMarkets(markets, tickers, checked) {
  const volumes = new Map(tickers.map((t) => [t.market, t.quoteVolume24h]));
  return markets.filter((m) => isAnalysisMarket(m) && volumes.has(m.market)).sort((a, b) => (checked.get(a.market) ?? 0) - (checked.get(b.market) ?? 0) || (volumes.get(b.market) ?? 0) - (volumes.get(a.market) ?? 0) || a.market.localeCompare(b.market));
}
function emptyCandles() {
  return { "15": [], "60": [], "240": [] };
}
function activityRatio(candles, current24h) {
  if (candles.length < 96) return null;
  const average = candles.slice(-96, -24).reduce((sum, candle) => sum + candle.quoteVolume, 0) / 3;
  return average > 0 ? current24h / average : null;
}
function entryStillValid(candidate, price, now) {
  const tolerance = (candidate.plan.entryHigh - candidate.plan.entryLow) * 0.625;
  return (candidate.entryValidUntil ?? candidate.plan.expiresAt) > now && (!candidate.entryStatus || candidate.entryStatus === "ready") && price > candidate.plan.stop && price < candidate.plan.targets[0] && price >= candidate.plan.entryLow - tolerance && price <= candidate.plan.entryHigh + tolerance;
}
function makeObservation(input, strategy, result, now) {
  const candles = input.candles[strategy === "scalp" ? "15" : "240"];
  const closes = candles.map((c) => c.close);
  const e20 = lastValue(ema(closes, 20));
  const e50 = lastValue(ema(closes, 50));
  const strength = lastValue(rsi(closes, 14));
  const trendScore = (e20 && e50 && e20 > e50 ? 40 : 0) + (e20 && input.ticker.tradePrice > e20 ? 20 : 0) + (strength !== null && strength >= 45 && strength <= 70 ? 20 : 0) + (input.ticker.quoteVolume24h >= ENTRY_VOLUME[strategy] ? 20 : 0);
  const code = !input.liquidityQualified && input.ticker.quoteVolume24h < ENTRY_VOLUME[strategy] ? "LOW_LIQUIDITY" : result.accepted ? "SCORE_TOO_LOW" : result.code;
  return {
    market: input.market.market,
    koreanName: input.market.koreanName,
    strategy,
    currentPrice: input.ticker.tradePrice,
    quoteVolume24h: input.ticker.quoteVolume24h,
    analyzedAt: now,
    code,
    reason: REASONS[code] ?? code,
    trendScore
  };
}

// lib/execution-warning.ts
function withSpreadWarning(warnings, strategy, spreadPct) {
  const retained = warnings.filter((warning) => !warning.startsWith("호가 스프레드 "));
  const threshold = strategy === "scalp" ? 0.2 : 0.35;
  if (Number.isFinite(spreadPct) && spreadPct > threshold) {
    retained.push(`호가 스프레드 ${spreadPct.toFixed(3)}% · 시장가 체결 주의. 후보 제외·점수 감점에는 사용하지 않습니다.`);
  }
  return retained;
}

// lib/trend-state.ts
function initial() {
  return {
    version: 1,
    lastClose: 0,
    count: 0,
    previousClose: null,
    trSeed: [],
    atr10: null,
    atr200: null,
    atrWindow: [],
    highs: [],
    lows: [],
    stLower: null,
    stUpper: null,
    stDirection: 1,
    ttUpper: null,
    ttLower: null,
    ttDirection: null,
    signal: null,
    history: []
  };
}
var mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
function advanceTrends(candles, previous, asOf = Infinity) {
  const closed = candles.filter((c) => c.closeTime <= asOf);
  const pending = closed.filter((c) => c.closeTime > (previous?.lastClose ?? 0));
  const contiguous = !previous || !pending.length || pending[0].openTime === previous.lastClose;
  const state = previous?.version === 1 && contiguous ? structuredClone(previous) : initial();
  if (state.signal && state.signal.reached === undefined) {
    state.signal.reached = 0;
    for (const bar of closed.filter((b) => !b.synthetic && b.openTime >= state.signal.time && b.closeTime <= state.lastClose)) {
      while (state.signal.reached < 3 && bar.high >= state.signal.targets[state.signal.reached]) {
        state.signal.reached++;
        if (state.signal.reached === 3) state.signal.completedAt ??= bar.closeTime;
      }
    }
  }
  for (const bar of closed) {
    if (bar.closeTime <= state.lastClose) continue;
    const pc = state.previousClose;
    const tr = pc === null ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
    state.count++;
    if (state.trSeed.length < 200) state.trSeed.push(tr);
    state.atr10 = state.atr10 === null ? state.count === 10 ? mean(state.trSeed) : null : (state.atr10 * 9 + tr) / 10;
    state.atr200 = state.atr200 === null ? state.count === 200 ? mean(state.trSeed) : null : (state.atr200 * 199 + tr) / 200;
    if (state.atr200 !== null) {
      state.atrWindow.push(state.atr200);
      if (state.atrWindow.length > 200) state.atrWindow.shift();
    }
    state.highs.push(bar.high);
    state.lows.push(bar.low);
    if (state.highs.length > 10) {
      state.highs.shift();
      state.lows.shift();
    }
    if (state.atr10 !== null) {
      const basicLower = (bar.high + bar.low) / 2 - 3 * state.atr10;
      const basicUpper = (bar.high + bar.low) / 2 + 3 * state.atr10;
      const lower1 = state.stLower ?? basicLower;
      const upper1 = state.stUpper ?? basicUpper;
      state.stLower = pc !== null && pc > lower1 ? Math.max(basicLower, lower1) : basicLower;
      state.stUpper = pc !== null && pc < upper1 ? Math.min(basicUpper, upper1) : basicUpper;
      if (state.stDirection === -1 && bar.close > upper1) state.stDirection = 1;
      else if (state.stDirection === 1 && bar.close < lower1) state.stDirection = -1;
    }
    if (state.atrWindow.length === 200) {
      const width = mean(state.atrWindow) * 0.8;
      const upper = mean(state.highs) + width;
      const lower = mean(state.lows) - width;
      const previousDirection = state.ttDirection;
      if (pc !== null && state.ttUpper !== null && pc <= state.ttUpper && bar.close > upper) state.ttDirection = true;
      if (pc !== null && state.ttLower !== null && pc >= state.ttLower && bar.close < lower) state.ttDirection = false;
      if (state.ttDirection === true && previousDirection === false) {
        state.signal = { time: bar.closeTime, entry: bar.close, stop: lower, reached: 0, targets: [5, 10, 15].map((k) => bar.close + k * width), width };
      }
      if (state.ttDirection === false) state.signal = null;
      state.ttUpper = upper;
      state.ttLower = lower;
    }
    if (state.signal && !bar.synthetic && bar.openTime >= state.signal.time) {
      while ((state.signal.reached ?? 0) < 3 && bar.high >= state.signal.targets[state.signal.reached ?? 0]) {
        state.signal.reached = (state.signal.reached ?? 0) + 1;
        if (state.signal.reached === 3) state.signal.completedAt ??= bar.closeTime;
      }
    }
    state.previousClose = bar.close;
    state.lastClose = bar.closeTime;
    state.history.push({
      time: bar.openTime,
      supertrend: state.stDirection === 1 ? state.stLower : state.stUpper,
      targetBand: state.ttDirection === true ? state.ttLower : state.ttDirection === false ? state.ttUpper : null
    });
    if (state.history.length > 64) state.history.shift();
  }
  return state;
}

// lib/tick-size.ts
function krwTickSize(price) {
  if (price >= 1e6) return 1e3;
  if (price >= 5e5) return 500;
  if (price >= 1e5) return 100;
  if (price >= 5e4) return 50;
  if (price >= 1e4) return 10;
  if (price >= 5e3) return 5;
  if (price >= 1e3) return 1;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 1e-3;
  if (price >= 0.01) return 1e-4;
  if (price >= 1e-3) return 1e-5;
  if (price >= 1e-4) return 1e-6;
  if (price >= 1e-5) return 1e-7;
  return 1e-8;
}
function resolvedKrwTickSize(price, instrumentTickSize, referencePrice) {
  const policyTick = krwTickSize(price);
  const referencePolicyTick = krwTickSize(referencePrice);
  return policyTick === referencePolicyTick && Number.isFinite(instrumentTickSize) && instrumentTickSize > 0 ? instrumentTickSize : policyTick;
}

// lib/confluence-plan.ts
function confirmedPivots(candles) {
  const points = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const nearby = candles.slice(i - 2, i + 3);
    if (nearby.some((c) => c.synthetic)) continue;
    for (const kind of ["high", "low"]) {
      const value = candles[i][kind];
      if (nearby.every((c, j) => j === 2 || (kind === "high" ? j < 2 ? value >= c.high : value > c.high : j < 2 ? value <= c.low : value < c.low))) {
        points.push({ price: value, index: i, time: candles[i].openTime, confirmedAt: candles[i + 2].closeTime, kind });
      }
    }
  }
  return points;
}
function previousPeriod(candles, now, days) {
  const width = days * 864e5;
  const offset = days === 7 ? 4 * 864e5 : 0;
  const end = Math.floor((now - offset) / width) * width + offset;
  const start = end - width;
  const bars = candles.filter((c) => c.openTime >= start && c.closeTime <= end);
  if (bars.length !== days * 6 || bars.some((c, i) => c.synthetic || c.openTime !== start + i * 144e5 || c.closeTime !== c.openTime + 144e5)) return null;
  return { high: Math.max(...bars.map((c) => c.high)), low: Math.min(...bars.map((c) => c.low)), close: bars.at(-1).close, time: end };
}
function resistanceLevels(candles, strategy, now, trends) {
  const levels = [];
  const units = strategy === "scalp" ? ["15", "60", "240"] : ["60", "240"];
  for (const unit of units) {
    const bars = candles[unit].filter((c) => c.closeTime <= now).slice(-120);
    const pivots = confirmedPivots(bars);
    const waveMinimum = (lastValue(atr(bars, 14)) ?? Infinity) * 2;
    for (const p of pivots.filter((p2) => p2.kind === "high")) {
      levels.push({ price: p.price, source: `${unit}분 확정 고점`, id: `high:${p.time}:${p.price}`, structural: true });
    }
    const alternating = [];
    for (const p of pivots) {
      const last = alternating.at(-1);
      if (last?.kind === p.kind) {
        if (p.kind === "high" && p.price >= last.price || p.kind === "low" && p.price <= last.price) alternating[alternating.length - 1] = p;
      } else alternating.push(p);
    }
    for (let i = alternating.length - 1; i >= 2; i--) {
      const [a, b, c] = alternating.slice(i - 2, i + 1);
      if (a.kind !== "low" || b.kind !== "high" || c.kind !== "low" || !(a.price < c.price && c.price < b.price)) continue;
      const after = bars.slice(c.index + 1);
      if (after.some((bar) => bar.low < c.price) || bars.at(-1).close > c.price + 2 * (b.price - a.price)) break;
      if (b.price - a.price < waveMinimum) continue;
      [1, 1.272, 1.618].forEach((ratio, i2) => levels.push({
        price: c.price + (b.price - a.price) * ratio,
        source: `${unit}분 ABC 확장 ${ratio}`,
        id: `fib:${unit}:${a.time}:${b.time}:${c.time}:${ratio}`,
        structural: false,
        projection: { family: "fib", group: `fib:${unit}:${a.time}:${b.time}:${c.time}`, step: i2 + 1, timeframe: Number(unit), time: c.confirmedAt }
      }));
      break;
    }
  }
  for (const days of strategy === "scalp" ? [1] : [1, 7]) {
    const period = previousPeriod(candles["240"], now, days);
    if (!period) continue;
    const name = days === 1 ? "전일" : "전주";
    const p = (period.high + period.low + period.close) / 3;
    levels.push({ price: period.high, source: `${name} 고점`, id: `period-high:${period.time}:${days}`, structural: true });
    [2 * p - period.low, p + period.high - period.low, period.high + 2 * (p - period.low)].forEach((price, i) => {
      levels.push({
        price,
        source: `${name} Traditional R${i + 1}`,
        id: `period:${period.time}:${days}:${i}`,
        structural: false,
        projection: { family: "pivot", group: `period:${period.time}:${days}`, step: i + 1, timeframe: days * 1440, time: period.time }
      });
    });
  }
  const tt = trends[strategy === "scalp" ? "15" : "60"];
  if (tt.ttDirection === true && tt.signal && now - tt.signal.time <= (strategy === "scalp" ? 6 : 72) * 36e5) {
    tt.signal.targets.forEach((price, i) => levels.push({
      price,
      source: `TT 신호 고정 ${i + 1}차`,
      id: `tt:${tt.signal.time}:${i}`,
      structural: false,
      projection: { family: "tt", group: `tt:${tt.signal.time}`, step: i + 1, timeframe: strategy === "scalp" ? 15 : 60, time: tt.signal.time }
    }));
  }
  return levels;
}
function mergeLevels(levels, tolerance) {
  const unique = [...new Map(levels.filter((l) => Number.isFinite(l.price) && l.price > 0).map((l) => [l.id, l])).values()].sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  const zones = [];
  for (const level of unique) {
    const last = zones.at(-1);
    if (last && level.price - last.low <= tolerance) {
      last.high = level.price;
      last.levels.push(level);
    } else zones.push({ low: level.price, high: level.price, levels: [level] });
  }
  return zones;
}
function selectTargetLadder(levels, tolerance, strategy) {
  const unique = [...new Map(levels.map((level) => [level.id, level])).values()];
  const groups = /* @__PURE__ */ new Map();
  for (const level of unique) {
    if (!level.projection || !Number.isFinite(level.price)) continue;
    const key = level.projection.group;
    groups.set(key, [...groups.get(key) ?? [], level]);
  }
  const preferred = strategy === "scalp" ? 60 : 240;
  const secondary = strategy === "scalp" ? 15 : 60;
  const candidates = [...groups.entries()].flatMap(([key, group]) => {
    const ladder = [...group].sort((a, b) => a.projection.step - b.projection.step);
    if (ladder.length !== 3 || ladder.some((level, i) => level.projection.step !== i + 1 || i > 0 && level.price <= ladder[i - 1].price)) return [];
    const first = ladder[0].projection;
    const support = ladder.reduce((sum, target) => sum + new Set(unique.filter((level) => Math.abs(level.price - target.price) <= tolerance && level.projection?.family !== first.family).map((level) => level.structural ? "structure" : level.projection?.family).filter(Boolean)).size, 0);
    return [{ key, ladder, support, fit: first.timeframe === preferred ? 2 : first.timeframe === secondary ? 1 : 0, time: first.time }];
  });
  candidates.sort((a, b) => b.support - a.support || b.fit - a.fit || b.time - a.time || a.key.localeCompare(b.key));
  return candidates[0]?.ladder ?? [];
}
function costedPlan(plan, feeRate, slippagePct) {
  if (!Number.isFinite(slippagePct)) return { ...plan, netReturns: void 0, netSplitReturn: null, netRewardRiskAtTarget2: 0 };
  const cost = feeRate + slippagePct / 100;
  const entry = plan.entryAnchor * (1 + cost);
  const netReturns = plan.targets.map((target) => (target * (1 - cost) / entry - 1) * 100);
  const loss = entry - plan.stop * (1 - cost);
  return {
    ...plan,
    grossReturns: plan.targets.map((t) => (t / plan.entryAnchor - 1) * 100),
    netReturns,
    netSplitReturn: plan.targets.length === 3 ? netReturns.reduce((a, b) => a + b, 0) / 3 : null,
    netRewardRiskAtTarget2: plan.targets.length > 1 && loss > 0 ? (plan.targets[1] * (1 - cost) - entry) / loss : 0
  };
}
function buildConfluencePlan(args) {
  const tick = (price) => resolvedKrwTickSize(price, args.execution.tickSize, args.execution.tickSizeReferencePrice);
  const round = (price, direction) => {
    const step = tick(price);
    return Number(((direction === "up" ? Math.ceil(price / step) : direction === "down" ? Math.floor(price / step) : Math.round(price / step)) * step).toPrecision(15));
  };
  const entryLow = round(args.entryLow, "up"), entryHigh = round(args.entryHigh, "down"), entryAnchor = round(args.entryAnchor, "near");
  const stop = round(args.rawStop, "down");
  if (!(stop > 0 && stop < entryLow && entryLow <= entryAnchor && entryAnchor <= entryHigh)) return null;
  const tolerance = Math.max(2 * tick(entryAnchor), args.atr * 0.15);
  const eligible = args.levels.filter((l) => Number.isFinite(l.price) && l.price > entryHigh);
  const ladder = selectTargetLadder(eligible, tolerance, args.strategy);
  const targets = [], evidence = [];
  for (const level of ladder) {
    const target = round(level.price - tick(level.price), "down");
    if (target <= entryHigh) return null;
    if (target <= (targets.at(-1) ?? entryHigh)) return null;
    targets.push(target);
    const supporting = eligible.filter((other) => Math.abs(other.price - level.price) <= tolerance);
    evidence.push({
      low: Math.min(...supporting.map((l) => l.price)),
      high: Math.max(...supporting.map((l) => l.price)),
      kind: "projection",
      reasons: [.../* @__PURE__ */ new Set([level.source, ...supporting.map((l) => l.source)])]
    });
  }
  if (targets.length !== 3) return null;
  const intermediateResistances = mergeLevels(eligible.filter((l) => l.structural && l.price < targets[2] && !ladder.some((target) => Math.abs(target.price - l.price) <= tolerance)), tolerance).map((zone) => ({ price: zone.low, reasons: [...new Set(zone.levels.map((l) => l.source))] }));
  const plan = costedPlan({
    entryLow,
    entryAnchor,
    entryHigh,
    stop,
    targets,
    riskPct: (entryAnchor - stop) / entryAnchor * 100,
    netRewardRiskAtTarget2: 0,
    expiresAt: args.expiresAt,
    version: "indicator-v4",
    id: `v4:${args.market}:${args.strategy}:${args.signalTime}`,
    issuedAt: args.signalTime,
    entryReason: args.entryReason,
    stopReason: args.stopReason,
    targetEvidence: evidence,
    intermediateResistances,
    targetMethod: `${ladder[0].source} 기준 지표 단계 · 독립 근거 중첩/시간대/최신성 순 선택`
  }, args.feeRate, args.execution.buySlippagePct);
  return (plan.netReturns?.[0] ?? -1) > 0 ? plan : null;
}

// lib/opportunity.ts
// 완료 일봉의 역배열 탈출과 최근 3~5일 수급 변화를 선별 근거로 보관한다.
var MA_PERIODS = [7, 20, 30, 60, 100, 200, 240, 365];
function simpleAverage(values, length) {
  return values.length >= length && values.slice(-length).every(Number.isFinite)
    ? values.slice(-length).reduce((sum, n) => sum + n, 0) / length : null;
}
function movingAverageState(candles) {
  const closes = candles.map((c) => c.close);
  const at = (offset = 0) => Object.fromEntries(MA_PERIODS.map((p) => [p, simpleAverage(offset ? closes.slice(0, -offset) : closes, p)]));
  const ma = at(), previous = at(3);
  const slopes = Object.fromEntries(MA_PERIODS.map((p) => [p, ma[p] !== null && previous[p] !== null ? ma[p] - previous[p] : null]));
  // 표시는 직전 완료 봉 대비, 선별용 slopes는 기존 3봉 대비를 유지한다.
  const previousBarChanges = Object.fromEntries(MA_PERIODS.map((p) => [p,
    ma[p] !== null && closes.length > p && Number.isFinite(closes.at(-p - 1)) ? (closes.at(-1) - closes.at(-p - 1)) / p : null]));
  const available = MA_PERIODS.filter((p) => ma[p] !== null);
  const pairs = available.slice(1).map((p, i) => [available[i], p]);
  const alignment = pairs.length < 2 ? "unknown" : pairs.every(([a, b]) => ma[a] > ma[b]) ? "bullish" : pairs.every(([a, b]) => ma[a] < ma[b]) ? "bearish" : "mixed";
  const crosses = [];
  for (let offset = 0; offset < 5; offset++) {
    const current = at(offset), past = at(offset + 1);
    for (const a of [7, 20, 30]) for (const b of [60, 100, 200, 240, 365]) {
      if ([current[a], current[b], past[a], past[b]].every((v) => v !== null) && current[a] > current[b] && past[a] <= past[b]) crosses.push(`${a}→${b}`);
    }
  }
  const reverseRecently = Array.from({ length: 20 }, (_, i) => at(i + 1)).some((p) => p[60] !== null && p[20] < p[60] && (p[100] === null || p[60] < p[100]));
  const compressing = ma[60] !== null && previous[60] !== null && ma[20] / ma[60] > previous[20] / previous[60];
  const turning = reverseRecently && ma[7] > ma[20] && closes.at(-1) > ma[20] && slopes[7] > 0 && slopes[20] > 0 && (compressing || crosses.length > 0);
  const up = ma[60] !== null && closes.at(-1) > ma[20] && ma[20] > ma[60] && slopes[20] > 0 && slopes[60] > 0;
  const state = ma[60] === null || previous[60] === null ? "unknown" : turning ? "transition" : up ? "up" : closes.at(-1) < ma[20] && slopes[20] < 0 ? "down" : "mixed";
  return { state, alignment, ma, slopes, previousBarChanges, available, crosses: [...new Set(crosses)], compressing, reverseRecently };
}
function dailySetups(bars, trend) {
  const closes = bars.map((c) => c.close), close = closes.at(-1), ma = trend.ma;
  const range = lastValue(atr(bars, 14));
  const valueAt = (period, offset) => simpleAverage(offset ? closes.slice(0, -offset) : closes, period);
  // 과거 각 봉 당시의 이평선을 사용한다. 미래 지지 성공이나 진입 필수 조건이 아니다.
  const supports = [7, 20, 60, 100, 200].filter((p) => {
    if (!(range > 0) || ma[p] === null || trend.slopes[p] === null || trend.slopes[p] < 0 || close < ma[p]) return false;
    let holds = 0, approaches = 0;
    for (let offset = 0; offset < 5; offset++) {
      const b = bars.at(-offset - 1), level = valueAt(p, offset);
      if (!b || level === null) continue;
      if (b.close >= level) {
        holds++;
        if (b.low <= level + range * 0.35 && b.low >= level - range * 0.5) approaches++;
      }
    }
    return holds >= 4 && approaches > 0;
  });
  const breakouts = [60, 100, 200].filter((p) => ma[p] !== null && close > ma[p] && [0, 1, 2].some((offset) => {
    const current = valueAt(p, offset), past = valueAt(p, offset + 1);
    return current !== null && past !== null && closes.at(-offset - 1) > current && closes.at(-offset - 2) <= past;
  }));
  const healthy = ma[20] !== null && close >= ma[20] && trend.slopes[20] > 0;
  const maintaining = healthy && supports.includes(7) && close - ma[7] <= range;
  const pullback = healthy && close < ma[7] && close - ma[20] <= range;
  const labels = [], reasons = [];
  if (breakouts.length) { labels.push("돌파·전환형"); reasons.push(`${breakouts.join("·")}일선 최근 3봉 내 상향 돌파`); }
  if (maintaining) { labels.push("추세 유지형"); reasons.push("상승 7일선 위 가격 유지 · 최근 5봉 중 4봉 이상"); }
  if (pullback) { labels.push("눌림형"); reasons.push("상승 20일선 부근 눌림 · 지지 성공 확정 아님"); }
  if (!labels.length && trend.state === "transition") { labels.push("돌파·전환형"); reasons.push("일봉 역배열 간격 축소·단기선 상승 전환"); }
  if (!labels.length && trend.state === "up") { labels.push("상승 추세형"); reasons.push("일봉 상승 배열 유지"); }
  if (!labels.length) reasons.push("일봉 매수 배경 확인 대기");
  const gain20Pct = bars.length >= 20 ? (close / Math.min(...bars.slice(-20).map((c) => c.low)) - 1) * 100 : null;
  const extension20Pct = ma[20] > 0 ? (close / ma[20] - 1) * 100 : null;
  const early = gain20Pct !== null && extension20Pct !== null && gain20Pct <= 20 && extension20Pct <= 8;
  const reversalPreparing = trend.reverseRecently && trend.compressing && ma[7] >= ma[20] && trend.slopes[7] > 0 && close >= ma[20];
  return { supports, breakouts, maintaining, pullback, labels, reasons,
    preparation: { early, gain20Pct, extension20Pct, reversalPreparing, supports: supports.filter((p) => p >= 60) } };
}
function dailySelection(candles = [], now) {
  const bars = candles.filter((c) => c.closeTime <= boundaryFor(1440, now));
  const trend = movingAverageState(bars);
  const ready = bars.length >= 63 && bars.at(-1).closeTime === boundaryFor(1440, now)
    && bars.slice(-25).every((c, i, recent) => !c.synthetic && (!i || c.openTime === recent[i - 1].closeTime));
  const baseline = bars.slice(-25, -5);
  const averageVolume = simpleAverage(baseline.map((c) => c.baseVolume), 20);
  const averageTurnover = simpleAverage(baseline.map((c) => c.quoteVolume), 20);
  const recent = bars.slice(-5), last3 = recent.slice(-3);
  const ratio = averageVolume > 0 ? simpleAverage(last3.map((c) => c.baseVolume), 3) / averageVolume : null;
  const turnoverRatio = averageTurnover > 0 ? simpleAverage(last3.map((c) => c.quoteVolume), 3) / averageTurnover : null;
  const burst = ready && averageVolume > 0 && recent.some((c) => c.baseVolume >= averageVolume * 2 && c.quoteVolume >= 1e7);
  const increasing = ready && last3.length === 3 && last3[0].baseVolume > 0 && last3[1].baseVolume > last3[0].baseVolume && last3[2].baseVolume > last3[1].baseVolume && last3[2].baseVolume >= last3[0].baseVolume * 1.5;
  const growth = burst || increasing || ratio >= 1.5;
  const setups = dailySetups(bars, trend);
  const contracting = ready && last3.every((c, i) => !i || c.baseVolume < last3[i - 1].baseVolume);
  const concentrated = ready && last3.some((c) => averageVolume > 0 && c.baseVolume >= averageVolume * 2 && c.quoteVolume >= 1e7)
    && last3.reduce((n, c) => n + c.baseVolume, 0) > 0
    && Math.max(...last3.map((c) => c.baseVolume)) / last3.reduce((n, c) => n + c.baseVolume, 0) >= 0.7;
  const flow = concentrated && burst ? { type: "burst", reason: "최근 거래량 하루 급증 집중" }
    : increasing ? { type: "increasing", reason: "3일 거래량 연속 증가" }
    : contracting ? { type: "contracting", reason: "최근 3일 거래량 감소 · 눌림/추세와 함께 판단" }
    : burst ? { type: "burst", reason: "최근 5일 거래량 급증 이력" }
    : ratio >= 1.5 ? { type: "increasing", reason: "최근 3일 평균 거래량 증가" }
    : { type: "neutral", reason: "거래량 뚜렷한 증가 없음" };
  const preparation = setups.preparation;
  const promising = ready && preparation.early && (preparation.reversalPreparing && growth || preparation.supports.length > 0);
  const reasons = [preparation.supports.length ? `${preparation.supports.join("·")}일선 부근 유지·상승 준비`
    : preparation.reversalPreparing ? "역배열 간격 축소·상승 준비" : "상승 준비 구조 확인 대기", flow.reason];
  const bonus = ready ? (setups.maintaining || setups.pullback || setups.breakouts.length ? 8 : trend.state === "transition" ? 8 : trend.state === "up" ? 4 : 0)
    + (flow.type === "increasing" ? 5 : flow.type === "burst" ? 3 : 0) : 0;
  return { version: 2, ready, candleClose: bars.at(-1)?.closeTime ?? 0, trend, ratio, turnoverRatio, burst, increasing,
    promising, preparation, flow, recommendation: { labels: ready ? setups.labels : [], reasons: ready ? [...setups.reasons, flow.reason] : ["완료 일봉 이력 확인 대기"] },
    score: promising ? 50 + (preparation.reversalPreparing ? 10 : 0) + (preparation.supports.length ? 10 : 0)
      + (flow.type === "increasing" ? 15 : flow.type === "burst" ? 8 : 0) : 0,
    bonus, reasons };
}
function applyDailySelection(candidate, selection, now) {
  return { ...candidate, score: Math.min(100, candidate.score + selection.bonus), selectionVersion: 2, rankingAt: now,
    metrics: { ...candidate.metrics, dailySelection: selection },
    reasons: [...candidate.reasons, ...selection.recommendation.reasons],
    currentAssessment: { version: 2, asOf: now, candleClose: selection.candleClose,
      labels: selection.recommendation.labels, reasons: selection.recommendation.reasons, flow: selection.flow } };
}
function promisingMarkets(results, markets, tickers, excluded, now) {
  const safe = new Map(markets.filter(isAnalysisMarket).map((m) => [m.market, m]));
  const quotes = new Map(tickers.map((t) => [t.market, t]));
  return results.filter((r) => safe.has(r.market) && !excluded.has(r.market) && r.selection?.version === 2 && r.selection.promising
    && r.dailyQuality?.ready && r.dailyQuality.latestActualClose === boundaryFor(1440, now)
    && r.selection.candleClose === boundaryFor(1440, now) && quotes.get(r.market)?.timestamp >= now - 180000
    && quotes.get(r.market)?.quoteVolume24h >= 1e7)
    .map((r) => ({ market: r.market, koreanName: safe.get(r.market).koreanName, currentPrice: quotes.get(r.market).tradePrice,
      currentPriceAt: quotes.get(r.market).timestamp, quoteVolume24h: quotes.get(r.market).quoteVolume24h,
      score: r.selection.score, reason: r.selection.reasons.join(" · "), selection: r.selection, dailyQuality: r.dailyQuality }))
    .sort((a, b) => b.score - a.score || b.quoteVolume24h - a.quoteVolume24h || a.market.localeCompare(b.market)).slice(0, 10);
}
var TURNOVER_MIN = 1e9;
function screenLiquidity(hourly, now) {
  const end = Math.floor(now / 36e5) * 36e5;
  const bars = hourly.filter((c) => c.closeTime <= end);
  const contiguous = (count) => bars.length >= count && bars.slice(-count).every((c, i) => c.openTime === end - (count - i) * 36e5 && c.closeTime === c.openTime + 36e5 && Number.isFinite(c.quoteVolume) && c.quoteVolume >= 0);
  const sum = (start, stop) => bars.slice(start, stop).reduce((n, c) => n + c.quoteVolume, 0);
  const days = contiguous(72) ? [sum(-72, -48), sum(-48, -24), sum(-24)] : null;
  const priorHour = contiguous(21) ? sum(-21, -1) / 20 : 0;
  const lastHour = bars.at(-1)?.quoteVolume ?? 0;
  const hourlyRatio = priorHour > 0 ? lastHour / priorHour : null;
  return {
    checkedAt: now,
    candleClose: bars.at(-1)?.closeTime ?? 0,
    increasing: !!days && days[0] > 0 && days[1] > days[0] && days[2] > days[1] && days[2] >= days[0] * 1.5,
    // 거래가 거의 없던 시장의 극단적 비율은 급증 근거로 사용하지 않는다.
    burst: hourlyRatio !== null && hourlyRatio >= 2 && lastHour >= 1e7,
    hourlyRatio,
    average3d: contiguous(96) ? sum(-96, -24) / 3 : null
  };
}
function frameStructure(candles, previousTrend) {
  if (candles.length < 60) return { ready: false, alive: false, early: false, score: 0, reason: "추세 이력 준비" };
  const recent = candles.slice(-12);
  if (recent.some((c, i) => c.synthetic || i > 0 && c.openTime !== recent[i - 1].closeTime)) {
    return { ready: false, alive: false, early: false, score: 0, reason: "최근 누락 봉 확인 필요" };
  }
  const closes = candles.map((c) => c.close);
  const ma = ema(closes, 20);
  const e20 = lastValue(ma);
  const e50 = lastValue(ema(closes, 50));
  const latest = candles.at(-1);
  const pivots = confirmedPivots(candles.slice(-60));
  const lows = pivots.filter((p) => p.kind === "low").slice(-2);
  const high = pivots.filter((p) => p.kind === "high").at(-1);
  const heldLow = lows.length > 0 && latest.close > lows.at(-1).price && !candles.some((c) => c.openTime > lows.at(-1).time && c.low < lows.at(-1).price);
  const higherLow = lows.length === 2 && lows[1].price > lows[0].price && heldLow;
  const slopeUp = e20 > (ma.at(-4) ?? Infinity);
  const st = previousTrend ?? advanceTrends(candles);
  const established = st.stDirection === 1 && slopeUp && latest.close > e20 && (e20 > e50 || higherLow) && (lows.length === 0 || heldLow);
  const early = higherLow && !!high && latest.close > high.price && latest.close > e20 && slopeUp;
  const alive = established || early;
  return {
    ready: true,
    alive,
    early: early && !established,
    score: alive ? established ? 85 : 70 : higherLow ? 50 : slopeUp ? 30 : 10,
    reason: alive ? established ? "상승 구조 유지" : "저점 상승·확정 고점 회복" : higherLow ? "저점 상승 · 고점 회복 대기" : "하락 구조 전환 대기"
  };
}
function upperStructure(candles, now, trends) {
  const h1 = frameStructure(candles["60"].filter((c) => c.closeTime <= now), trends?.["60"]);
  const h4 = frameStructure(candles["240"].filter((c) => c.closeTime <= now), trends?.["240"]);
  const fresh = [60, 240].every((unit) => candles[String(unit)].at(-1)?.closeTime === Math.floor(now / (unit * 6e4)) * unit * 6e4);
  return {
    h1,
    h4,
    ready: h1.ready && h4.ready && fresh,
    alive: h1.alive && h4.alive && fresh,
    early: h1.early || h4.early,
    score: Math.round((h1.score + h4.score) / 2),
    reason: !fresh ? "상위 시간대 최신 봉 확인 대기" : `4시간 ${h4.reason} · 1시간 ${h1.reason}`
  };
}
function dailyContext(candles, now) {
  const end = Math.floor(now / 864e5) * 864e5;
  const groups = /* @__PURE__ */ new Map();
  for (const c of candles.filter((c2) => c2.closeTime <= end)) {
    const day = Math.floor(c.openTime / 864e5) * 864e5;
    groups.set(day, [...groups.get(day) ?? [], c]);
  }
  const complete = [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([day, bars]) => bars.length === 6 && bars.every((c, i) => !c.synthetic && c.openTime === day + i * 144e5));
  const last = complete.slice(-23);
  if (last.length < 23 || last.some(([day], i) => day !== end - (23 - i) * 864e5)) return "unknown";
  const closes = last.map(([, bars]) => bars[5].close);
  const ma = ema(closes, 20);
  return closes.at(-1) > lastValue(ma) && lastValue(ma) > ma.at(-3) ? "up" : "down";
}

// lib/strategy.ts
function reject(category, code) {
  return { accepted: false, category, code };
}
function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
function trendSet(input) {
  return input.trends ?? { "15": advanceTrends(input.candles["15"]), "60": advanceTrends(input.candles["60"]), "240": advanceTrends(input.candles["240"]) };
}
function hasRecentSynthetic(candles, count) {
  return candles.slice(-count).some((candle) => candle.synthetic);
}
function chartSet(input) {
  if (input.includeCharts === false) return { "15": [], "60": [], "240": [] };
  const charts = {
    "15": buildChartPoints(input.candles["15"]),
    "60": buildChartPoints(input.candles["60"]),
    "240": buildChartPoints(input.candles["240"])
  };
  const trends = trendSet(input);
  for (const unit of ["15", "60", "240"]) {
    const points = new Map(trends[unit].history.map((point) => [point.time, point]));
    charts[unit] = charts[unit].map((point) => ({ ...point, supertrend: points.get(point.time)?.supertrend ?? null, targetBand: points.get(point.time)?.targetBand ?? null }));
  }
  return charts;
}
function turnoverClass(cache, now) {
  const end = boundaryFor(60, now), start = end - 72 * 3600000;
  const bars = (cache[60] ?? []).filter((b) => b.closeTime <= end), first = bars[0];
  const exhausted = cache.collection?.[60]?.exhausted === true;
  const recent = bars.filter((b) => b.openTime >= start);
  const covered = !bars.length && exhausted && cache.collection?.[60]?.checkedAt >= end
    || !!first && (first.openTime <= start || exhausted) && bars.at(-1)?.closeTime === end;
  const valid = recent.every((b, i) => (!b.synthetic || b.noTrade === true) && Number.isFinite(b.quoteVolume) && b.quoteVolume >= 0
    && b.closeTime === b.openTime + 3600000 && (!i || b.openTime === recent[i - 1].closeTime));
  let total = 0, correction = 0;
  for (const bar of recent) {
    const value = bar.quoteVolume - correction, next = total + value;
    correction = (next - total) - value;
    total = next;
  }
  const average3d = covered && valid ? total / 3 : null;
  const previousDay = recent.filter((b) => b.openTime >= end - 48 * 3600000 && b.openTime < end - 24 * 3600000).reduce((sum, b) => sum + b.quoteVolume, 0);
  const lastDay = recent.filter((b) => b.openTime >= end - 24 * 3600000).reduce((sum, b) => sum + b.quoteVolume, 0);
  return { version: 2, checkedAt: now, candleClose: end, ready: average3d !== null, average3d,
    group: average3d === null ? "pending" : average3d >= TURNOVER_MIN ? "high" : "low",
    increasing: average3d !== null && lastDay > previousDay, lastDay, previousDay,
    newListing: exhausted && !!first && first.openTime > end - 30 * 86400000 };
}
function highTurnover(result, now) {
  const t = result?.turnover;
  return t?.version === 2 && t.ready && t.group === "high" && t.candleClose === boundaryFor(60, now);
}
function primaryCollectionStatus(cache, unit, now) {
  const quality = candleQuality(cache, unit, now), last = cache[unit]?.at(-1);
  const uncovered = candleRequest({ ...cache, collection: { ...cache.collection,
    [unit]: { ...cache.collection?.[unit], retryAt: 0 } } }, unit, now) !== null;
  return { version: 1, checkedAt: now, candleClose: boundaryFor(unit, now),
    ready: !uncovered && (quality.actualBars > 0 || quality.exhausted),
    bars: cache[unit]?.length ?? 0, actualBars: quality.actualBars, required: quality.required,
    exhausted: quality.exhausted, latestActualClose: quality.latestActualClose,
    noTradeCount: quality.noTradeCount, gapCount: quality.gapCount,
    reason: uncovered ? quality.reason : quality.exhausted && quality.actualBars < quality.required ? "신규 상장 · 확보 가능한 이력 수집 완료"
      : last?.synthetic ? "최근 완료 시간대 무거래" : "수집 확인 완료" };
}
function pipelineCoverage(results, markets, now) {
  const byCode = new Map(results.map((r) => [r.market, r]));
  const details = markets.filter(isAnalysisMarket).map((m) => {
    const r = byCode.get(m.market), t = r?.turnover;
    const group = t?.version === 2 && t.ready && t.candleClose === boundaryFor(60, now)
      && Number.isFinite(t.average3d) && t.average3d >= 0 ? t.average3d >= TURNOVER_MIN ? "high" : "low" : "pending";
    const frames = Object.fromEntries([15, 60].map((u) => {
      const q = r?.primaryCollection?.[u];
      return [u, { ...q, ready: q?.version === 1 && q.ready && q.candleClose === boundaryFor(u, now) }];
    }));
    const buyUnits = [15, 60].filter((u) => r?.primary?.[u]?.ready && r.primary[u].direction === 1 && r.primary[u].closeTime === boundaryFor(u, now));
    const assessed = group === "high" && Object.values(frames).every((q) => q.ready)
      && buyUnits.every((u) => r?.entryGateVersion === 1 && r.analyzedAt >= boundaryFor(u, now) && !r.detailCollectionPending);
    return { market: m.market, name: m.koreanName, group, average3d: group === "pending" ? null : t.average3d,
      turnoverClose: t?.candleClose ?? 0, turnoverError: t?.error ?? null, frames, buy: buyUnits.length > 0, assessed };
  });
  const pending = details.filter((d) => d.group === "pending").length, high = details.filter((d) => d.group === "high");
  const classified = markets.exclusionStatus?.ready !== false && details.length > 0 && pending === 0;
  const candlesReady = high.filter((d) => Object.values(d.frames).every((q) => q.ready)).length;
  const primaryComplete = classified && candlesReady === high.length;
  const assessed = high.filter((d) => d.assessed).length;
  return { version: 1, asOf: now, turnoverClose: boundaryFor(60, now), total: details.length,
    classified: details.length - pending, high: high.length, low: details.length - pending - high.length, pending,
    turnoverComplete: classified, candlesReady, primaryComplete, assessed,
    complete: primaryComplete && assessed === high.length,
    stage: markets.exclusionStatus?.ready === false ? "exclusions" : !classified ? "turnover" : !primaryComplete ? "candles" : "analysis", details };
}
function stAnalysis(cache, now) {
  const frames = Object.fromEntries([240, 1440].map((u) => {
    const bars = (cache[u] ?? []).filter((b) => !b.synthetic && b.closeTime <= boundaryFor(u, now));
    const closes = bars.map((b) => b.close), average = lastValue(ema(closes, 20));
    const fresh = bars.at(-1)?.closeTime === boundaryFor(u, now);
    const ma7 = simpleAverage(closes, 7), ma20 = simpleAverage(closes, 20);
    return [u, { rsi: lastValue(rsi(closes, 14)), ma7, ma20,
      maSpreadPct: ma7 !== null && ma20 > 0 ? (ma7 / ma20 - 1) * 100 : null,
      exhausted: cache.collection?.[u]?.exhausted === true,
      checkedAt: fresh ? now : cache.collection?.[u]?.checkedAt ?? 0, closeTime: bars.at(-1)?.closeTime ?? 0, bars: bars.length,
      state: !fresh || average === null ? "pending" : closes.at(-1) >= average ? "up" : "down" }];
  }));
  const daily = (cache[1440] ?? []).filter((b) => !b.synthetic);
  return { riskVersion: 1, checkedAt: now, primaryClose: Object.fromEntries([15, 60].map((u) => [u, primaryTrend(cache[u], u, now).closeTime])), frames, rsi: Object.fromEntries([15, 60].map((u) => [u, lastValue(rsi((cache[u] ?? []).filter((b) => !b.synthetic).map((b) => b.close), 14))])),
    newListing: turnoverClass(cache, now).newListing || cache.collection?.[1440]?.exhausted === true
      && !!daily.length && daily[0].openTime > now - 30 * 86400000 };
}
function recommendationRisk(result, ticker, now) {
  const frames = result.stAnalysis?.frames ?? {};
  const checks = [240, 1440].map((unit) => {
    const f = frames[unit], current = f?.closeTime === boundaryFor(unit, now);
    const available = current && Number.isFinite(f.rsi) && Number.isFinite(f.maSpreadPct) && f.ma20 > 0;
    const shortHistory = f?.exhausted === true && f.bars < 20;
    const priceExtensionPct = available ? (ticker.tradePrice / f.ma20 - 1) * 100 : null;
    return { unit, available, shortHistory, rsi: f?.rsi ?? null, maSpreadPct: f?.maSpreadPct ?? null,
      priceExtensionPct, overheated: available && f.rsi >= 70 && f.maSpreadPct >= 8 && priceExtensionPct >= 8 };
  });
  const ready = result.stAnalysis?.riskVersion === 1 && checks.every((f) => f.available || f.shortHistory);
  const reasons = checks.filter((f) => f.overheated).map((f) => `${f.unit === 240 ? "4시간" : "일봉"} RSI ${f.rsi.toFixed(1)} · 7·20기간 이평선 이격 ${f.maSpreadPct.toFixed(1)}% · 현재가 이격 ${f.priceExtensionPct.toFixed(1)}%`);
  return { version: 1, ready, blocked: reasons.length > 0, checks, reasons };
}
function validPricePlan(p) {
  return !!p && typeof p.id === "string" && !!p.id && Array.isArray(p.targets) && p.targets.length === 3
    && [p.entryLow, p.entryAnchor, p.entryHigh, p.stop, ...p.targets].every((v) => Number.isFinite(v) && v > 0)
    && p.stop < p.entryLow && p.entryLow <= p.entryAnchor && p.entryAnchor <= p.entryHigh
    && p.entryHigh < p.targets[0] && p.targets[0] < p.targets[1] && p.targets[1] < p.targets[2];
}
function pricePlanCurrent(candidate, now) {
  const p = candidate?.plan;
  return validPricePlan(p) && Number.isFinite(candidate.currentPrice) && candidate.currentPrice > 0
    && Number.isFinite(candidate.quoteVolume24h) && candidate.quoteVolume24h >= 0
    && Number.isFinite(candidate.currentPriceAt) && 0 <= now - candidate.currentPriceAt && now - candidate.currentPriceAt <= 180000
    && Number.isFinite(p.netReturns?.[0]) && p.netReturns[0] > 0
    && candidate.entryStatus === "ready" && entryGateCurrent(candidate, now)
    && qualityCurrent(candidate.dataQuality, now) && entryStillValid(candidate, candidate.currentPrice, now);
}
function rankedStRecommendations(results, markets, prices, now, accepted = []) {
  if (markets.exclusionStatus?.ready === false) return [];
  const safe = new Map(markets.filter(isAnalysisMarket).map((m) => [m.market, m])), candidates = [];
  for (const result of results) {
    const market = safe.get(result.market), ticker = prices.get(result.market);
    if (!market || !ticker || !highTurnover(result, now)) continue;
    const risk = recommendationRisk(result, ticker, now);
    if (!risk.ready || risk.blocked) continue;
    for (const [strategy, unit] of [["scalp", 15], ["swing", 60]]) {
      const gate = result.primary?.[unit];
      if (!entryGateCurrent({ strategy, entryGate: gate }, now)) continue;
      const analysis = result.stAnalysis, frames = analysis?.frames ?? {};
      const frame = (u) => frames[u]?.closeTime === boundaryFor(u, now) ? frames[u].state : "pending";
      const momentum = analysis?.checkedAt >= boundaryFor(unit, now) ? analysis.rsi?.[unit] : null;
      const score = 50 + (frame(240) === "up" ? 15 : 0) + (frame(1440) === "up" ? 15 : 0)
        + (momentum !== null && momentum !== undefined && momentum >= 40 && momentum <= 70 ? 10 : 0) + (result.turnover.increasing ? 10 : 0);
      const technical = accepted.find((c) => c.market === result.market && c.strategy === strategy && pricePlanCurrent(c, now));
      if (!technical) continue;
      candidates.push({ ...technical, actionableVersion: 1, market: result.market, koreanName: market.koreanName, strategy, score,
        currentPrice: ticker.tradePrice, currentPriceAt: ticker.timestamp, quoteVolume24h: ticker.quoteVolume24h,
        averageTurnover3d: result.turnover.average3d, turnover: result.turnover, entryGate: gate,
        newListing: !!(analysis?.newListing || result.turnover.newListing), upper4h: frame(240), dailyTrend: frame(1440),
        targetTrend: gate.targetTrend, risk, planStatus: "ready", entryStatus: "ready",
        rsi: momentum, plan: technical.plan, analyzedAt: analysis?.checkedAt ?? 0 });
    }
  }
  return ["scalp", "swing"].flatMap((strategy) => candidates.filter((c) => c.strategy === strategy)
    .sort((a, b) => b.score - a.score || b.averageTurnover3d - a.averageTurnover3d || a.market.localeCompare(b.market))
    .slice(0, 10).map((c, i) => ({ ...c, rank: i + 1 })));
}
function primaryTrend(candles, unit, now, previous) {
  const end = boundaryFor(unit, now), bars = (candles ?? []).filter((b) => b.closeTime <= end);
  const real = bars.filter((b) => !b.synthetic), trend = advanceTrends(bars, previous, now);
  const ready = real.length >= 10 && Number.isFinite(trend.atr10) && trend.atr10 > 0 && real.at(-1)?.closeTime === end;
  return { version: 1, unit, checkedAt: now, closeTime: end, latestActualClose: real.at(-1)?.closeTime ?? 0,
    actualBars: real.length, direction: Number.isFinite(trend.atr10) ? trend.stDirection : null, ready,
    targetTrend: { version: 1, ready: trend.atrWindow.length === 200, direction: trend.ttDirection,
      signalTime: trend.signal?.time ?? null, targets: trend.signal?.targets ?? [],
      reached: trend.signal?.reached ?? 0, completedAt: trend.signal?.completedAt ?? null },
    state: ready ? trend.stDirection === 1 ? "buy" : "sell" : "unknown" };
}
function entryGateCurrent(candidate, now) {
  const gate = candidate?.entryGate, unit = candidate?.strategy === "scalp" ? 15 : 60;
  return gate?.version === 1 && gate.unit === unit && gate.ready && gate.direction === 1
    && gate.closeTime === boundaryFor(unit, now) && gate.latestActualClose === gate.closeTime;
}
function stEntryCheck(input, unit) {
  const gate = primaryTrend(input.candles[String(unit)], unit, input.analysisAt ?? input.ticker.timestamp);
  return !gate.ready ? reject("insufficientData", "ST_PENDING") : gate.direction !== 1 ? reject("technicalConditions", "ST_SELL") : null;
}
function evaluateScalp(input, fixedPlan) {
  if (!input.analysisOnly) { const blocked = stEntryCheck(input, 15); if (blocked) return blocked; }
  if (!input.analysisOnly) {
    const quality = recommendationQuality(input.candles, "scalp", input.analysisAt ?? input.ticker.timestamp);
    if (!quality.ready) return reject("insufficientData", Object.values(quality.frames).some((q) => q.reason === "신규 상장 · 가격 계산 이력 부족") ? "HISTORY_SHORT" : "DATA_DELAYED");
  }
  const trends = trendSet(input);
  const upper = upperStructure(input.candles, input.analysisAt ?? input.ticker.timestamp, trends);
  if (!upper.ready) return reject("insufficientData", "INSUFFICIENT_DATA");
  if (!input.analysisOnly && !upper.alive) return reject("technicalConditions", "UPPER_TREND_WAIT");
  const candles15 = input.candles["15"];
  const candles60 = input.candles["60"];
  if (candles15.length < 60 || candles60.length < 55) return reject("insufficientData", "INSUFFICIENT_DATA");
  if (hasRecentSynthetic(candles15, 40) || hasRecentSynthetic(candles60, 24)) return reject("insufficientData", "MISSING_RECENT_CANDLES");
  if (!input.analysisOnly && input.marketRegime === "RISK_OFF") return reject("technicalConditions", "BTC_RISK_OFF");
  if (!input.analysisOnly && (!input.execution.sufficientDepth || input.execution.buySlippagePct > 0.15)) {
    return reject("executionQuality", "POOR_EXECUTION");
  }
  const close15 = candles15.map((candle) => candle.close);
  const close60 = candles60.map((candle) => candle.close);
  const ema20_15 = lastValue(ema(close15, 20));
  const ema50_15 = lastValue(ema(close15, 50));
  const ema20_60 = lastValue(ema(close60, 20));
  const ema50_60 = lastValue(ema(close60, 50));
  const rsi14 = lastValue(rsi(close15, 14));
  const atrSeries = atr(candles15, 14);
  const atr14 = lastValue(atrSeries);
  const previousAtr = atrSeries.at(-2) ?? null;
  const relativeVolume = lastValue(rvol(candles15, 20));
  const breakout = lastValue(donchianHigh(candles15, 20));
  const latest = candles15.at(-1);
  if ([ema20_15, ema50_15, ema20_60, ema50_60, rsi14, atr14, previousAtr, relativeVolume, breakout].some((value) => value === null)) {
    return reject("insufficientData", "INDICATOR_WARMUP");
  }
  if (atr14 <= 0 || previousAtr <= 0) return reject("insufficientData", "ZERO_ATR");
  const previous = candles15.at(-2);
  const isBreakout = latest.close > breakout && relativeVolume >= 1.2;
  const isPullback = candles15.slice(-5, -1).some((c) => c.low <= ema20_15 + atr14 * 0.4) && latest.close > previous.high && latest.close > ema20_15 && latest.close - ema20_15 <= atr14 * 1.5 && relativeVolume >= 0.8;
  const isReversal = upper.early && latest.close > previous.high && latest.close > ema20_15 && relativeVolume >= 1;
  if (!input.analysisOnly && !fixedPlan && !isBreakout && !isPullback && !isReversal) return reject("technicalConditions", latest.close > breakout ? "LOW_RVOL" : "NO_ENTRY_SETUP");
  const extensionAtr = (latest.close - breakout) / atr14;
  const currentRangeRatio = trueRanges(candles15).at(-1) / previousAtr;
  if (!input.analysisOnly && !fixedPlan && isBreakout && extensionAtr > 1.5) return reject("technicalConditions", "OVEREXTENDED");
  if (!input.analysisOnly && !fixedPlan && currentRangeRatio > 4) return reject("technicalConditions", "PUMP_CANDLE");
  const pivot = lastConfirmedPivotLow(candles15.slice(-20));
  if (!pivot && !fixedPlan) return reject("technicalConditions", "NO_CONFIRMED_SWING_LOW");
  const anchor = isBreakout ? breakout : ema20_15;
  const rawStop = fixedPlan?.stop ?? (isBreakout ? Math.min(pivot.price, breakout - atr14 * 0.7) : pivot.price - atr14 * 0.2);
  const plan = fixedPlan ?? buildConfluencePlan({
    entryLow: anchor,
    entryAnchor: anchor + atr14 * 0.1,
    entryHigh: anchor + atr14 * 0.3,
    rawStop,
    atr: atr14,
    execution: input.execution,
    levels: resistanceLevels(input.candles, "scalp", latest.closeTime, trends),
    market: input.market.market,
    strategy: "scalp",
    signalTime: latest.closeTime,
    entryReason: isReversal ? "1시간·4시간 초기 전환 후 15분 고가 회복" : isBreakout ? "15분 고점 돌파 후 기준 구간 진입" : "EMA20 눌림 회복 구간 진입",
    stopReason: "확정된 15분 지지 저점과 ATR 완충 아래",
    expiresAt: latest.closeTime + 30 * 6e4,
    feeRate: input.feeRate
  });
  if (!plan) return reject("technicalConditions", "NO_RESISTANCE_ROOM");
  if (!input.analysisOnly && (input.ticker.tradePrice < plan.entryLow - atr14 * 0.25 || input.ticker.tradePrice > plan.entryHigh + atr14 * 0.25)) {
    return reject("technicalConditions", "CURRENT_PRICE_OUTSIDE_ENTRY");
  }
  const centeredRsi = clamp(1 - Math.abs(rsi14 - 60) / 20, 0, 1);
  const rvolStrength = clamp((relativeVolume - 0.8) / 2.2, 0, 1);
  const extensionQuality = isBreakout ? clamp(1 - extensionAtr / 1.5, 0, 1) : 0.8;
  const slippageQuality = clamp(1 - input.execution.buySlippagePct / 0.15, 0, 1);
  const daily = dailyContext(input.candles["240"], input.ticker.timestamp);
  const score = Math.round(
    45 + upper.score * 0.1 + (ema20_15 > ema50_15 ? 3 : 0) + (ema20_60 > ema50_60 ? 2 : 0) + centeredRsi * 5 + extensionQuality * 7 + rvolStrength * 10 + slippageQuality * 5 + clamp((plan.netSplitReturn ?? 0) / 10, 0, 1) * 10 + (daily === "up" ? 5 : 0)
  );
  return {
    accepted: true,
    candidate: {
      market: input.market.market,
      koreanName: input.market.koreanName,
      englishName: input.market.englishName,
      strategy: "scalp",
      setup: isReversal ? "reversal" : isBreakout ? "breakout" : "pullback",
      score: clamp(score, 0, 100),
      rank: 0,
      currentPrice: input.ticker.tradePrice,
      signedChangeRate: input.ticker.signedChangeRate,
      quoteVolume24h: input.ticker.quoteVolume24h,
      signalTime: latest.closeTime,
      reasons: [
        upper.reason,
        `${isBreakout ? "20봉 고점 돌파" : "EMA20 눌림 후 직전 봉 고가 회복"} · 거래대금 ${relativeVolume.toFixed(1)}배`,
        `RSI ${rsi14.toFixed(1)} · 일봉 ${daily === "up" ? "상승 배경" : daily === "down" ? "회복 확인 중" : "이력 준비"}`
      ],
      warnings: withSpreadWarning([
        ...plan.riskPct > 2 ? [`손절폭 ${plan.riskPct.toFixed(2)}% · 넓은 위험 구간, 투자 규모 직접 판단`] : [],
        ...rsi14 >= 78 ? ["RSI 과열 · 추격 주의"] : [],
        ...daily === "down" ? ["일봉 추세 회복 전 · 상위 저항 주의"] : [],
        ...trends["15"].ttUpper === null ? ["Target Trend 이력 준비 중 · 가격 구조로 목표 산정"] : []
      ], "scalp", input.execution.spreadPct),
      plan,
      metrics: {
        rsi: rsi14,
        atrPct: atr14 / latest.close * 100,
        rvol: relativeVolume,
        spreadPct: input.execution.spreadPct,
        slippagePct: input.execution.buySlippagePct
      },
      charts: chartSet(input)
    }
  };
}
function evaluateSwing(input, fixedPlan) {
  if (!input.analysisOnly) { const blocked = stEntryCheck(input, 60); if (blocked) return blocked; }
  if (!input.analysisOnly) {
    const quality = recommendationQuality(input.candles, "swing", input.analysisAt ?? input.ticker.timestamp);
    if (!quality.ready) return reject("insufficientData", Object.values(quality.frames).some((q) => q.reason === "신규 상장 · 가격 계산 이력 부족") ? "HISTORY_SHORT" : "DATA_DELAYED");
  }
  const trends = trendSet(input);
  const upper = upperStructure(input.candles, input.analysisAt ?? input.ticker.timestamp, trends);
  if (!upper.ready) return reject("insufficientData", "INSUFFICIENT_DATA");
  if (!input.analysisOnly && !upper.alive) return reject("technicalConditions", "UPPER_TREND_WAIT");
  const candles60 = input.candles["60"];
  const candles240 = input.candles["240"];
  if (candles60.length < 60 || candles240.length < 60) return reject("insufficientData", "INSUFFICIENT_DATA");
  if (hasRecentSynthetic(candles60, 36) || hasRecentSynthetic(candles240, 20)) return reject("insufficientData", "MISSING_RECENT_CANDLES");
  if (!input.analysisOnly && input.marketRegime === "RISK_OFF") return reject("technicalConditions", "BTC_RISK_OFF");
  if (!input.analysisOnly && (!input.execution.sufficientDepth || input.execution.buySlippagePct > 0.25)) {
    return reject("executionQuality", "POOR_EXECUTION");
  }
  const close60 = candles60.map((candle) => candle.close);
  const close240 = candles240.map((candle) => candle.close);
  const ema20Series = ema(close240, 20);
  const ema50Series = ema(close240, 50);
  const ema200Series = ema(close240, 200);
  const ema20_240 = lastValue(ema20Series);
  const ema50_240 = lastValue(ema50Series);
  const ema200_240 = lastValue(ema200Series);
  const rsi240 = lastValue(rsi(close240, 14));
  const atr240 = lastValue(atr(candles240, 14));
  const atr60 = lastValue(atr(candles60, 14));
  const dmi240 = dmi(candles240, 14);
  const adx240 = lastValue(dmi240.adx);
  const plusDi = lastValue(dmi240.plusDi);
  const minusDi = lastValue(dmi240.minusDi);
  const latest240 = candles240.at(-1);
  const latest60 = candles60.at(-1);
  if ([ema20_240, ema50_240, rsi240, atr240, atr60, adx240, plusDi, minusDi].some((value) => value === null)) {
    return reject("insufficientData", "INDICATOR_WARMUP");
  }
  if (atr240 <= 0 || atr60 <= 0) return reject("insufficientData", "ZERO_ATR");
  const breakout = lastValue(donchianHigh(candles60, 20));
  const relativeVolume = lastValue(rvol(candles60, 20));
  const pivot = lastConfirmedPivotLow(candles60.slice(-30));
  if ([breakout, relativeVolume].some((value) => value === null) || !pivot && !fixedPlan) {
    return reject("insufficientData", "ENTRY_DATA_MISSING");
  }
  const isBreakout = latest60.close > breakout && relativeVolume >= 1.2 && (latest60.close - breakout) / atr60 <= 1.5;
  const ema20_60 = lastValue(ema(close60, 20));
  const previous60 = candles60.at(-2);
  const pullbackLow = ema20_60 - atr60 * 0.2;
  const pullbackHigh = ema20_60 + atr60 * 0.4;
  const isPullback = candles60.slice(-5, -1).some((c) => c.low <= pullbackHigh) && latest60.close > previous60.high && latest60.close > ema20_60 && latest60.close - ema20_60 <= atr60 * 1.5 && relativeVolume >= 0.8;
  const isReversal = upper.early && latest60.close > previous60.high && relativeVolume >= 1;
  if (!input.analysisOnly && !fixedPlan && !isBreakout && !isPullback && !isReversal) return reject("technicalConditions", "NO_ENTRY_SETUP");
  const setup = isReversal ? "reversal" : isBreakout ? "breakout" : "pullback";
  const entryLowRaw = isBreakout ? breakout - atr60 * 0.2 : pullbackLow;
  const entryHighRaw = isBreakout ? breakout + atr60 * 0.2 : pullbackHigh;
  const entryAnchorRaw = isBreakout ? breakout : (pullbackLow + pullbackHigh) / 2;
  const plan = fixedPlan ?? buildConfluencePlan({
    entryLow: entryLowRaw,
    entryAnchor: entryAnchorRaw,
    entryHigh: entryHighRaw,
    rawStop: pivot.price - atr60 * 0.3,
    atr: atr60,
    execution: input.execution,
    levels: resistanceLevels(input.candles, "swing", latest60.closeTime, trends),
    market: input.market.market,
    strategy: "swing",
    signalTime: latest60.closeTime,
    entryReason: isBreakout ? "1시간 고점 돌파 기준 구간 진입" : "4시간 추세와 1시간 지지가 겹친 회복 구간",
    stopReason: "확정된 1시간 지지 저점과 ATR 완충 아래",
    expiresAt: latest60.closeTime + 3 * 60 * 6e4,
    feeRate: input.feeRate
  });
  if (!plan) return reject("technicalConditions", "NO_RESISTANCE_ROOM");
  if (!input.analysisOnly && (input.ticker.tradePrice < plan.entryLow - atr60 * 0.25 || input.ticker.tradePrice > plan.entryHigh + atr60 * 0.25)) {
    return reject("technicalConditions", "CURRENT_PRICE_OUTSIDE_ENTRY");
  }
  const flow = lastValue(cmf(candles60, 20)) ?? 0;
  const momentum = lastValue(ppo(close240).histogram) ?? 0;
  const relativeStrength = input.ticker.signedChangeRate - input.btcChangeRate;
  const rsiQuality = rsi240 <= 70 ? 1 : clamp((75 - rsi240) / 5, 0, 1);
  const volumeQuality = clamp((relativeVolume - 1) / 1.5, 0, 1);
  const flowQuality = clamp((flow + 0.1) / 0.3, 0, 1);
  const momentumQuality = momentum > 0 ? 1 : clamp(1 + momentum / 0.5, 0, 1);
  const relativeQuality = clamp((relativeStrength + 0.02) / 0.06, 0, 1);
  const daily = dailyContext(candles240, input.ticker.timestamp);
  const score = Math.round(
    45 + upper.score * 0.1 + (ema200_240 !== null && ema50_240 > ema200_240 ? 3 : 0) + clamp((adx240 - 15) / 15, 0, 1) * 5 + volumeQuality * 10 + flowQuality * 4 + rsiQuality * 4 + momentumQuality * 4 + relativeQuality * 4 + (plusDi > minusDi ? 3 : 0) + clamp((plan.netSplitReturn ?? 0) / 15, 0, 1) * 10 + (daily === "up" ? 5 : 0)
  );
  return {
    accepted: true,
    candidate: {
      market: input.market.market,
      koreanName: input.market.koreanName,
      englishName: input.market.englishName,
      strategy: "swing",
      setup,
      score: clamp(score, 0, 100),
      rank: 0,
      currentPrice: input.ticker.tradePrice,
      signedChangeRate: input.ticker.signedChangeRate,
      quoteVolume24h: input.ticker.quoteVolume24h,
      signalTime: latest60.closeTime,
      reasons: [
        upper.reason,
        setup === "reversal" ? "확정 고점 회복 · 초기 전환형" : setup === "breakout" ? `1시간 고점 돌파 · 거래대금 ${relativeVolume.toFixed(1)}배` : "1시간 지지 구간 눌림 후 회복",
        `RSI ${rsi240.toFixed(1)} · CMF ${flow.toFixed(2)}`
      ],
      warnings: withSpreadWarning([
        ...relativeStrength < 0 ? ["BTC보다 상대 강도가 낮습니다"] : [],
        ...plan.riskPct > 6 ? [`손절폭 ${plan.riskPct.toFixed(2)}% · 넓은 위험 구간, 투자 규모 직접 판단`] : [],
        ...daily === "down" ? ["일봉 추세 회복 전 · 상위 저항 주의"] : [],
        ...rsi240 >= 78 ? ["RSI 과열 · 추격 주의"] : [],
        ...trends["60"].ttUpper === null ? ["Target Trend 이력 준비 중 · 가격 구조로 목표 산정"] : []
      ], "swing", input.execution.spreadPct),
      plan,
      metrics: {
        rsi: rsi240,
        atrPct: atr240 / latest240.close * 100,
        rvol: relativeVolume,
        adx: adx240,
        cmf: flow,
        ppoHistogram: momentum,
        spreadPct: input.execution.spreadPct,
        slippagePct: input.execution.buySlippagePct
      },
      charts: chartSet(input)
    }
  };
}
function rankCandidates(candidates, strategy, limit = 3) {
  const threshold = strategy === "scalp" ? 70 : 72;
  return [...candidates].filter((candidate) => candidate.strategy === strategy && candidate.score >= threshold).sort((left, right) => right.score - left.score || right.quoteVolume24h - left.quoteVolume24h || left.market.localeCompare(right.market)).slice(0, limit).map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
function deriveBtcRegime(candles60, candles240) {
  if (candles60.length < 55 || candles240.length < 200) return "NEUTRAL";
  const close60 = candles60.map((candle) => candle.close);
  const close240 = candles240.map((candle) => candle.close);
  const e20_60 = lastValue(ema(close60, 20));
  const e50_60 = lastValue(ema(close60, 50));
  const e50_240 = lastValue(ema(close240, 50));
  const e200_240 = lastValue(ema(close240, 200));
  const last60 = close60.at(-1);
  const last240 = close240.at(-1);
  if (e20_60 === null || e50_60 === null || e50_240 === null || e200_240 === null) return "NEUTRAL";
  if (last60 < e50_60 && e20_60 < e50_60 && last240 < e200_240) return "RISK_OFF";
  if (last60 > e20_60 && e20_60 > e50_60 && last240 > e50_240 && e50_240 > e200_240) return "BULLISH";
  return "NEUTRAL";
}

// lib/pre-confluence-strategy.ts
function reject2(category, code) {
  return { accepted: false, category, code };
}
function clamp2(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
function roundPrice(value, instrumentTickSize, referencePrice, direction) {
  if (!Number.isFinite(value)) return value;
  const tickSize = resolvedKrwTickSize(value, instrumentTickSize, referencePrice);
  const scaled = value / tickSize;
  const rounded = direction === "up" ? Math.ceil(scaled) : direction === "down" ? Math.floor(scaled) : Math.round(scaled);
  return Number((rounded * tickSize).toPrecision(15));
}
function calculateNetRewardRisk(entry, stop, target, feeRate, slippagePct) {
  const slippage = slippagePct / 100;
  const netProfit = target * (1 - feeRate - slippage) - entry * (1 + feeRate + slippage);
  const netLoss = entry * (1 + feeRate + slippage) - stop * (1 - feeRate - slippage);
  return netLoss <= 0 ? 0 : netProfit / netLoss;
}
function buildPricePlan(args) {
  const entryLow = roundPrice(args.entryLow, args.tickSize, args.tickSizeReferencePrice, "up");
  const entryAnchor = roundPrice(args.entryAnchor, args.tickSize, args.tickSizeReferencePrice, "nearest");
  const entryHigh = roundPrice(args.entryHigh, args.tickSize, args.tickSizeReferencePrice, "down");
  const stop = roundPrice(args.rawStop, args.tickSize, args.tickSizeReferencePrice, "down");
  if (!(stop < entryLow && entryLow <= entryAnchor && entryAnchor <= entryHigh)) return null;
  const risk = entryAnchor - stop;
  const targets = [
    roundPrice(entryAnchor + risk, args.tickSize, args.tickSizeReferencePrice, "down"),
    roundPrice(entryAnchor + risk * 2, args.tickSize, args.tickSizeReferencePrice, "down"),
    roundPrice(entryAnchor + risk * 3, args.tickSize, args.tickSizeReferencePrice, "down")
  ];
  if (!(entryHigh < targets[0] && targets[0] < targets[1] && targets[1] < targets[2])) return null;
  return {
    entryLow,
    entryAnchor,
    entryHigh,
    stop,
    targets,
    riskPct: risk / entryAnchor * 100,
    netRewardRiskAtTarget2: calculateNetRewardRisk(
      entryAnchor,
      stop,
      targets[1],
      args.feeRate,
      args.slippagePct
    ),
    expiresAt: args.expiresAt
  };
}
function hasRecentSynthetic2(candles, count) {
  return candles.slice(-count).some((candle) => candle.synthetic);
}
function chartSet2(input) {
  if (input.includeCharts === false) return { "15": [], "60": [], "240": [] };
  return {
    "15": buildChartPoints(input.candles["15"]),
    "60": buildChartPoints(input.candles["60"]),
    "240": buildChartPoints(input.candles["240"])
  };
}
function evaluateScalp2(input) {
  const candles15 = input.candles["15"];
  const candles60 = input.candles["60"];
  if (candles15.length < 60 || candles60.length < 55) return reject2("insufficientData", "INSUFFICIENT_DATA");
  if (hasRecentSynthetic2(candles15, 40) || hasRecentSynthetic2(candles60, 24)) return reject2("insufficientData", "MISSING_RECENT_CANDLES");
  if (input.marketRegime === "RISK_OFF") return reject2("technicalConditions", "BTC_RISK_OFF");
  if (!input.execution.sufficientDepth || input.execution.buySlippagePct > 0.15) {
    return reject2("executionQuality", "POOR_EXECUTION");
  }
  const close15 = candles15.map((candle) => candle.close);
  const close60 = candles60.map((candle) => candle.close);
  const ema20_15 = lastValue(ema(close15, 20));
  const ema50_15 = lastValue(ema(close15, 50));
  const ema20_60 = lastValue(ema(close60, 20));
  const ema50_60 = lastValue(ema(close60, 50));
  const rsi14 = lastValue(rsi(close15, 14));
  const atrSeries = atr(candles15, 14);
  const atr14 = lastValue(atrSeries);
  const previousAtr = atrSeries.at(-2) ?? null;
  const relativeVolume = lastValue(rvol(candles15, 20));
  const breakout = lastValue(donchianHigh(candles15, 20));
  const latest = candles15.at(-1);
  if ([ema20_15, ema50_15, ema20_60, ema50_60, rsi14, atr14, previousAtr, relativeVolume, breakout].some((value) => value === null)) {
    return reject2("insufficientData", "INDICATOR_WARMUP");
  }
  if (atr14 <= 0 || previousAtr <= 0) return reject2("insufficientData", "ZERO_ATR");
  if (!(ema20_15 > ema50_15 && ema20_60 > ema50_60 && latest.close > ema20_15)) {
    return reject2("technicalConditions", "TREND_MISMATCH");
  }
  const previous = candles15.at(-2);
  const isBreakout = latest.close > breakout && relativeVolume >= 1.2;
  const isPullback = previous.low <= ema20_15 + atr14 * 0.25 && previous.close <= ema20_15 + atr14 * 0.25 && latest.close > previous.high && latest.close > ema20_15 && latest.close - ema20_15 <= atr14 * 0.75 && relativeVolume >= 0.8;
  if (!isBreakout && !isPullback) return reject2("technicalConditions", latest.close > breakout ? "LOW_RVOL" : "NO_ENTRY_SETUP");
  if (rsi14 < 45 || rsi14 > 78) return reject2("technicalConditions", "RSI_OUT_OF_RANGE");
  const extensionAtr = (latest.close - breakout) / atr14;
  const currentRangeRatio = trueRanges(candles15).at(-1) / previousAtr;
  if (isBreakout && extensionAtr > 0.75) return reject2("technicalConditions", "OVEREXTENDED");
  if (currentRangeRatio > 3) return reject2("technicalConditions", "PUMP_CANDLE");
  const pivot = lastConfirmedPivotLow(candles15.slice(-20));
  if (!pivot) return reject2("technicalConditions", "NO_CONFIRMED_SWING_LOW");
  const anchor = isBreakout ? breakout : ema20_15;
  const rawStop = isBreakout ? Math.min(pivot.price, breakout - atr14 * 0.7) : pivot.price - atr14 * 0.2;
  const plan = buildPricePlan({
    entryLow: anchor,
    entryAnchor: anchor + atr14 * 0.1,
    entryHigh: anchor + atr14 * 0.3,
    rawStop,
    tickSize: input.execution.tickSize,
    tickSizeReferencePrice: input.execution.tickSizeReferencePrice,
    expiresAt: latest.closeTime + 30 * 6e4,
    feeRate: input.feeRate,
    slippagePct: input.execution.buySlippagePct
  });
  if (!plan) return reject2("technicalConditions", "INVALID_PRICE_PLAN");
  if (plan.riskPct > 2 || plan.entryAnchor - plan.stop > atr14 * 1.5) return reject2("technicalConditions", "RISK_TOO_WIDE");
  if (input.ticker.tradePrice < plan.entryLow - atr14 * 0.25 || input.ticker.tradePrice > plan.entryHigh + atr14 * 0.25) {
    return reject2("technicalConditions", "CURRENT_PRICE_OUTSIDE_ENTRY");
  }
  if (plan.netRewardRiskAtTarget2 < 1.5) return reject2("technicalConditions", "POOR_NET_RR");
  const centeredRsi = clamp2(1 - Math.abs(rsi14 - 60) / 20, 0, 1);
  const rvolStrength = clamp2((relativeVolume - 0.8) / 2.2, 0, 1);
  const extensionQuality = isBreakout ? clamp2(1 - extensionAtr / 0.75, 0, 1) : 0.8;
  const slippageQuality = clamp2(1 - input.execution.buySlippagePct / 0.15, 0, 1);
  const score = Math.round(
    (30 + 10 + centeredRsi * 5 + extensionQuality * 10 + 10 + rvolStrength * 15 + slippageQuality * 10) * 100 / 90
  );
  return {
    accepted: true,
    candidate: {
      market: input.market.market,
      koreanName: input.market.koreanName,
      englishName: input.market.englishName,
      strategy: "scalp",
      setup: isBreakout ? "breakout" : "pullback",
      score: clamp2(score, 0, 100),
      rank: 0,
      currentPrice: input.ticker.tradePrice,
      signedChangeRate: input.ticker.signedChangeRate,
      quoteVolume24h: input.ticker.quoteVolume24h,
      signalTime: latest.closeTime,
      reasons: [
        "1시간·15분 EMA 상승 배열",
        `${isBreakout ? "20봉 고점 돌파" : "EMA20 눌림 후 직전 봉 고가 회복"} · 거래대금 ${relativeVolume.toFixed(1)}배`,
        `RSI ${rsi14.toFixed(1)} · 추격 제한 통과`
      ],
      warnings: withSpreadWarning(plan.riskPct > 1.5 ? ["손절 폭이 다소 넓습니다"] : [], "scalp", input.execution.spreadPct),
      plan,
      metrics: {
        rsi: rsi14,
        atrPct: atr14 / latest.close * 100,
        rvol: relativeVolume,
        spreadPct: input.execution.spreadPct,
        slippagePct: input.execution.buySlippagePct
      },
      charts: chartSet2(input)
    }
  };
}
function evaluateSwing2(input) {
  const candles60 = input.candles["60"];
  const candles240 = input.candles["240"];
  if (candles60.length < 60 || candles240.length < 220) return reject2("insufficientData", "INSUFFICIENT_DATA");
  if (hasRecentSynthetic2(candles60, 36) || hasRecentSynthetic2(candles240, 20)) return reject2("insufficientData", "MISSING_RECENT_CANDLES");
  if (input.marketRegime === "RISK_OFF") return reject2("technicalConditions", "BTC_RISK_OFF");
  if (!input.execution.sufficientDepth || input.execution.buySlippagePct > 0.25) {
    return reject2("executionQuality", "POOR_EXECUTION");
  }
  const close60 = candles60.map((candle) => candle.close);
  const close240 = candles240.map((candle) => candle.close);
  const ema20Series = ema(close240, 20);
  const ema50Series = ema(close240, 50);
  const ema200Series = ema(close240, 200);
  const ema20_240 = lastValue(ema20Series);
  const ema50_240 = lastValue(ema50Series);
  const ema200_240 = lastValue(ema200Series);
  const ema50SlopeBase = ema50Series.at(-4) ?? null;
  const rsi240 = lastValue(rsi(close240, 14));
  const atr240 = lastValue(atr(candles240, 14));
  const atr60 = lastValue(atr(candles60, 14));
  const dmi240 = dmi(candles240, 14);
  const adx240 = lastValue(dmi240.adx);
  const plusDi = lastValue(dmi240.plusDi);
  const minusDi = lastValue(dmi240.minusDi);
  const latest240 = candles240.at(-1);
  const latest60 = candles60.at(-1);
  if ([ema20_240, ema50_240, ema200_240, ema50SlopeBase, rsi240, atr240, atr60, adx240, plusDi, minusDi].some((value) => value === null)) {
    return reject2("insufficientData", "INDICATOR_WARMUP");
  }
  if (atr240 <= 0 || atr60 <= 0) return reject2("insufficientData", "ZERO_ATR");
  if (!(ema20_240 > ema50_240 && latest240.close > ema50_240 && ema50_240 > ema50SlopeBase)) {
    return reject2("technicalConditions", "TREND_MISMATCH");
  }
  if (!(adx240 >= 15 && plusDi > minusDi)) return reject2("technicalConditions", "WEAK_TREND");
  if (rsi240 < 45 || rsi240 >= 78) return reject2("technicalConditions", "RSI_OUT_OF_RANGE");
  if (Math.abs(latest240.close - ema20_240) / atr240 > 1.5) return reject2("technicalConditions", "OVEREXTENDED");
  const breakout = lastValue(donchianHigh(candles60, 20));
  const relativeVolume = lastValue(rvol(candles60, 20));
  const rsi60Series = rsi(close60, 14);
  const rsi60Now = lastValue(rsi60Series);
  const rsi60Previous = rsi60Series.at(-2) ?? null;
  const pivot = lastConfirmedPivotLow(candles60.slice(-30));
  if ([breakout, relativeVolume, rsi60Now, rsi60Previous].some((value) => value === null) || !pivot) {
    return reject2("insufficientData", "ENTRY_DATA_MISSING");
  }
  const isBreakout = latest60.close > breakout && relativeVolume >= 1.2 && (latest60.close - breakout) / atr60 <= 0.75;
  const supportLow = pivot.price - atr60 * 0.25;
  const supportHigh = pivot.price + atr60 * 0.25;
  const trendLow = Math.min(ema20_240, ema50_240);
  const trendHigh = Math.max(ema20_240, ema50_240);
  const pullbackLow = Math.max(supportLow, trendLow);
  const pullbackHigh = Math.min(supportHigh, trendHigh);
  const isPullback = pullbackLow < pullbackHigh && latest60.close >= pullbackLow - atr60 * 0.25 && latest60.close <= pullbackHigh + atr60 * 0.25 && rsi60Previous <= 50 && rsi60Now > 50;
  if (!isBreakout && !isPullback) return reject2("technicalConditions", "NO_ENTRY_SETUP");
  const setup = isBreakout ? "breakout" : "pullback";
  const entryLowRaw = isBreakout ? breakout - atr60 * 0.2 : pullbackLow;
  const entryHighRaw = isBreakout ? breakout + atr60 * 0.2 : pullbackHigh;
  const entryAnchorRaw = isBreakout ? breakout : (pullbackLow + pullbackHigh) / 2;
  const plan = buildPricePlan({
    entryLow: entryLowRaw,
    entryAnchor: entryAnchorRaw,
    entryHigh: entryHighRaw,
    rawStop: pivot.price - atr60 * 0.3,
    tickSize: input.execution.tickSize,
    tickSizeReferencePrice: input.execution.tickSizeReferencePrice,
    expiresAt: latest60.closeTime + 3 * 60 * 6e4,
    feeRate: input.feeRate,
    slippagePct: input.execution.buySlippagePct
  });
  if (!plan) return reject2("technicalConditions", "INVALID_PRICE_PLAN");
  if (plan.riskPct > 6 || plan.entryAnchor - plan.stop > atr60 * 2.5) return reject2("technicalConditions", "RISK_TOO_WIDE");
  if (input.ticker.tradePrice < plan.entryLow - atr60 * 0.25 || input.ticker.tradePrice > plan.entryHigh + atr60 * 0.25) {
    return reject2("technicalConditions", "CURRENT_PRICE_OUTSIDE_ENTRY");
  }
  if (plan.netRewardRiskAtTarget2 < 1.5) return reject2("technicalConditions", "POOR_NET_RR");
  const flow = lastValue(cmf(candles60, 20)) ?? 0;
  const momentum = lastValue(ppo(close240).histogram) ?? 0;
  const relativeStrength = input.ticker.signedChangeRate - input.btcChangeRate;
  const rsiQuality = rsi240 <= 70 ? 1 : clamp2((75 - rsi240) / 5, 0, 1);
  const volumeQuality = clamp2((relativeVolume - 1) / 1.5, 0, 1);
  const flowQuality = clamp2((flow + 0.1) / 0.3, 0, 1);
  const momentumQuality = momentum > 0 ? 1 : clamp2(1 + momentum / 0.5, 0, 1);
  const relativeQuality = clamp2((relativeStrength + 0.02) / 0.06, 0, 1);
  const score = Math.round(
    (20 + (ema50_240 > ema200_240 ? 10 : 0) + 10 + clamp2((adx240 - 15) / 10, 0, 1) * 10 + volumeQuality * 10 + flowQuality * 5 + rsiQuality * 8 + momentumQuality * 7 + relativeQuality * 10 + clamp2(plan.netRewardRiskAtTarget2 / 2, 0, 1) * 5) * 100 / 95
  );
  return {
    accepted: true,
    candidate: {
      market: input.market.market,
      koreanName: input.market.koreanName,
      englishName: input.market.englishName,
      strategy: "swing",
      setup,
      score: clamp2(score, 0, 100),
      rank: 0,
      currentPrice: input.ticker.tradePrice,
      signedChangeRate: input.ticker.signedChangeRate,
      quoteVolume24h: input.ticker.quoteVolume24h,
      signalTime: latest60.closeTime,
      reasons: [
        `4시간 중기 상승 · ADX ${adx240.toFixed(1)}${ema50_240 > ema200_240 ? " · 장기 정배열" : " · 장기 추세 회복 대기"}`,
        setup === "breakout" ? `1시간 고점 돌파 · 거래대금 ${relativeVolume.toFixed(1)}배` : "1시간 지지 구간 눌림 후 회복",
        `RSI ${rsi240.toFixed(1)} · CMF ${flow.toFixed(2)}`
      ],
      warnings: withSpreadWarning(relativeStrength < 0 ? ["BTC보다 상대 강도가 낮습니다"] : [], "swing", input.execution.spreadPct),
      plan,
      metrics: {
        rsi: rsi240,
        atrPct: atr240 / latest240.close * 100,
        rvol: relativeVolume,
        adx: adx240,
        cmf: flow,
        ppoHistogram: momentum,
        spreadPct: input.execution.spreadPct,
        slippagePct: input.execution.buySlippagePct
      },
      charts: chartSet2(input)
    }
  };
}

// lib/upbit.ts
var API_BASE = "https://api.upbit.com/v1";
var UpbitApiError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "UpbitApiError";
  }
};
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function requestJson(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12e3)
  });
  if (/sec=0(?:;|$)/.test(response.headers.get("Remaining-Req") ?? "")) await delay(1050);
  if (response.ok) return await response.json();
  const text = await response.text();
  throw new UpbitApiError(`업비트 API ${response.status}: ${text.slice(0, 160)}`, response.status);
}
var marketStateCache;
async function fetchMarketStates(codes, now = Date.now()) {
  if (marketStateCache && now - marketStateCache.at < 60000 && codes.every((code) => marketStateCache.states.has(code))) return marketStateCache;
  const states = await new Promise((resolve, reject) => {
    const pending = new Set(codes), received = new Map();
    const socket = new WebSocket("wss://api.upbit.com/websocket/v1");
    socket.binaryType = "arraybuffer";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket.readyState < 2) socket.close();
      if (error) reject(error); else resolve(received);
    };
    const timer = setTimeout(() => finish(new Error(`공식 거래지원 상태 수신 대기 ${received.size}/${codes.length}`)), 8000);
    socket.addEventListener("open", () => socket.send(JSON.stringify([
      { ticket: "quant-market-status" }, { type: "ticker", codes, is_only_snapshot: true }, { format: "DEFAULT" }
    ])));
    socket.addEventListener("message", (event) => {
      try {
        const row = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
        if (row.error) throw new Error("공식 거래지원 상태 요청 오류");
        if (!pending.has(row.code)) return;
        if (row.type !== "ticker" || typeof row.market_state !== "string" || !row.market_state
          || !Object.hasOwn(row, "delisting_date") || row.delisting_date === undefined) throw new Error(`${row.code} 거래지원 상태·종료일 필드 확인 필요`);
        received.set(row.code, { state: row.market_state, delistingDate: row.delisting_date });
        pending.delete(row.code);
        if (pending.size === 0) finish();
      } catch (error) { finish(error); }
    });
    socket.addEventListener("error", () => finish(new Error("공식 거래지원 상태 WebSocket 연결 실패")));
    socket.addEventListener("close", () => finish(new Error(`공식 거래지원 상태 수신 중 연결 종료 ${received.size}/${codes.length}`)));
  });
  return marketStateCache = { at: now, states };
}
async function fetchKrwMarkets() {
  const response = (await requestJson("/market/all?is_details=true")).filter((item) => item.market.startsWith("KRW-"));
  let states = marketStateCache?.states ?? new Map(), status;
  try {
    if (!response.length || response.some((item) => typeof item.market_event?.warning !== "boolean")) throw new Error("공식 유의 종목 필드 확인 필요");
    const checked = await fetchMarketStates(response.map((item) => item.market));
    states = checked.states;
    status = { ready: true, checkedAt: checked.at, source: "upbit-open-api" };
  } catch (error) {
    status = { ready: false, checkedAt: marketStateCache?.at ?? 0, source: "upbit-open-api", error: error.message };
  }
  const markets = response.map((item) => {
    const state = states.get(item.market);
    const ending = state && (state.delistingDate !== null || state.state === "PREDELISTING" || state.state === "DELISTED");
    const inactive = state && state.state !== "ACTIVE";
    return { market: item.market, koreanName: item.korean_name, englishName: item.english_name,
      warned: Boolean(item.market_event?.warning) || Boolean(ending || inactive),
      exclusionReason: ending ? "거래지원 종료 예정·종료" : item.market_event?.warning ? "거래 유의 종목" : inactive ? "거래지원 비활성 상태" : null,
      caution: item.market_event?.caution ?? {} };
  });
  markets.exclusionStatus = status;
  return markets;
}
async function fetchKrwTickers() {
  const response = await requestJson("/ticker/all?quote_currencies=KRW");
  return response.map((item) => ({
    market: item.market,
    tradePrice: item.trade_price,
    signedChangeRate: item.signed_change_rate,
    quoteVolume24h: item.acc_trade_price_24h,
    timestamp: item.timestamp
  }));
}
function boundaryFor(unit, asOf) {
  const width = unit * 6e4;
  return Math.floor(asOf / width) * width;
}
function parseUtc(value) {
  return Date.parse(value.endsWith("Z") ? value : `${value}Z`);
}
function fillMissingCandles(candles, unit) {
  if (candles.length < 2) return [...candles];
  const width = unit * 6e4;
  const filled = [candles[0]];
  for (const current of candles.slice(1)) {
    const previous = filled.at(-1);
    let nextOpen = previous.openTime + width;
    let guard = 0;
    while (nextOpen < current.openTime && guard < 1e3) {
      filled.push({
        market: previous.market,
        unit,
        openTime: nextOpen,
        closeTime: nextOpen + width,
        open: previous.close,
        high: previous.close,
        low: previous.close,
        close: previous.close,
        baseVolume: 0,
        quoteVolume: 0,
        synthetic: true
      });
      nextOpen += width;
      guard += 1;
    }
    filled.push(current);
  }
  return filled;
}
function normalizeCandles(rows, unit, asOf) {
  const boundary = boundaryFor(unit, asOf);
  const unique = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const openTime = parseUtc(row.candle_date_time_utc);
    if (!Number.isFinite(openTime) || openTime >= boundary) continue;
    unique.set(openTime, {
      market: row.market,
      unit,
      openTime,
      closeTime: openTime + unit * 6e4,
      open: row.opening_price,
      high: row.high_price,
      low: row.low_price,
      close: row.trade_price,
      baseVolume: row.candle_acc_trade_volume,
      quoteVolume: row.candle_acc_trade_price,
      synthetic: false
    });
  }
  const filled = fillMissingCandles([...unique.values()].sort((left, right) => left.openTime - right.openTime), unit);
  if (filled.length === 0) return filled;
  const width = unit * 6e4;
  let guard = 0;
  while (filled.at(-1).closeTime < boundary && guard < 1e3) {
    const previous = filled.at(-1);
    filled.push({
      market: previous.market,
      unit,
      openTime: previous.closeTime,
      closeTime: previous.closeTime + width,
      open: previous.close,
      high: previous.close,
      low: previous.close,
      close: previous.close,
      baseVolume: 0,
      quoteVolume: 0,
      synthetic: true
    });
    guard += 1;
  }
  return filled;
}
async function fetchCandlePage(market, unit, to, count = 200) {
  const query = new URLSearchParams({
    market,
    to: new Date(to).toISOString(),
    count: String(count)
  });
  return requestJson(`/candles/${unit === 1440 ? "days" : `minutes/${unit}`}?${query}`);
}
function candleUnitDue(cache, unit, now) {
  return candleRequest(cache, unit, now) !== null;
}
function candleQuality(cache, unit, now) {
  const required = unit === 1440 ? 370 : 400;
  const bars = (cache[unit] ?? []).filter((b) => b.closeTime <= boundaryFor(unit, now));
  const recent = bars.slice(-required), actual = bars.filter((b) => !b.synthetic);
  const gapCount = recent.filter((b, i) => b.synthetic && !b.noTrade || i > 0 && b.openTime !== recent[i - 1].closeTime).length;
  const noTradeCount = recent.filter((b) => b.synthetic && b.noTrade === true).length;
  const exhausted = cache.collection?.[unit]?.exhausted === true;
  const enough = bars.length >= required || unit === 1440 && exhausted && bars.length >= 63;
  const latestActualClose = actual.at(-1)?.closeTime ?? 0;
  const valid = recent.every((b) => [b.open, b.high, b.low, b.close, b.baseVolume, b.quoteVolume].every(Number.isFinite)
    && b.low > 0 && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close)
    && b.baseVolume >= 0 && b.quoteVolume >= 0 && b.closeTime === b.openTime + unit * 60000);
  const ready = enough && valid && !gapCount && latestActualClose === boundaryFor(unit, now);
  return { ready, actualBars: actual.length, required, gapCount, noTradeCount, exhausted, latestActualClose,
    expectedClose: boundaryFor(unit, now), reason: ready ? "완료 봉·이력 확인" : !valid ? "봉 값 오류 확인 대기"
      : !enough && exhausted ? "신규 상장 · 가격 계산 이력 부족"
      : noTradeCount && !gapCount && latestActualClose !== boundaryFor(unit, now) ? "최근 봉 무거래 · 최신 실제 봉 확인 대기"
      : gapCount || latestActualClose !== boundaryFor(unit, now) ? "누락·최신 실제 봉 복구 대기" : "지표 과거 이력 보충 중" };
}
function recommendationQuality(cache, strategy, now) {
  const units = strategy === "scalp" ? [15, 60, 240, 1440] : [60, 240, 1440];
  const frames = Object.fromEntries(units.map((u) => [u, candleQuality(cache, u, now)]));
  return { version: 1, asOf: now, frames, ready: Object.values(frames).every((q) => q.ready) };
}
function qualityCurrent(quality, now) {
  return quality?.version === 1 && quality.ready && [60, 240, 1440].every((u) => quality.frames?.[u]?.ready)
    && Object.entries(quality.frames).every(([u, q]) => q.ready && q.latestActualClose === boundaryFor(Number(u), now));
}
function candleRequest(cache, unit, now) {
  const bars = cache[unit] ?? [], state = cache.collection?.[unit] ?? {};
  if (state.retryAt > now) return null;
  const end = boundaryFor(unit, now), last = bars.at(-1);
  if (!last && state.exhausted && state.checkedAt >= end) return null;
  if (!last || last.closeTime < end || last.synthetic && !last.noTrade) {
    const actual = bars.findLast((b) => !b.synthetic);
    const count = actual ? Math.min(200, Math.max(2, Math.ceil((end - actual.closeTime) / (unit * 60000)) + 1)) : 200;
    return { to: end, kind: "latest", count };
  }
  const required = unit === 1440 ? 370 : 400;
  const gaps = bars.slice(-HISTORY_BARS).filter((b, i, recent) => b.synthetic && !b.noTrade || i > 0 && b.openTime !== recent[i - 1].closeTime);
  const gap = gaps.findLast((b) => b.openTime < (state.gapBefore ?? Infinity)) ?? gaps.at(-1);
  if (gap) return { to: gap.synthetic ? gap.closeTime : gap.openTime, kind: "gap" };
  if (bars.length < required && !state.exhausted) return { to: bars[0].openTime, kind: "history" };
  return null;
}
function cachedTrends(cache, unit, previous, now) {
  const revision = cache.collection?.[unit]?.revision ?? 0;
  const prior = previous?.collectionVersion === 2 && previous.candleRevision === revision ? previous : void 0;
  return { ...advanceTrends(cache[unit] ?? [], prior, now), collectionVersion: 2, candleRevision: revision };
}
async function refreshCandleUnit(market, unit, cache, asOf) {
  const request = candleRequest(cache, unit, asOf);
  if (!request) return cache;
  const existing = cache[String(unit)] ?? [];
  const page = await fetchCandlePage(market, unit, request.to, request.count ?? 200);
  await delay(150);
  if (!page.length && request.kind === "latest") {
    if (existing.length) throw new Error(`${market} ${unit}분 최신 캔들 응답 없음`);
    return { ...cache, [unit]: [], collection: { ...cache.collection, [unit]: {
      ...cache.collection?.[unit], exhausted: true, checkedAt: asOf, retryAt: boundaryFor(unit, asOf) + unit * 60000
    } } };
  }
  if (page.some((r) => r.market !== market || !Number.isFinite(parseUtc(r.candle_date_time_utc)) || parseUtc(r.candle_date_time_utc) >= request.to
    || ![r.opening_price, r.high_price, r.low_price, r.trade_price, r.candle_acc_trade_volume, r.candle_acc_trade_price].every(Number.isFinite)
    || r.low_price <= 0 || r.low_price > Math.min(r.opening_price, r.trade_price) || r.high_price < Math.max(r.opening_price, r.trade_price)
    || r.candle_acc_trade_volume < 0 || r.candle_acc_trade_price < 0)) throw new Error(`${market} ${unit}분 캔들 값 검증 실패`);
  const key = String(unit);
  const retained = existing.filter((c) => !c.synthetic).map((c) => ({
    market,
    unit,
    candle_date_time_utc: new Date(c.openTime).toISOString(),
    opening_price: c.open,
    high_price: c.high,
    low_price: c.low,
    trade_price: c.close,
    candle_acc_trade_volume: c.baseVolume,
    candle_acc_trade_price: c.quoteVolume
  }));
  const candles = normalizeCandles([...retained, ...page], unit, asOf).slice(-HISTORY_BARS);
  const old = new Map(existing.map((b) => [b.openTime, b])), lastClose = existing.at(-1)?.closeTime ?? 0;
  // 정상 페이지가 실제로 덮은 시간 범위의 빈 구간만 무거래로 확인한다.
  // 합성 봉 표시는 유지하여 이를 실제 체결이나 가격 심사 통과로 오인하지 않는다.
  const coveredFrom = page.length ? Math.min(...page.map((r) => parseUtc(r.candle_date_time_utc))) : request.to;
  for (const bar of candles) {
    if (bar.synthetic && (old.get(bar.openTime)?.noTrade === true || bar.openTime >= coveredFrom && bar.closeTime <= request.to)) bar.noTrade = true;
  }
  const changed = candles.some((b) => b.closeTime <= lastClose && (!old.has(b.openTime)
    || ["open", "high", "low", "close", "baseVolume", "quoteVolume", "synthetic"].some((k) => b[k] !== old.get(b.openTime)[k])));
  const state = cache.collection?.[unit] ?? {};
  const progress = candles.filter((b) => !b.synthetic).length > existing.filter((b) => !b.synthetic).length || changed;
  return { ...cache, [key]: candles, collection: { ...cache.collection, [unit]: {
    checkedAt: asOf, revision: (state.revision ?? 0) + Number(changed),
    exhausted: state.exhausted || (request.count ?? 200) === 200 && page.length < 200,
    gapBefore: request.kind === "gap" ? page.length ? Math.min(...page.map((r) => parseUtc(r.candle_date_time_utc))) : request.to - unit * 60000 : state.gapBefore,
    retryAt: request.kind === "gap" && !progress || candles.at(-1)?.synthetic && !candles.at(-1)?.noTrade ? asOf + 60000 : 0
  } } };
}
async function fetchExecutionQualities(markets, notionalKrw, asOf) {
  if (markets.length === 0) return /* @__PURE__ */ new Map();
  const encodedMarkets = encodeURIComponent(markets.join(","));
  const [books, instruments] = await Promise.all([
    requestJson(`/orderbook?markets=${encodedMarkets}&level=0&count=30`),
    requestJson(`/orderbook/instruments?markets=${encodedMarkets}`)
  ]);
  const tickSizes = new Map(instruments.map((item) => {
    const parsed = Number(item.tick_size);
    return [item.market, Number.isFinite(parsed) && parsed > 0 ? parsed : void 0];
  }));
  return new Map(books.map((book) => {
    const normalized = {
      market: book.market,
      timestamp: book.timestamp,
      levels: book.orderbook_units.map((level) => ({
        askPrice: level.ask_price,
        bidPrice: level.bid_price,
        askSize: level.ask_size,
        bidSize: level.bid_size
      }))
    };
    return [book.market, calculateExecutionQuality(normalized, notionalKrw, tickSizes.get(book.market), asOf)];
  }));
}
function calculateExecutionQuality(book, notionalKrw, instrumentTickSize, asOf) {
  const best = book.levels[0];
  if (!best || asOf - book.timestamp > 3e4) {
    return {
      spreadPct: Number.POSITIVE_INFINITY,
      buySlippagePct: Number.POSITIVE_INFINITY,
      sufficientDepth: false,
      tickSize: 1,
      tickSizeReferencePrice: 0
    };
  }
  const midpoint = (best.askPrice + best.bidPrice) / 2;
  const spreadPct = midpoint <= 0 ? Number.POSITIVE_INFINITY : (best.askPrice - best.bidPrice) / midpoint * 100;
  let remaining = notionalKrw;
  let quantity = 0;
  let spent = 0;
  for (const level of book.levels) {
    const availableValue = level.askPrice * level.askSize;
    const value = Math.min(remaining, availableValue);
    quantity += value / level.askPrice;
    spent += value;
    remaining -= value;
    if (remaining <= 1e-6) break;
  }
  const sufficientDepth = remaining <= 1e-6 && quantity > 0;
  const averageBuy = sufficientDepth ? spent / quantity : Number.POSITIVE_INFINITY;
  const buySlippagePct = sufficientDepth ? (averageBuy - best.askPrice) / best.askPrice * 100 : Number.POSITIVE_INFINITY;
  return {
    spreadPct,
    buySlippagePct,
    sufficientDepth,
    tickSize: instrumentTickSize && instrumentTickSize > 0 ? instrumentTickSize : krwTickSize(best.askPrice),
    tickSizeReferencePrice: best.askPrice
  };
}

// lib/paper-trades.ts
function newPaper(candidate, variant, now) {
  return {
    id: `${variant}:${candidate.plan.id ?? `${candidate.market}:${candidate.strategy}:${candidate.signalTime}`}`,
    variant,
    market: candidate.market,
    status: "pending",
    createdAt: now,
    lastClose: now,
    entryExpires: candidate.entryValidUntil ?? candidate.plan.expiresAt,
    holdUntil: now + (candidate.strategy === "scalp" ? 6 : 72) * 36e5,
    entry: candidate.plan.entryAnchor,
    stop: candidate.plan.stop,
    targets: candidate.plan.targets,
    sold: 0,
    netPct: 0,
    costRate: 5e-4 + candidate.metrics.slippagePct / 100
  };
}
function returnAt(trade, price) {
  return (price * (1 - trade.costRate) / (trade.entry * (1 + trade.costRate)) - 1) * 100;
}
function advancePaper(original, candles, now) {
  const trade = { ...original };
  if (trade.status !== "pending" && trade.status !== "open") return trade;
  const bars = candles.filter((c) => c.openTime >= trade.createdAt && c.closeTime > trade.lastClose && c.closeTime <= now);
  if (bars.length && bars[0].openTime > Math.ceil(trade.lastClose / 9e5) * 9e5) {
    trade.status = "data_gap";
    return trade;
  }
  for (const bar of bars) {
    if (bar.synthetic) {
      trade.status = "data_gap";
      return trade;
    }
    trade.lastClose = bar.closeTime;
    if (trade.status === "pending") {
      if (bar.openTime >= trade.entryExpires) {
        trade.status = "expired";
        return trade;
      }
      if (bar.low <= trade.entry && bar.high >= trade.entry) {
        trade.status = "open";
        trade.filledAt = bar.openTime;
        if (bar.low <= trade.stop || bar.high >= trade.targets[0]) {
          trade.status = "ambiguous";
          return trade;
        }
      }
      continue;
    }
    const hitsStop = bar.low <= trade.stop;
    const hitsTarget = trade.sold < trade.targets.length && bar.high >= trade.targets[trade.sold];
    if (hitsStop && hitsTarget) {
      trade.status = "ambiguous";
      return trade;
    }
    if (hitsStop) {
      trade.netPct += returnAt(trade, Math.min(bar.open, trade.stop)) * (3 - trade.sold) / 3;
      trade.status = "closed";
      return trade;
    }
    while (trade.sold < trade.targets.length && bar.high >= trade.targets[trade.sold]) {
      trade.netPct += returnAt(trade, trade.targets[trade.sold]) / 3;
      trade.sold++;
    }
    if (trade.sold === 3) {
      trade.status = "closed";
      return trade;
    }
    if (bar.closeTime >= trade.holdUntil) {
      trade.netPct += returnAt(trade, bar.close) * (3 - trade.sold) / 3;
      trade.status = "closed";
      return trade;
    }
  }
  if (trade.status === "pending" && now >= trade.entryExpires) trade.status = "expired";
  return trade;
}
async function trackPaper(db, market, candles, improved, legacy, now) {
  const rows = (await db.prepare("SELECT payload_json FROM paper_signals WHERE market = ? AND variant != ? AND status IN ('pending', 'open')").bind(market, RECOMMENDATION_VERSION).all()).results;
  const writes = [];
  for (const row of rows) {
    const original = JSON.parse(row.payload_json);
    const updated = advancePaper(original, candles, now);
    if (JSON.stringify(updated) !== row.payload_json) writes.push(db.prepare("UPDATE paper_signals SET status = ?, payload_json = ? WHERE id = ?").bind(updated.status, JSON.stringify(updated), updated.id));
  }
  for (const [variant, candidates] of [["opportunity-v5", improved], ["pre-confluence-v2", legacy]]) {
    for (const candidate of candidates) {
      const model = candidate.plan.version === "indicator-v4" ? "indicator-v4" : variant;
      const trade = newPaper(candidate, model, now);
      writes.push(db.prepare("INSERT OR IGNORE INTO paper_signals VALUES (?, ?, ?, ?, ?)").bind(trade.id, model, market, trade.status, JSON.stringify(trade)));
    }
  }
  if (writes.length) await db.batch(writes);
}
async function paperSummary(db) {
  const rows = (await db.prepare(`SELECT variant, COUNT(*) AS total,
    SUM(status = 'pending') AS pending, SUM(status = 'open') AS open,
    SUM(status = 'closed') AS closed, SUM(status IN ('ambiguous', 'data_gap')) AS ambiguous,
    AVG(CASE WHEN status = 'closed' THEN json_extract(payload_json, '$.netPct') ELSE NULL END) AS meanNetPct
    FROM paper_signals GROUP BY variant`).all()).results;
  return rows;
}

// 추천 원장. 구형 모의 거래와 분리하고 최초 추천의 가격과 선별 근거를 보존한다.
var RECOMMENDATION_VERSION = "recommendation-close-v1";
function newRecommendation(candidate, now) {
  const { charts, ...snapshot } = candidate;
  return {
    id: `${RECOMMENDATION_VERSION}:${candidate.plan.id}`,
    variant: RECOMMENDATION_VERSION, market: candidate.market, strategy: candidate.strategy,
    candidate: JSON.parse(JSON.stringify(snapshot)), status: "pending", createdAt: now,
    lastClose: now, stopCheckedThrough: now, stopTimeframe: candidate.strategy === "scalp" ? 15 : 60,
    entry: candidate.plan.entryAnchor, stop: candidate.plan.stop, targets: [...candidate.plan.targets],
    sold: 0, reached: 0, netPct: 0, costRate: 5e-4 + candidate.metrics.slippagePct / 100,
    events: [{ type: "recommended", at: now }]
  };
}
function excludeRecommendation(trade, reason, at) {
  if (!trade.exclusions?.includes(reason)) {
    trade.exclusions = [...trade.exclusions ?? [], reason];
    trade.events.push({ type: "excluded", reason, at });
  }
}
function settleRecommendation(trade, bars, now) {
  if (trade.status !== "closing") return;
  const next = bars.find((b) => !b.synthetic && b.openTime >= trade.endedAt && b.closeTime <= now);
  if (!next) return;
  if (next.openTime > trade.endedAt) excludeRecommendation(trade, "exit_data_gap", next.openTime);
  trade.exitPrice = next.open;
  trade.executedAt = next.openTime;
  trade.netPct += returnAt(trade, next.open) * (3 - trade.sold) / 3;
  trade.status = "closed";
  trade.events.push({ type: "exit", at: next.openTime, price: next.open });
}
function advanceRecommendation(original, candles, now) {
  if (!["pending", "open", "closing"].includes(original.status) || !candles) return original;
  const trade = { ...original, events: [...original.events], exclusions: [...original.exclusions ?? []] };
  const bars = (candles["15"] ?? []).filter((b) => b.closeTime - b.openTime === 9e5 && b.closeTime <= now);
  if (trade.status === "closing") {
    settleRecommendation(trade, bars, now);
    return trade;
  }
  const executionBars = bars.filter((b) => b.openTime >= trade.createdAt && b.closeTime > trade.lastClose);
  const stops = (candles[String(trade.stopTimeframe)] ?? []).filter((b) =>
    b.closeTime - b.openTime === trade.stopTimeframe * 6e4 && b.closeTime > trade.stopCheckedThrough && b.closeTime <= now);
  const byTime = new Map(executionBars.map((bar) => [bar.closeTime, { bar }]));
  for (const stopBar of stops) byTime.set(stopBar.closeTime, { ...byTime.get(stopBar.closeTime), stopBar });
  for (const [at, { bar, stopBar }] of [...byTime].sort((a, b) => a[0] - b[0])) {
    if (bar) {
      if (bar.openTime > Math.ceil(trade.lastClose / 9e5) * 9e5 || bar.synthetic) {
        excludeRecommendation(trade, "candle_data_gap", at);
      }
      trade.lastClose = at;
      if (!bar.synthetic) {
        let justFilled = false;
        if (trade.status === "pending" && !trade.entryMissedAt && bar.low <= trade.entry && bar.high >= trade.entry) {
          trade.status = "open";
          trade.filledAt = bar.openTime;
          justFilled = true;
          trade.events.push({ type: "entry_touch", at: bar.openTime, price: trade.entry });
        }
        while (trade.reached < 3 && bar.high >= trade.targets[trade.reached]) {
          trade.events.push({ type: `target_${trade.reached + 1}`, at, price: trade.targets[trade.reached] });
          trade.reached++;
        }
        if (trade.status === "pending" && trade.reached > 0) trade.entryMissedAt ??= at;
        if (trade.status === "open") {
          if (justFilled && bar.high >= trade.targets[0]) excludeRecommendation(trade, "entry_target_order_unknown", at);
          while (trade.sold < 3 && bar.high >= trade.targets[trade.sold]) {
            trade.netPct += returnAt(trade, trade.targets[trade.sold]) / 3;
            trade.sold++;
          }
        }
        if (trade.reached === 3) {
          trade.status = trade.filledAt !== void 0 ? "closed" : "unfilled";
          trade.endedAt = at;
          trade.exitReason = "target_3";
          trade.exitPrice = trade.filledAt !== void 0 ? trade.targets[2] : void 0;
          trade.events.push({ type: "completed", at, reason: "target_3" });
          break;
        }
      }
    }
    if (stopBar) {
      if (stopBar.openTime > trade.stopCheckedThrough || stopBar.synthetic) excludeRecommendation(trade, "stop_data_gap", at);
      if (trade.status === "open" && trade.lastClose < at) excludeRecommendation(trade, "candle_data_gap", at);
      trade.stopCheckedThrough = at;
      if (!stopBar.synthetic && stopBar.close < trade.stop) {
        trade.endedAt = at;
        trade.confirmedClose = stopBar.close;
        trade.exitReason = "stop_close";
        trade.status = trade.status === "open" ? "closing" : "unfilled";
        trade.events.push({ type: "stop_close", at, price: stopBar.close, timeframe: trade.stopTimeframe });
        settleRecommendation(trade, bars, now);
        break;
      }
    }
  }
  return trade;
}
async function activeRecommendations(db) {
  const rows = (await db.prepare("SELECT payload_json FROM paper_signals WHERE variant = ? AND status IN ('pending', 'open', 'closing')")
    .bind(RECOMMENDATION_VERSION).all()).results;
  return rows.map((r) => JSON.parse(r.payload_json));
}
async function saveRecommendations(db, active, cached, payload, now) {
  const writes = [];
  for (const original of active) {
    const updated = advanceRecommendation(original, cached.get(original.market), now);
    if (JSON.stringify(updated) !== JSON.stringify(original)) {
      writes.push(db.prepare("UPDATE paper_signals SET status = ?, payload_json = ? WHERE id = ?")
        .bind(updated.status, JSON.stringify(updated), updated.id));
    }
  }
  for (const candidate of [...payload.scalp, ...payload.swing]) {
    // 같은 시장·전략의 진행 계획이 있으면 별도 가격의 추천을 중복 발행하지 않는다.
    if (active.some((r) => !r.endedAt && r.market === candidate.market && r.strategy === candidate.strategy)) continue;
    const trade = newRecommendation(candidate, now);
    writes.push(db.prepare("INSERT OR IGNORE INTO paper_signals VALUES (?, ?, ?, ?, ?)")
      .bind(trade.id, trade.variant, trade.market, trade.status, JSON.stringify(trade)));
  }
  if (writes.length) await db.batch(writes);
}
async function recommendationDashboard(db, payload, now, tickers = []) {
  const queries = await db.batch([
    db.prepare("SELECT payload_json FROM paper_signals WHERE variant = ? AND status IN ('pending', 'open', 'closing')").bind(RECOMMENDATION_VERSION),
    db.prepare("SELECT payload_json FROM paper_signals WHERE variant = ? AND status IN ('closed', 'unfilled') ORDER BY json_extract(payload_json, '$.endedAt') DESC LIMIT 100").bind(RECOMMENDATION_VERSION),
    db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending, SUM(status = 'open') AS open,
      SUM(status = 'closing') AS closing, SUM(status = 'unfilled') AS unfilled,
      SUM(status = 'closed' AND COALESCE(json_array_length(json_extract(payload_json, '$.exclusions')), 0) = 0) AS evaluated,
      SUM(status = 'closed' AND COALESCE(json_array_length(json_extract(payload_json, '$.exclusions')), 0) = 0 AND json_extract(payload_json, '$.netPct') > 0) AS wins,
      SUM(COALESCE(json_array_length(json_extract(payload_json, '$.exclusions')), 0) > 0) AS excluded,
      AVG(CASE WHEN status = 'closed' AND COALESCE(json_array_length(json_extract(payload_json, '$.exclusions')), 0) = 0 THEN json_extract(payload_json, '$.netPct') END) AS meanNetPct
      FROM paper_signals WHERE variant = ?`).bind(RECOMMENDATION_VERSION)
  ]);
  const live = new Map([...payload.savedPlans ?? [], ...payload.scalp, ...payload.swing].map((c) => [c.plan.id, c]));
  const prices = new Map(tickers.map((t) => [t.market, t]));
  const ready = new Set([...payload.scalp, ...payload.swing].map((c) => c.plan.id));
  const active = queries[0].results.map((r) => JSON.parse(r.payload_json));
  const rows = active.filter((r) => !r.endedAt).map((record) => {
    const current = live.get(record.candidate.plan.id);
    const ticker = prices.get(record.market);
    const assessmentFresh = !payload.stale && qualityCurrent(current?.dataQuality, now) && current?.selectionVersion === 2 && current.currentAssessment?.version === 2
      && current.rankingAt <= now && now - current.rankingAt <= SIGNAL_FRESH_MS;
    return { ...record.candidate, currentPrice: ticker?.tradePrice ?? current?.currentPrice,
      currentPriceAt: ticker?.tradePrice != null ? ticker.timestamp : current?.currentPriceAt,
      quoteVolume24h: ticker?.quoteVolume24h ?? current?.quoteVolume24h,
      score: assessmentFresh ? current.rankingScore ?? current.score : 0,
      currentAssessment: assessmentFresh ? current.currentAssessment : null,
      dataQuality: current?.dataQuality,
      rankingAt: assessmentFresh ? current.rankingAt : null,
      entryStatus: assessmentFresh && ready.has(record.candidate.plan.id) && !record.entryMissedAt ? "ready" : "waiting",
      entryValidUntil: current?.entryValidUntil ?? 0,
      trackingDelayed: Math.floor(now / 9e5) * 9e5 > record.lastClose || Math.floor(now / (record.stopTimeframe * 6e4)) * record.stopTimeframe * 6e4 > record.stopCheckedThrough,
      tracking: record };
  }).sort((a, b) => Number(b.entryStatus === "ready") - Number(a.entryStatus === "ready") || b.score - a.score
    || (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0) || a.market.localeCompare(b.market) || a.strategy.localeCompare(b.strategy));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { rule: RECOMMENDATION_VERSION, updatedAt: now, active: rows,
    history: [...active.filter((r) => r.endedAt), ...queries[1].results.map((r) => JSON.parse(r.payload_json))],
    summary: queries[2].results[0] };
}

// lib/plan-lifecycle.ts
function createSavedPlan(candidate, now = candidate.signalTime) {
  return { candidate, checkedThrough: now, monitoringStartedAt: now, lifecycleVersion: 2,
    stopTimeframe: candidate.strategy === "scalp" ? 15 : 60 };
}
function advanceSavedPlan(original, candles, price, now) {
  // 구형 종료는 보존하고, 살아 있는 계획만 현재 관측 시점부터 새 규칙으로 이행한다.
  const result = original.lifecycleVersion === 2 || original.stoppedAt !== void 0 ? { ...original }
    : { ...original, lifecycleVersion: 2, stopTimeframe: original.candidate.strategy === "scalp" ? 15 : 60,
        monitoringStartedAt: now, checkedThrough: now };
  if (result.stoppedAt !== void 0 || result.completedAt !== void 0) return result;
  const plan = original.candidate.plan;
  const duration = result.stopTimeframe * 6e4;
  const bars = candles.filter((c) => c.closeTime - c.openTime === duration && c.closeTime > result.checkedThrough && c.closeTime <= now);
  for (const bar of bars) {
    if (bar.openTime > result.checkedThrough || bar.synthetic) result.hasGap = true;
    if (!bar.synthetic) {
      if (bar.openTime >= result.monitoringStartedAt) {
        if (bar.high >= plan.targets[0]) result.targetReachedAt ??= bar.closeTime;
        if (bar.high >= plan.targets[2]) result.completedAt ??= bar.closeTime;
      }
      if (bar.close < plan.stop && result.completedAt === void 0) result.stoppedAt = bar.closeTime;
    }
    result.checkedThrough = bar.closeTime;
    if (result.stoppedAt !== void 0 || result.completedAt !== void 0) break;
  }
  if (price >= plan.targets[0]) result.targetReachedAt ??= now;
  if (result.stoppedAt === void 0 && price >= plan.targets[2]) result.completedAt ??= now;
  return result;
}
function planBlockReason(plan) {
  if (plan.stoppedAt !== void 0) return "기준봉 종가 손절가 하회 · 계획 종료";
  if (plan.completedAt !== void 0) return "3차 목표 도달 · 계획 종료";
  if (plan.hasGap) return "관측 이력 공백 · 신규 진입 대기";
  if (plan.targetReachedAt !== void 0) return "1차 목표 도달 이력 · 신규 진입 대기";
  return void 0;
}
function canReplacePlan(previous, candidate) {
  const endedAt = previous?.stoppedAt ?? previous?.completedAt;
  return !previous || endedAt !== void 0 && candidate.signalTime > endedAt;
}
function describeSavedPlan(saved, candidate, reason, now, validFor) {
  const block = planBlockReason(saved);
  const ready = Boolean(candidate) && !block;
  const snapshot = candidate ?? saved.candidate;
  return { ...saved, candidate: {
    ...snapshot,
    setup: saved.candidate.setup,
    signalTime: saved.candidate.signalTime,
    plan: saved.candidate.plan,
    entryStatus: saved.stoppedAt !== void 0 ? "stopped" : saved.completedAt !== void 0 ? "completed" : ready ? "ready" : "waiting",
    entryBlockReason: block ?? (ready ? void 0 : reason),
    entryValidUntil: ready ? now + validFor : 0
  } };
}

// lib/scanner.ts
var ANALYSIS_NOTIONAL_KRW = 1e6;
var ASSUMED_FEE_RATE = 5e-4;
var CANDLE_BUDGET = 240;
// 정밀 결과 저장 시간을 확보하고 다음 대기 검사 회차가 밀리지 않게 한다.
var MARKET_BATCH = 20;
function summarizeMarkets(results, markets, tickers, regime, now, executions = /* @__PURE__ */ new Map()) {
  const safe = new Map(markets.filter(isAnalysisMarket).map((m) => [m.market, m]));
  const prices = new Map(tickers.map((t) => [t.market, t]));
  const valid = results.filter((r) => safe.has(r.market));
  const eligible = new Set(tickers.filter((t) => safe.has(t.market) && highTurnover(results.find((r) => r.market === t.market), now)).map((t) => t.market));
  const analyzed = valid.filter((r) => eligible.has(r.market) && r.engineVersion === 5 && r.analyzedAt > 0);
  const observations = [];
  const accepted = [];
  const legacy = [];
  const savedPlans = [];
  const diagnostics = {};
  let fresh = 0;
  for (const result of valid) {
    const ticker = prices.get(result.market);
    if (!ticker) continue;
    if (!eligible.has(result.market) && !result.plans?.length) continue;
    if (result.engineVersion !== 5 && !result.plans?.length) {
      for (const strategy of ["scalp", "swing"]) {
        const unit = strategy === "scalp" ? 15 : 60, gate = result.primary?.[unit];
        const code = gate?.ready && gate.closeTime === boundaryFor(unit, now) && gate.direction === -1 ? "ST_SELL"
          : result.primaryCollection?.[unit]?.ready && result.primaryCollection[unit].reason === "최근 완료 시간대 무거래" ? "NO_TRADE" : "ENGINE_WARMUP";
        observations.push({
        market: result.market,
        koreanName: safe.get(result.market).koreanName,
        strategy,
        currentPrice: ticker.tradePrice,
        quoteVolume24h: ticker.quoteVolume24h,
        analyzedAt: result.analyzedAt,
        code,
        reason: REASONS[code],
        trendScore: 0
        });
        diagnostics[code] = (diagnostics[code] ?? 0) + 1;
      }
      continue;
    }
    const isFresh = result.engineVersion === 5 && result.entryGateVersion === 1 && result.selection?.version === 2 && now - result.analyzedAt <= SIGNAL_FRESH_MS;
    if (isFresh && eligible.has(result.market)) fresh++;
    for (const saved of result.plans ?? []) {
      const observed = advanceSavedPlan(saved, [], ticker.tradePrice, now);
      const candidate = observed.candidate;
      const execution = executions.get(candidate.market);
      const plan = execution ? costedPlan(candidate.plan, ASSUMED_FEE_RATE, execution.buySlippagePct) : candidate.plan;
      const reason = planBlockReason(observed) ?? (markets.exclusionStatus?.ready === false || !entryGateCurrent(candidate, now) || result.primary?.[candidate.strategy === "scalp" ? 15 : 60]?.direction !== 1 || !result.primary[candidate.strategy === "scalp" ? 15 : 60].ready || result.primary[candidate.strategy === "scalp" ? 15 : 60].closeTime !== boundaryFor(candidate.strategy === "scalp" ? 15 : 60, now) || !isFresh || !qualityCurrent(candidate.dataQuality, now) || candidate.selectionVersion !== 2 ? REASONS.DATA_DELAYED : regime === "RISK_OFF" ? REASONS.BTC_RISK_OFF : !eligible.has(candidate.market) ? REASONS.LOW_LIQUIDITY : !execution?.sufficientDepth || execution.buySlippagePct > (candidate.strategy === "scalp" ? 0.15 : 0.25) || (plan.netReturns?.[0] ?? -1) <= 0 ? REASONS.POOR_EXECUTION : candidate.entryStatus !== "ready" ? candidate.entryBlockReason ?? "신규 진입 조건 재확인 대기" : !entryStillValid(candidate, ticker.tradePrice, now) ? REASONS.CURRENT_PRICE_OUTSIDE_ENTRY : void 0);
      savedPlans.push({
        ...candidate,
        plan,
        currentPrice: ticker.tradePrice,
        currentPriceAt: ticker.timestamp,
        quoteVolume24h: ticker.quoteVolume24h,
        currentAssessment: isFresh ? candidate.currentAssessment : null,
        rankingAt: isFresh ? candidate.rankingAt : null,
        entryStatus: observed.stoppedAt !== void 0 ? "stopped" : observed.completedAt !== void 0 ? "completed" : reason ? "waiting" : "ready",
        entryBlockReason: reason
      });
    }
    for (const candidate of result.candidates) {
      if (!validPricePlan(candidate.plan)) continue;
      const saved = savedPlans.find((c) => c.market === candidate.market && c.strategy === candidate.strategy);
      const execution = executions.get(candidate.market);
      const plan = execution ? costedPlan(candidate.plan, ASSUMED_FEE_RATE, execution.buySlippagePct) : candidate.plan;
      const executionOk = execution?.sufficientDepth && execution.buySlippagePct <= (candidate.strategy === "scalp" ? 0.15 : 0.25) && (plan.netReturns?.[0] ?? -1) > 0;
      if (markets.exclusionStatus?.ready !== false && entryGateCurrent(candidate, now) && result.primary?.[candidate.strategy === "scalp" ? 15 : 60]?.direction === 1 && result.primary[candidate.strategy === "scalp" ? 15 : 60].ready && result.primary[candidate.strategy === "scalp" ? 15 : 60].closeTime === boundaryFor(candidate.strategy === "scalp" ? 15 : 60, now) && (!saved || saved.entryStatus === "ready") && isFresh && qualityCurrent(candidate.dataQuality, now) && candidate.selectionVersion === 2 && regime !== "RISK_OFF" && eligible.has(candidate.market) && executionOk && entryStillValid(candidate, ticker.tradePrice, now)) {
        accepted.push({
          ...candidate,
          currentPrice: ticker.tradePrice,
          currentPriceAt: ticker.timestamp,
          quoteVolume24h: ticker.quoteVolume24h,
          signedChangeRate: ticker.signedChangeRate,
          warnings: withSpreadWarning(candidate.warnings, candidate.strategy, execution.spreadPct),
          plan,
          metrics: { ...candidate.metrics, spreadPct: execution.spreadPct, slippagePct: execution.buySlippagePct }
        });
      } else {
        const code = saved && saved.entryStatus !== "ready" ? "SAVED_PLAN_WAITING" : !isFresh ? "DATA_DELAYED" : regime === "RISK_OFF" ? "BTC_RISK_OFF" : !eligible.has(candidate.market) ? "LOW_LIQUIDITY" : !executionOk ? "POOR_EXECUTION" : "CURRENT_PRICE_OUTSIDE_ENTRY";
        if (eligible.has(candidate.market)) observations.push({
          market: candidate.market,
          koreanName: candidate.koreanName,
          strategy: candidate.strategy,
          currentPrice: ticker.tradePrice,
          quoteVolume24h: ticker.quoteVolume24h,
          analyzedAt: result.analyzedAt,
          code,
          reason: code === "SAVED_PLAN_WAITING" ? saved.entryBlockReason ?? REASONS[code] : REASONS[code],
          trendScore: candidate.score
        });
        diagnostics[code] = (diagnostics[code] ?? 0) + 1;
      }
    }
    if (isFresh && regime !== "RISK_OFF") legacy.push(...result.legacy.filter((c) => ticker.quoteVolume24h >= ENTRY_VOLUME[c.strategy] && entryStillValid(c, ticker.tradePrice, now)));
    for (const observation of result.observations) {
      if (!eligible.has(result.market)) continue;
      const code = !isFresh ? "DATA_DELAYED" : regime === "RISK_OFF" ? "BTC_RISK_OFF" : observation.code;
      diagnostics[code] = (diagnostics[code] ?? 0) + 1;
      observations.push({ ...observation, currentPrice: ticker.tradePrice, quoteVolume24h: ticker.quoteVolume24h, code, reason: code === observation.code ? observation.reason : REASONS[code] ?? code });
    }
  }
  const btc = prices.get("KRW-BTC");
  const pipeline = pipelineCoverage(results, markets, now);
  const recommendations = pipeline.primaryComplete ? rankedStRecommendations(results, markets, prices, now, accepted) : [];
  return {
    schemaVersion: 5,
    pipeline,
    stRecommendationVersion: 1,
    stRecommendations: recommendations,
    entryRiskExclusions: valid.filter((r) => eligible.has(r.market) && prices.has(r.market)).map((r) => ({ market: r.market,
      name: safe.get(r.market).koreanName, ...recommendationRisk(r, prices.get(r.market), now) })).filter((r) => r.blocked),
    turnoverCoverage: [...safe.values()].reduce((a, m) => {
      const t = results.find((r) => r.market === m.market)?.turnover;
      const group = t?.version === 2 && t.ready && t.candleClose === boundaryFor(60, now) ? t.group : "pending";
      a[group]++; return a;
    }, { high: 0, low: 0, pending: 0, total: safe.size }),
    volumeMonitor: [...safe.values()].flatMap((m) => {
      const t = results.find((r) => r.market === m.market)?.turnover;
      return t?.ready && t.group === "low" ? [{ market: m.market, name: m.koreanName, ...t }] : [];
    }),
    generatedAt: now,
    priceUpdatedAt: now,
    source: "live",
    stale: false,
    savedPlans,
    analysisNotionalKrw: ANALYSIS_NOTIONAL_KRW,
    marketRegime: regime,
    btcPrice: btc?.tradePrice ?? null,
    btcChangeRate: btc?.signedChangeRate ?? null,
    userExcludedMarkets: markets.filter((m) => m.market === "KRW-USDT").map((m) => ({ market: m.market, name: m.koreanName, reason: "사용자 지정 제외" })),
    marketExclusions: { ...(markets.exclusionStatus ?? { ready: true }), excluded: markets.filter((m) => m.warned).map((m) => ({ market: m.market, reason: m.exclusionReason ?? "거래 유의 종목" })) },
    primaryCoverage: Object.fromEntries([15, 60].map((unit) => {
      const end = boundaryFor(unit, now);
      const details = [...safe.values()].map((market) => {
        const r = results.find((r) => r.market === market.market), p = r?.primary?.[unit];
        const status = !highTurnover(r, now) ? "volume_monitor" : !p ? "unscanned" : boundaryFor(unit, p.checkedAt ?? 0) !== end ? "recheck"
          : p.error ? "api_error" : p.ready && p.closeTime === end ? p.direction === 1 ? "buy" : "sell"
          : p.latestActualClose !== end && r?.primaryCollection?.[unit]?.ready && r.primaryCollection[unit].reason === "최근 완료 시간대 무거래" ? "no_trade"
          : p.latestActualClose !== end ? "missing_latest" : p.actualBars < 10 ? "history_short" : "indicator";
        return { market: market.market, name: market.koreanName, status, lastDirection: p?.direction ?? null, checkedAt: p?.checkedAt ?? 0,
          latestActualClose: p?.latestActualClose ?? 0, actualBars: p?.actualBars ?? 0, error: p?.error,
          detailChecked: status === "buy" && r?.entryGateVersion === 1 && r.analyzedAt >= end };
      });
      const counts = details.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {});
      const buy = counts.buy ?? 0, sell = counts.sell ?? 0, noTrade = counts.no_trade ?? 0, waiting = (counts.unscanned ?? 0) + (counts.recheck ?? 0);
      const total = details.length - (counts.volume_monitor ?? 0);
      return [unit, { total, checked: details.filter((p) => p.status !== "volume_monitor" && p.checkedAt > 0).length,
        inspected: total - waiting, buy, sell, pending: total - buy - sell, waiting,
        unavailable: total - buy - sell - waiting - noTrade, noTrade, counts, details: details.filter((p) => p.status !== "volume_monitor"),
        detailChecked: details.filter((p) => p.detailChecked).length, candleClose: end }];
    })),
    coverage: {
      krwMarketCount: markets.length,
      eligibleMarketCount: eligible.size,
      analyzedMarketCount: analyzed.length,
      completedMarketCount: analyzed.filter((r) => r.complete).length,
      pendingMarketCount: Math.max(0, eligible.size - analyzed.length),
      freshMarketCount: fresh,
      delayedMarketCount: analyzed.filter((r) => now - r.analyzedAt > SIGNAL_FRESH_MS).length,
      monitoringMarketCount: safe.size - eligible.size,
      volumeGrowthMarketCount: tickers.filter((t) => eligible.has(t.market) && t.quoteVolume24h < ENTRY_VOLUME.scalp).length,
      oldestAnalysisAt: analyzed.length ? Math.min(...analyzed.map((r) => r.analyzedAt)) : void 0
    },
    scalp: recommendations.filter((c) => c.strategy === "scalp"),
    swing: recommendations.filter((c) => c.strategy === "swing"),
    watchlist: observations.sort((a, b) => Number(a.code === "DATA_DELAYED" || a.code === "ENGINE_WARMUP") - Number(b.code === "DATA_DELAYED" || b.code === "ENGINE_WARMUP") || b.trendScore - a.trendScore || b.quoteVolume24h - a.quoteVolume24h),
    diagnostics,
    comparison: { legacy: legacy.length, improved: accepted.length, note: "같은 시장의 이전 R목표 전략과 구조 목표 전략 비교. 진입 조건도 일부 달라 순수 목표가 성과 비교는 아닙니다." },
    rejections: {
      lowLiquidity: diagnostics.LOW_LIQUIDITY ?? 0,
      marketWarning: markets.length - safe.size,
      technicalConditions: observations.filter((o) => !["LOW_LIQUIDITY", "POOR_EXECUTION", "DATA_DELAYED", "INSUFFICIENT_DATA"].includes(o.code)).length,
      executionQuality: diagnostics.POOR_EXECUTION ?? 0,
      insufficientData: diagnostics.INSUFFICIENT_DATA ?? 0
    },
    notice: "가격 계획 고정 · 신규 진입 상태 별도 확인 · 모의 주문금액 100만원 · 편도 수수료 가정 0.05% · 스프레드는 주의 표시만 · 자동주문 없음"
  };
}
function pipelineCurrent(pipeline, now) {
  return pipeline?.version === 1 && pipeline.primaryComplete && pipeline.turnoverClose === boundaryFor(60, now)
    && pipeline.details?.length === pipeline.total && pipeline.details.every((d) => d.group === "low" || d.group === "high"
      && [15, 60].every((u) => d.frames?.[u]?.ready && d.frames[u].candleClose === boundaryFor(u, now)));
}
function cachedPayload(payload, now, error) {
  payload = { ...payload };
  for (const key of ["stRecommendations", "scalp", "swing", "promising", "watchlist", "volumeMonitor"]) {
    if (payload[key]) payload[key] = payload[key].filter((c) => c.market !== "KRW-USDT");
  }
  const stale = payload.schemaVersion !== 5 || now - payload.generatedAt > 3 * 6e4 || Boolean(error);
  const pipelineReady = pipelineCurrent(payload.pipeline, now);
  return {
    ...payload,
    stRecommendations: stale || !pipelineReady || !payload.marketExclusions?.ready ? [] : (payload.stRecommendations ?? []).filter((c) => c.actionableVersion === 1 && pricePlanCurrent(c, now) && c.risk?.version === 1 && c.risk.ready && !c.risk.blocked && c.turnover?.candleClose === boundaryFor(60, now) && c.turnover?.average3d >= TURNOVER_MIN),
    source: "cached",
    stale,
    promising: stale || !payload.marketExclusions?.ready ? [] : (payload.promising ?? []).filter((c) => c.dailyQuality?.ready && c.dailyQuality.latestActualClose === boundaryFor(1440, now)),
    scalp: stale || !pipelineReady || !payload.marketExclusions?.ready ? [] : payload.scalp.filter((c) => c.actionableVersion === 1 && pricePlanCurrent(c, now) && entryGateCurrent(c, now) && qualityCurrent(c.dataQuality, now) && entryStillValid(c, c.currentPrice, now)),
    swing: stale || !pipelineReady || !payload.marketExclusions?.ready ? [] : payload.swing.filter((c) => c.actionableVersion === 1 && pricePlanCurrent(c, now) && entryGateCurrent(c, now) && qualityCurrent(c.dataQuality, now) && entryStillValid(c, c.currentPrice, now)),
    savedPlans: payload.savedPlans?.map((c) => ["stopped", "completed"].includes(c.entryStatus) || !stale && payload.marketExclusions?.ready && entryGateCurrent(c, now) && qualityCurrent(c.dataQuality, now) && (c.entryValidUntil ?? 0) > now ? c : { ...c, entryStatus: "waiting", entryBlockReason: stale ? REASONS.DATA_DELAYED : c.entryBlockReason ?? "신규 진입 조건 재확인 대기" }),
    error: error instanceof Error ? error.message : error ? "시세 갱신 실패" : void 0
  };
}
async function getDashboard(db, now = Date.now()) {
  const latest = await getLatestDashboard(db);
  return latest ? cachedPayload(latest, now) : null;
}
async function refreshDashboard(db, options = {}) {
  const now = options.now ?? Date.now();
  const startedAt = Date.now();
  await ensureCycleSchema(db);
  const token = await acquireCycle(db, now);
  if (!token) {
    const latest = await getDashboard(db, now);
    if (latest) return latest;
    throw new Error("첫 묶음을 준비 중입니다. 잠시 후 다시 확인해 주세요.");
  }
  try {
    const markets = await fetchKrwMarkets();
    let tickers = await fetchKrwTickers();
    const rows = await marketRows(db);
    const tracked = await activeRecommendations(db);
    const trackedMarkets = new Set(tracked.map((r) => r.market));
    const checked = new Map(rows.map((row) => [row.market, row.checked_at]));
    const results = new Map(rows.map((row) => [row.market, JSON.parse(row.result_json)]));
    if (options.includeCharts === false) {
      const compact = (candidate) => ({ ...candidate, charts: { "15": [], "60": [], "240": [] } });
      for (const result of results.values()) {
        result.candidates = result.candidates.map(compact);
        result.legacy = result.legacy.map(compact);
        result.plans = result.plans?.map((saved) => ({ ...saved, candidate: compact(saved.candidate) }));
      }
    }
    let budget = CANDLE_BUDGET, collectionDeadline = startedAt + 100000, budgetFloor = 0;
    const cached = /* @__PURE__ */ new Map();
    const load = async (market) => {
      if (!cached.has(market)) cached.set(market, await readCandles(db, market) ?? emptyCandles());
      return cached.get(market);
    };
    const collect = async (market, units, maxPages = 3, persist = true, primaryOnly = false) => {
      let cache = await load(market);
      for (const unit of units) {
        for (let page = 0; page < maxPages && (primaryOnly === "turnover" ? !turnoverClass(cache, now).ready : primaryOnly ? !primaryTrend(cache[unit], unit, now).ready : candleUnitDue(cache, unit, now)); page++) {
          if (!candleUnitDue(cache, unit, now)) break;
          if (budget <= budgetFloor || Date.now() > collectionDeadline) return false;
          budget--;
          cache = await refreshCandleUnit(market, unit, cache, now);
          cached.set(market, cache);
          if (persist) await writeCandles(db, market, cache);
        }
      }
      return true;
    };
    const baseResult = (market) => results.get(market) ?? { market, analyzedAt: 0, complete: false, candidates: [], legacy: [], observations: [] };
    const publish = async (regime = "RISK_OFF", executions = new Map()) => {
      const payload = summarizeMarkets([...results.values()], markets, tickers, regime, now, executions);
      await saveRecommendations(db, tracked, cached, payload, now);
      payload.recommendations = await recommendationDashboard(db, payload, now, tickers);
      payload.promising = promisingMarkets([...results.values()], markets, tickers,
        new Set((payload.stRecommendations ?? [...payload.scalp, ...payload.swing]).map((c) => c.market)), now);
      if (markets.exclusionStatus?.ready === false) payload.promising = [];
      payload.paper = await paperSummary(db);
      await saveDashboard(db, payload);
      return payload;
    };
    const tickerByCode = new Map(tickers.map((t) => [t.market, t]));
    const activePlan = (r) => trackedMarkets.has(r?.market) || !!r?.plans?.some((p) => p.stoppedAt === void 0 && p.completedAt === void 0);
    // 신규 추천에서 제외돼도 기존 원장과 계획은 별도의 순환 예산으로 추적한다.
    const trackCodes = [...new Set([...trackedMarkets, ...[...results.values()].filter(activePlan).map((r) => r.market)])]
      .sort((a, b) => (results.get(a)?.trackingCheckedAt ?? 0) - (results.get(b)?.trackingCheckedAt ?? 0));
    const trackingBudget = budget;
    for (const market of trackCodes) {
      if (trackingBudget - budget >= 12 || Date.now() - startedAt > 10000) break;
      const result = baseResult(market);
      try {
        await collect(market, [15, 60], 1);
        const cache = await load(market), price = tickerByCode.get(market)?.tradePrice ?? cache[15]?.at(-1)?.close;
        result.plans = result.plans?.map((p) => advanceSavedPlan(p, cache[p.candidate.strategy === "scalp" ? 15 : 60] ?? [], price, now));
        await trackPaper(db, market, cache[15] ?? [], [], [], now);
      } catch (error) {
        if (error instanceof UpbitApiError && [418, 429].includes(error.status)) throw error;
        console.warn("기존 추천 추적 대기", market, error.message);
      }
      result.trackingCheckedAt = now;
      results.set(market, result);
      await writeMarket(db, result, await load(market), checked.get(market) ?? 0);
    }
    if (markets.exclusionStatus?.ready === false) return await publish();
    const volumeChecked = new Map([...results.values()].map((r) => [r.market, r.turnover?.checkedAt ?? 0]));
    const volumeQueue = nextMarkets(markets, tickers, volumeChecked).filter((m) =>
      results.get(m.market)?.turnover?.version !== 2 || !results.get(m.market)?.turnover?.ready || results.get(m.market).turnover.candleClose !== boundaryFor(60, now));
    for (let offset = 0; offset < volumeQueue.length; offset += 4) {
      if (budget <= 0 || Date.now() - startedAt > 100000) break;
      const group = volumeQueue.slice(offset, offset + 4), missing = group.filter((m) => !cached.has(m.market));
      if (missing.length) {
        const loaded = await db.batch(missing.map((m) => db.prepare("SELECT COALESCE((SELECT candles_json FROM candle_cache WHERE market = ?), (SELECT candles_json FROM market_analysis WHERE market = ?)) AS candles_json").bind(m.market, m.market)));
        missing.forEach((m, i) => cached.set(m.market, loaded[i].results[0]?.candles_json ? JSON.parse(loaded[i].results[0].candles_json) : emptyCandles()));
      }
      const writes = []; let rateError;
      for (const m of group) {
        const result = { ...baseResult(m.market) };
        try {
          await collect(m.market, [60], 1, false, "turnover");
          result.turnover = turnoverClass(await load(m.market), now);
        } catch (error) {
          result.turnover = { ready: false, group: "pending", checkedAt: now, candleClose: boundaryFor(60, now), error: error.message };
          if (error instanceof UpbitApiError && [418, 429].includes(error.status)) rateError = error;
        }
        results.set(m.market, result);
        const json = JSON.stringify(await load(m.market));
        writes.push(db.prepare("INSERT INTO candle_cache VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET candles_json=excluded.candles_json").bind(m.market, json),
          db.prepare("INSERT INTO market_analysis VALUES (?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET checked_at=excluded.checked_at, result_json=excluded.result_json, candles_json=excluded.candles_json").bind(m.market, checked.get(m.market) ?? 0, JSON.stringify(result), json));
        if (rateError) break;
      }
      if (writes.length) await db.batch(writes);
      if (rateError) throw rateError;
    }
    if (!pipelineCoverage([...results.values()], markets, now).turnoverComplete) return await publish();
    const prepared = [], detailAttempted = new Set();
    const hasCurrentBuy = (result) => highTurnover(result, now) && [15, 60].some((u) => result?.primary?.[u]?.ready
      && result.primary[u].direction === 1 && result.primary[u].closeTime === boundaryFor(u, now));
    const detailDue = (r) => hasCurrentBuy(r) && (r.detailCollectionPending && (r.detailAttemptedAt ?? 0) <= now - 60000 || !r.stAnalysis || r.stAnalysis.riskVersion !== 1
      || [15, 60].some((u) => r.primary?.[u]?.ready && r.primary[u].direction === 1 && r.primary[u].closeTime === boundaryFor(u, now) && r.stAnalysis.primaryClose?.[u] !== boundaryFor(u, now))
      || [240, 1440].some((u) => (r.stAnalysis.frames?.[u]?.checkedAt ?? 0) < boundaryFor(u, now)));
    const prepareMarket = async (market) => {
      const previous = baseResult(market.market), primary = previous.primary, buy = hasCurrentBuy(previous);
      detailAttempted.add(market.market);
      // 실패·일부 수집도 시도 시각을 남겨 같은 종목이 나머지 시장을 계속 가리지 않게 한다.
      const result = { ...previous, detailAttemptedAt: now, detailCollectionPending: true };
      let rateError;
      try {
        if (buy) await collect(market.market, [60, 240], 3, false);
        await collect(market.market, [1440], 3, false);
        if (primary?.[15]?.ready && primary[15].direction === 1 && primary[15].closeTime === boundaryFor(15, now)) await collect(market.market, [15], 3, false);
        const cache = await load(market.market);
        const detailUnits = primary?.[15]?.ready && primary[15].direction === 1 ? [15, 60, 240, 1440] : [60, 240, 1440];
        result.detailCollectionPending = detailUnits.some((unit) => candleRequest({ ...cache,
          collection: { ...cache.collection, [unit]: { ...cache.collection?.[unit], retryAt: 0 } } }, unit, now) !== null);
        result.screen = screenLiquidity(cache[60], now);
        result.stAnalysis = stAnalysis(cache, now);
        result.selection = dailySelection(cache[1440], now);
        result.dailyQuality = candleQuality(cache, 1440, now);
        if (buy) prepared.push({ market, candles: cache });
      } catch (error) {
        if (error instanceof UpbitApiError && [418, 429].includes(error.status)) rateError = error;
        result.candidates = [];
        console.warn("정밀 분석 자료 대기", market.market, error.message);
      }
      results.set(market.market, result);
      const candlesJson = JSON.stringify(await load(market.market));
      await db.batch([
        db.prepare("INSERT INTO candle_cache VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET candles_json=excluded.candles_json").bind(market.market, candlesJson),
        db.prepare("INSERT INTO market_analysis VALUES (?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET checked_at=excluded.checked_at, result_json=excluded.result_json, candles_json=excluded.candles_json").bind(market.market, now, JSON.stringify(result), candlesJson)
      ]);
      if (rateError) throw rateError;
      checked.set(market.market, now);
    };
    // 전체 거래대금 분류가 끝난 뒤 고거래대금 시장의 가격 계산용 분봉을 준비한다.
    const primaryChecked = new Map([...results.values()].map((r) => [r.market, r.primaryCheckedAt ?? 0]));
    const primaryQueue = nextMarkets(markets, tickers, primaryChecked).filter((market) =>
      highTurnover(results.get(market.market), now) && ![15, 60].every((u) => results.get(market.market)?.primaryCollection?.[u]?.ready
        && results.get(market.market).primaryCollection[u].candleClose === boundaryFor(u, now)));
    for (let offset = 0; offset < primaryQueue.length; offset += 4) {
      if (budget <= 0 || Date.now() - startedAt > 100000) break;
      const group = primaryQueue.slice(offset, offset + 4), missing = group.filter((m) => !cached.has(m.market));
      if (missing.length) {
        const loaded = await db.batch(missing.map((m) => db.prepare("SELECT COALESCE((SELECT candles_json FROM candle_cache WHERE market = ?), (SELECT candles_json FROM market_analysis WHERE market = ?)) AS candles_json").bind(m.market, m.market)));
        missing.forEach((m, i) => cached.set(m.market, loaded[i].results[0]?.candles_json ? JSON.parse(loaded[i].results[0].candles_json) : emptyCandles()));
      }
      const writes = [];
      let rateError;
      try {
        for (const market of group) {
          if (budget <= 0 || Date.now() - startedAt > 100000) break;
          const previous = baseResult(market.market);
          const primary = { ...previous.primary }, primaryCollection = { ...previous.primaryCollection }, trends = { ...previous.trends };
          for (const u of [15, 60]) {
            try {
              await collect(market.market, [u], 3, false);
              const cache = await load(market.market);
              primaryCollection[u] = primaryCollectionStatus(cache, u, now);
              trends[u] = cachedTrends(cache, u, previous.trends?.[u], now);
              primary[u] = primaryTrend(cache[u], u, now, trends[u]);
            } catch (error) {
              primaryCollection[u] = { ...primaryCollectionStatus(await load(market.market), u, now), ready: false, error: error.message };
              primary[u] = { ...previous.primary?.[u], version: 1, unit: u, checkedAt: now, closeTime: boundaryFor(u, now), ready: false, state: "unknown", error: error.message };
              if (error instanceof UpbitApiError && [418, 429].includes(error.status)) rateError = error;
            }
            if (rateError) break;
          }
          const result = { ...previous, primary, primaryCollection, trends, primaryCheckedAt: now }, candlesJson = JSON.stringify(await load(market.market));
          results.set(market.market, result);
          writes.push(
            db.prepare("INSERT INTO candle_cache VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET candles_json=excluded.candles_json").bind(market.market, candlesJson),
            db.prepare("INSERT INTO market_analysis VALUES (?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET checked_at=excluded.checked_at, result_json=excluded.result_json, candles_json=excluded.candles_json").bind(market.market, checked.get(market.market) ?? 0, JSON.stringify(result), candlesJson)
          );
          if (rateError) break;
        }
      } finally {
        // 연결 오류·요청 제한에도 이 묶음에서 이미 받은 실제 봉과 검사 결과를 함께 저장한다.
        if (writes.length) await db.batch(writes);
      }
      if (rateError) throw rateError;
    }
    if (!pipelineCoverage([...results.values()], markets, now).primaryComplete || budget <= 12 || Date.now() - startedAt > 95000) return await publish();
    await collect("KRW-BTC", [60, 240]);
    const btcCandles = await load("KRW-BTC");
    if (btcCandles["60"].length < 55 || btcCandles["240"].length < 200 || [60, 240].some((unit) => btcCandles[unit].at(-1)?.closeTime !== boundaryFor(unit, now) || btcCandles[unit].slice(-200).some((b) => b.synthetic))) {
      throw new Error("BTC 시장 위험도를 판단할 최신 캔들이 부족합니다.");
    }
    const regime = deriveBtcRegime(btcCandles["60"], btcCandles["240"]);
    // 대기 검사에서 새로 확인된 Buy도 일봉 전용 수집보다 먼저 심사한다.
    const queue = nextMarkets(markets, tickers, checked).sort((a, b) => Number(hasCurrentBuy(results.get(b.market))) - Number(hasCurrentBuy(results.get(a.market))));
    for (const market of queue) {
      if (budget <= 12 || prepared.length >= MARKET_BATCH || Date.now() - startedAt > 92000) break;
      if (detailAttempted.has(market.market)) continue;
      const previous = baseResult(market.market), buy = hasCurrentBuy(previous);
      if (!buy || !detailDue(previous)) continue;
      await prepareMarket(market);
    }
    // 거래대금 증가 감지는 내부에서 처리하고 유망 조건 확인에 필요한 일봉만 보충한다.
    const promisingQueue = nextMarkets(markets, tickers, new Map([...results.values()].map((r) => [r.market, r.promisingCheckedAt ?? 0])))
      .filter((m) => {
        const r = results.get(m.market);
        return r?.turnover?.ready && r.turnover.candleClose === boundaryFor(60, now)
          && (r.turnover.increasing || r.selection?.promising) && !hasCurrentBuy(r)
          && !(r.selection?.version === 2 && r.dailyQuality?.ready && r.selection.candleClose === boundaryFor(1440, now))
          && (r.promisingCheckedAt ?? 0) <= now - 60000;
      });
    for (const market of promisingQueue) {
      if (budget <= 0 || Date.now() - startedAt > 100000) break;
      const result = { ...baseResult(market.market) };
      let rateError;
      try {
        await collect(market.market, [1440], 3, false);
        const cache = await load(market.market);
        result.selection = dailySelection(cache[1440], now);
        result.dailyQuality = candleQuality(cache, 1440, now);
        result.promisingCheckedAt = now;
      } catch (error) {
        if (error instanceof UpbitApiError && [418, 429].includes(error.status)) rateError = error;
        console.warn("유망 일봉 자료 대기", market.market, error.message);
        // 실패한 종목도 뒤로 보내 다른 증가 종목을 먼저 확인한다. 다음 실행에 재시도한다.
        result.promisingCheckedAt = now;
      }
      results.set(market.market, result);
      const candlesJson = JSON.stringify(await load(market.market));
      await db.batch([
        db.prepare("INSERT INTO candle_cache VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET candles_json=excluded.candles_json").bind(market.market, candlesJson),
        db.prepare("INSERT INTO market_analysis VALUES (?, ?, ?, ?) ON CONFLICT(market) DO UPDATE SET checked_at=excluded.checked_at, result_json=excluded.result_json, candles_json=excluded.candles_json").bind(market.market, checked.get(market.market) ?? 0, JSON.stringify(result), candlesJson)
      ]);
      if (rateError) throw rateError;
    }
    tickers = await fetchKrwTickers();
    const tickerMap = new Map(tickers.map((t) => [t.market, t]));
    for (const result of results.values()) {
      const ticker = tickerMap.get(result.market);
      if (!ticker || !result.plans?.length) continue;
      const plans = result.plans.map((p) => advanceSavedPlan(p, [], ticker.tradePrice, now));
      if (JSON.stringify(plans) !== JSON.stringify(result.plans)) {
        result.plans = plans;
        await writeStoredPlans(db, result);
      }
    }
    const safeCodes = new Set(markets.filter(isAnalysisMarket).map((m) => m.market));
    const executionCodes = [.../* @__PURE__ */ new Set([
      ...prepared.map((p) => p.market.market),
      ...[...results.values()].filter((r) => safeCodes.has(r.market) && now - r.analyzedAt <= SIGNAL_FRESH_MS && (r.candidates.length > 0 || r.plans?.some((p) => p.candidate.entryStatus === "ready"))).map((r) => r.market)
    ])];
    const executions = await fetchExecutionQualities(executionCodes, ANALYSIS_NOTIONAL_KRW, Date.now());
    for (const { market, candles } of prepared) {
      const ticker = tickerMap.get(market.market);
      const execution = executions.get(market.market) ?? {
        spreadPct: Infinity,
        buySlippagePct: Infinity,
        sufficientDepth: false,
        tickSize: 1,
        tickSizeReferencePrice: 0
      };
      if (!ticker) continue;
      const previous = results.get(market.market);
      const trends = {
        "15": cachedTrends(candles, 15, previous?.trends?.["15"], now),
        "60": cachedTrends(candles, 60, previous?.trends?.["60"], now),
        "240": cachedTrends(candles, 240, previous?.trends?.["240"], now)
      };
      const input = {
        analysisAt: now,
        market,
        ticker,
        candles,
        execution,
        marketRegime: regime,
        includeCharts: options.includeCharts,
        btcChangeRate: tickerMap.get("KRW-BTC")?.signedChangeRate ?? 0,
        feeRate: ASSUMED_FEE_RATE,
        trends,
        liquidityQualified: highTurnover(previous, now)
      };
      const result = {
        market: market.market,
        analyzedAt: now,
        engineVersion: 5,
        entryGateVersion: 1,
        primaryCheckedAt: now,
        primaryCollection: previous?.primaryCollection,
        trackingCheckedAt: previous?.trackingCheckedAt,
        detailAttemptedAt: previous?.detailAttemptedAt,
        detailCollectionPending: previous?.detailCollectionPending,
        turnover: previous?.turnover,
        stAnalysis: stAnalysis(candles, now),
        primary: Object.fromEntries([15, 60].map((u) => [u, primaryTrend(candles[u], u, now, trends[u])])),
        trends,
        screen: previous?.screen,
        selection: dailySelection(candles["1440"], now),
        dailyQuality: candleQuality(candles, 1440, now),
        dataQuality: recommendationQuality(candles, "scalp", now),
        complete: upperStructure(candles, now, trends).ready && recommendationQuality(candles, "swing", now).ready,
        candidates: [],
        plans: [],
        legacy: [],
        observations: []
      };
      for (const strategy of ["scalp", "swing"]) {
        const previousPlan = previous?.plans?.find((p) => p.candidate.strategy === strategy) ?? (previous?.engineVersion === 3 && previous.candidates.find((c) => c.strategy === strategy) ? createSavedPlan(previous.candidates.find((c) => c.strategy === strategy)) : void 0);
        let saved = previousPlan ? advanceSavedPlan(previousPlan, candles[strategy === "scalp" ? "15" : "60"], ticker.tradePrice, now) : void 0;
        const evaluation = strategy === "scalp" ? evaluateScalp(input) : evaluateSwing(input);
        const assessed = applyDailySelection(evaluation.accepted ? evaluation.candidate : { score: 0, metrics: {}, reasons: [] }, result.selection, now);
        if (evaluation.accepted) {
          evaluation.candidate = { ...assessed, entryGate: result.primary[strategy === "scalp" ? 15 : 60], dataQuality: recommendationQuality(candles, strategy, now) };
        }
        const activity = activityRatio(candles["60"], ticker.quoteVolume24h);
        if (evaluation.accepted && activity !== null) {
          evaluation.candidate.metrics.activityRatio = activity;
          evaluation.candidate.score = Math.min(100, evaluation.candidate.score + (activity >= 1.5 ? 5 : activity >= 1.1 ? 2 : 0));
          evaluation.candidate.reasons.push(`24시간 거래대금 / 이전 3일 일평균 ${activity.toFixed(2)}배`);
        }
        if (evaluation.accepted && previous?.screen) {
          const screen = previous.screen;
          if (screen.average3d !== null) evaluation.candidate.metrics.averageTurnover3d = screen.average3d;
          if (screen.hourlyRatio !== null) evaluation.candidate.metrics.hourlyTurnoverRatio = screen.hourlyRatio;
          if (screen.increasing) evaluation.candidate.reasons.unshift("최근 3개 24시간 구간 거래대금 연속 증가");
          if (screen.burst) evaluation.candidate.reasons.unshift(`최근 1시간 거래대금 ${screen.hourlyRatio.toFixed(2)}배 급증`);
        }
        const threshold = strategy === "scalp" ? 70 : 72;
        const qualified = evaluation.accepted && evaluation.candidate.score >= threshold && input.liquidityQualified;
        const observation = makeObservation(input, strategy, evaluation, now);
        const upper = upperStructure(candles, now, trends);
        if (observation.code === "UPPER_TREND_WAIT") {
          observation.reason = upper.reason;
          observation.trendScore = upper.score;
        }
        if (qualified && canReplacePlan(saved, evaluation.candidate)) saved = advanceSavedPlan(createSavedPlan(evaluation.candidate, now), [], ticker.tradePrice, now);
        if (saved) {
          saved = describeSavedPlan(saved, qualified ? evaluation.candidate : void 0, observation.reason, now, SIGNAL_FRESH_MS);
          const candidate = {
            ...saved.candidate,
            entryGate: result.primary[strategy === "scalp" ? 15 : 60],
            rankingScore: qualified ? evaluation.candidate.score : 0,
            rankingAt: now,
            selectionVersion: 2,
            currentAssessment: assessed.currentAssessment,
            dataQuality: recommendationQuality(candles, strategy, now),
            currentPrice: ticker.tradePrice,
            charts: chartSet(input),
            plan: costedPlan(saved.candidate.plan, ASSUMED_FEE_RATE, execution.buySlippagePct)
          };
          if (candidate.entryStatus === "ready" && (candidate.plan.netReturns?.[0] ?? -1) <= 0) {
            candidate.entryStatus = "waiting";
            candidate.entryBlockReason = REASONS.NO_RESISTANCE_ROOM;
          }
          result.plans.push({ ...saved, candidate });
          if (candidate.entryStatus === "ready" && entryStillValid(candidate, ticker.tradePrice, now)) result.candidates.push(candidate);
          else result.observations.push({ ...observation, code: "SAVED_PLAN_WAITING", reason: candidate.entryBlockReason ?? REASONS.CURRENT_PRICE_OUTSIDE_ENTRY });
        } else result.observations.push(observation);
        if (ticker.quoteVolume24h >= ENTRY_VOLUME[strategy]) {
          const baseline = strategy === "scalp" ? evaluateScalp2(input) : evaluateSwing2(input);
          if (baseline.accepted && baseline.candidate.score >= threshold) result.legacy.push(baseline.candidate);
        }
      }
      // 구형 기록은 구형 규칙으로 마무리하고, 새 추천은 아래 최종 순위 확정 후 별도로 저장한다.
      await trackPaper(db, market.market, candles["15"], [], result.legacy, now);
      await writeMarket(db, result, candles);
      results.set(market.market, result);
    }
    return await publish(regime, executions);
  } catch (error) {
    const latest = await getLatestDashboard(db);
    if (latest) return cachedPayload(latest, now, error);
    throw error;
  } finally {
    await releaseCycle(db, token);
  }
}

// 한 종목 상세는 스캔과 직렬 실행하며 기존 추천 원장과 별도 캐시에 저장한다.
function tripleStochasticLatest(bars) {
  const sma = (values, length) => values.map((_, i) => simpleAverage(values.slice(0, i + 1), length));
  return [[5, 3, 3], [10, 6, 6], [20, 12, 12]].map(([length, smoothK, smoothD]) => {
    const raw = bars.map((b, i) => {
      if (i < length - 1) return null;
      const window = bars.slice(i - length + 1, i + 1);
      const high = Math.max(...window.map((c) => c.high)), low = Math.min(...window.map((c) => c.low));
      return high > low ? 100 * (b.close - low) / (high - low) : null;
    });
    const k = sma(raw, smoothK), d = sma(k, smoothD);
    return { k: k.at(-1) ?? null, d: d.at(-1) ?? null };
  });
}
function symbolDetailAnalysis(input, now) {
  const liquidityQualified = highTurnover({ turnover: turnoverClass(input.candles, now) }, now);
  const marketEligible = input.exclusionsReady === true && isAnalysisMarket(input.market);
  const risk = recommendationRisk({ stAnalysis: stAnalysis(input.candles, now) }, input.ticker, now);
  const daily = dailySelection(input.candles["1440"], now);
  const frames = {};
  for (const unit of [15, 60, 240, 1440]) {
    const bars = (input.candles[unit] ?? []).filter((c) => c.closeTime <= boundaryFor(unit, now));
    const trend = cachedTrends(input.candles, unit, input.trends?.[unit], now);
    const latest = bars.at(-1);
    const quality = candleQuality(input.candles, unit, now);
    const valid = quality.ready;
    const frame = { asOf: latest?.closeTime ?? 0, valid, quality, bars: bars.length,
      averages: movingAverageState(bars), rsi: lastValue(rsi(bars.map((c) => c.close), 14)),
      stochastic: tripleStochasticLatest(bars), supertrend: trend.atr10 !== null ? trend.stDirection : null,
      targetTrend: trend.ttDirection, plan: null, ready: false };
    if (unit === 1440) frame.selection = daily;
    if (unit === 15 || unit === 60) {
      const evaluate = unit === 15 ? evaluateScalp : evaluateSwing;
      const evaluated = evaluate({ ...input, analysisAt: now });
      const calculated = evaluate({ ...input, analysisOnly: true });
      frame.plan = calculated.accepted ? calculated.candidate.plan : null;
      frame.ready = valid && recommendationQuality(input.candles, unit === 15 ? "scalp" : "swing", now).ready && marketEligible && liquidityQualified && risk.ready && !risk.blocked && evaluated.accepted && validPricePlan(evaluated.candidate.plan)
        && evaluated.candidate.score + daily.bonus >= (unit === 15 ? 70 : 72);
      frame.reason = !valid ? "완료 봉 데이터 확인 대기" : input.exclusionsReady !== true ? "유의·거래지원 종료 정보 확인 대기"
        : !isAnalysisMarket(input.market) ? "추천 제외 종목" : !liquidityQualified ? REASONS.LOW_LIQUIDITY
        : !risk.ready ? "상위봉 과열 정보 확인 대기" : risk.blocked ? "상위봉 RSI·이평선 이격 과열"
        : frame.ready ? "현재 신규 진입 조건 충족" : REASONS[evaluated.code] ?? "신규 진입 조건 대기";
    }
    frames[unit] = frame;
  }
  return { market: input.market.market, koreanName: input.market.koreanName, generatedAt: now,
    currentPrice: input.ticker.tradePrice, currentPriceAt: input.ticker.timestamp, quoteVolume24h: input.ticker.quoteVolume24h,
    selection: daily, frames };
}
async function refreshSymbolDetail(db, market, now = Date.now()) {
  if (!/^KRW-[A-Z0-9]{1,20}$/.test(market)) throw new Error("종목 코드를 확인해 주세요.");
  const markets = await fetchKrwMarkets();
  const info = markets.find((m) => m.market === market);
  if (!info) throw new Error("업비트 원화마켓에서 찾을 수 없는 종목입니다.");
  const row = await db.prepare("SELECT payload_json FROM symbol_detail_cache WHERE market = ?").bind(market).first();
  const previous = row ? JSON.parse(row.payload_json) : {};
  const scanned = await readCandles(db, market) ?? {};
  let candles = { ...emptyCandles(), "1440": [], ...scanned };
  // 구형 상세 이력도 최초 공유 캐시 전환 시 보존한다. 이후에는 공유 캐시만 사용한다.
  if (!scanned.collection && previous.candles) for (const unit of [15, 60, 240, 1440]) {
    const merged = new Map();
    for (const b of [...previous.candles[unit] ?? [], ...candles[unit]]) {
      if (!b.synthetic || !merged.has(b.openTime)) merged.set(b.openTime, b);
    }
    candles[unit] = [...merged.values()].sort((a, b) => a.openTime - b.openTime).slice(-800);
  }
  await writeCandles(db, market, candles);
  let requests = 0;
  // 모든 시간대의 최신 봉을 먼저 확보하고 나서 과거 이력을 보충한다.
  for (let pass = 0; pass < 3 && requests < 8; pass++) for (const unit of [15, 60, 240, 1440]) {
    if (requests >= 8 || !candleUnitDue(candles, unit, now)) continue;
    requests++;
    candles = await refreshCandleUnit(market, unit, candles, now);
    await writeCandles(db, market, candles);
  }
  const tickers = await fetchKrwTickers();
  const ticker = tickers.find((t) => t.market === market);
  if (!ticker || now - ticker.timestamp > 180000) throw new Error("최신 시세 시각을 확인할 수 없습니다.");
  const execution = (await fetchExecutionQualities([market], ANALYSIS_NOTIONAL_KRW, Date.now())).get(market);
  if (!execution) throw new Error("가격 계산에 필요한 호가 정보를 받지 못했습니다.");
  const btc = await readCandles(db, "KRW-BTC");
  const regime = btc && [60, 240].every((u) => btc[u]?.at(-1)?.closeTime === boundaryFor(u, now))
    ? deriveBtcRegime(btc[60], btc[240]) : "RISK_OFF";
  // 상세 캐시를 처음 만들 때는 스캔의 누적 추세 상태도 재사용한다.
  const scanRow = await db.prepare("SELECT result_json FROM market_analysis WHERE market = ?").bind(market).first();
  const scanResult = scanRow ? JSON.parse(scanRow.result_json) : null;
  const trends = {};
  for (const unit of [15, 60, 240, 1440]) {
    const prior = previous.trends?.[unit] ?? scanResult?.trends?.[unit];
    trends[unit] = cachedTrends(candles, unit, prior, now);
  }
  const detail = symbolDetailAnalysis({ market: info, ticker, candles, trends, execution, marketRegime: regime,
    btcChangeRate: tickers.find((t) => t.market === "KRW-BTC")?.signedChangeRate ?? 0, feeRate: ASSUMED_FEE_RATE,
    exclusionsReady: markets.exclusionStatus?.ready === true, includeCharts: false }, now);
  detail.history = (await db.prepare("SELECT payload_json FROM paper_signals WHERE market = ? AND variant = ? AND status IN ('closed', 'unfilled', 'closing') ORDER BY json_extract(payload_json, '$.createdAt') DESC LIMIT 10")
    .bind(market, RECOMMENDATION_VERSION).all()).results.map((r) => JSON.parse(r.payload_json));
  await db.prepare("INSERT INTO symbol_detail_cache VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET payload_json=excluded.payload_json")
    .bind(market, JSON.stringify({ ...detail, candles, trends })).run();
  return detail;
}

// runtime/storage.ts
import { setTimeout as sleep } from "node:timers/promises";
var Statement = class _Statement {
  constructor(execute, sql, params = []) {
    this.execute = execute;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new _Statement(this.execute, this.sql, params);
  }
  async all() {
    return (await this.execute([this]))[0];
  }
  async first(column) {
    const row = (await this.all()).results[0];
    return row ? column ? row[column] : row : null;
  }
  async run() {
    return (await this.execute([this]))[0];
  }
};
function databaseAdapter(execute) {
  return {
    prepare: (sql) => new Statement(execute, sql),
    batch: (statements) => execute(statements)
  };
}
function remoteDatabase(config, transport = fetch, intervalMs = 350) {
  if (!/^[a-f0-9]{32}$/i.test(config.accountId) || !/^[a-f0-9-]{36}$/i.test(config.databaseId) || !config.token.trim()) {
    throw new Error("Cloudflare D1 연결 설정을 확인해 주세요.");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  let nextRequestAt = 0;
  let queue = Promise.resolve();
  return databaseAdapter((queries) => {
    const operation = queue.then(async () => {
      await sleep(Math.max(0, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + intervalMs;
      const batch = queries.map(({ sql, params }) => ({ sql, params }));
      const response = await transport(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(batch.length === 1 ? batch[0] : { batch }),
        signal: AbortSignal.timeout(3e4)
      });
      if (response.status === 429) {
        const retry = Number(response.headers.get("retry-after"));
        nextRequestAt = Date.now() + Math.max(60, Number.isFinite(retry) ? retry : 60) * 1e3;
      }
      if (!response.ok) throw new Error(`D1 연결 실패(HTTP ${response.status}). 토큰 권한·무료 사용량을 확인해 주세요.`);
      const data = await response.json();
      if (!data.success || !Array.isArray(data.result) || data.result.length !== queries.length || data.result.some((r) => !r.success)) {
        throw new Error(`D1 쿼리 실패(코드 ${data.errors?.[0]?.code ?? "unknown"}). 저장이 완료되지 않았습니다.`);
      }
      return data.result.map((r) => ({ ...r, results: r.results ?? [] }));
    });
    queue = operation.then(() => void 0, () => void 0);
    return operation;
  });
}
async function localDatabase(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA busy_timeout=5000");
  const db = databaseAdapter(async (queries) => {
    sqlite.exec("BEGIN");
    try {
      const results = queries.map((q) => {
        const statement = sqlite.prepare(q.sql);
        const results2 = statement.all(...q.params);
        return { results: results2, success: true };
      });
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  });
  return { db, close: () => sqlite.close() };
}

// runtime/engine.ts
var emit = (value) => process.stdout.write(`${JSON.stringify(value, (key, item) => key === "charts" ? void 0 : item)}
`);
var stopping = false;
var detailMarket = null;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  const local = process.env.QUANT_LOCAL_DB ? await localDatabase(process.env.QUANT_LOCAL_DB) : null;
  const db = local?.db ?? remoteDatabase({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? ""
  });
  const commands = createInterface({ input: process.stdin });
  commands.on("line", (line) => {
    try {
      const command = JSON.parse(line);
      if (command.type === "detail" && (command.market === null || /^KRW-[A-Z0-9]{1,20}$/.test(command.market))) detailMarket = command.market;
    } catch { /* 잘못된 입력은 기존 분석을 중단시키지 않는다. */ }
  });
  try {
    await ensureCycleSchema(db);
    const previous = await getDashboard(db);
    if (previous) emit({ type: "snapshot", payload: previous, restored: true });
    do {
      const started = Date.now();
      let detailAllowed = true;
      emit({ type: "started", at: started });
      try {
        const payload = await refreshDashboard(db, { includeCharts: false });
        emit({ type: "snapshot", payload });
        if (payload.error) {
          detailAllowed = false;
          emit({ type: "error", at: Date.now(), message: payload.error });
        } else if (payload.source === "cached") {
          emit({ type: "waiting", at: Date.now(), message: payload.stale ? "분석 잠금·실행 간격 대기 중입니다. 저장된 결과도 오래되어 신규 추천을 중단하고 다음 실행에서 다시 확인합니다." : "중복 분석 방지를 위해 다음 실행 시각을 기다리고 있습니다. 최신 저장 결과를 표시합니다." });
        } else if (payload.stale) {
          emit({ type: "error", at: Date.now(), message: "분석 결과의 최신성을 확인하지 못했습니다. 다음 실행에서 다시 확인합니다." });
        } else {
          emit({ type: "completed", at: Date.now(), generatedAt: payload.generatedAt });
        }
      } catch (error) {
        detailAllowed = false;
        emit({ type: "error", at: Date.now(), message: error instanceof Error ? error.message : "분석 실패" });
      }
      const selected = detailMarket;
      if (selected && detailAllowed && !stopping) {
        emit({ type: "detail_started", market: selected, at: Date.now() });
        try {
          const detail = await refreshSymbolDetail(db, selected);
          if (detailMarket === selected) emit({ type: "detail", payload: detail });
        } catch (error) {
          if (detailMarket === selected) emit({ type: "detail_error", market: selected, message: error instanceof Error ? error.message : "상세 분석 실패" });
        }
      }
      if (process.argv.includes("--once")) break;
      while (!stopping && Date.now() - started < 6e4) await sleep2(1e3);
    } while (!stopping);
  } finally {
    commands.close();
    local?.close();
  }
}
main().catch((error) => {
  emit({ type: "error", at: Date.now(), message: error instanceof Error ? error.message : "분석기 시작 실패" });
  process.exitCode = 1;
});
