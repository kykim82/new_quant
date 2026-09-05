// 업비트 공개 시세 API를 호출하고 분석 가능한 내부 데이터로 정규화한다
import type {
  Candle,
  CandleUnit,
  ExecutionQuality,
  MarketDefinition,
  MarketTicker,
  OrderbookSnapshot,
} from '@/lib/domain';
import { krwTickSize } from '@/lib/tick-size';
import { dueUnits, type CandleCache } from '@/lib/market-cycle';

const API_BASE = 'https://api.upbit.com/v1';
const BATCH_SIZE = 6;
const BATCH_DELAY_MS = 1_050;

interface UpbitMarketResponse {
  market: string;
  korean_name: string;
  english_name: string;
  market_event?: {
    warning?: boolean;
    caution?: Record<string, boolean>;
  };
}

interface UpbitTickerResponse {
  market: string;
  trade_price: number;
  signed_change_rate: number;
  acc_trade_price_24h: number;
  timestamp: number;
}

interface UpbitCandleResponse {
  market: string;
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
  unit: CandleUnit;
}

interface UpbitOrderbookResponse {
  market: string;
  timestamp: number;
  orderbook_units: Array<{
    ask_price: number;
    bid_price: number;
    ask_size: number;
    bid_size: number;
  }>;
}

interface UpbitInstrumentResponse {
  market: string;
  tick_size: number | string;
}

export class UpbitApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'UpbitApiError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (response.ok) return await response.json() as T;
  const text = await response.text();
  throw new UpbitApiError(`업비트 API ${response.status}: ${text.slice(0, 160)}`, response.status);
}

async function batchMap<T, R>(items: readonly T[], mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    const chunk = items.slice(index, index + BATCH_SIZE);
    results.push(...await Promise.all(chunk.map(mapper)));
    if (index + BATCH_SIZE < items.length) await delay(BATCH_DELAY_MS);
  }
  return results;
}

export async function fetchKrwMarkets(): Promise<MarketDefinition[]> {
  const response = await requestJson<UpbitMarketResponse[]>('/market/all?is_details=true');
  return response
    .filter((item) => item.market.startsWith('KRW-'))
    .map((item) => ({
      market: item.market,
      koreanName: item.korean_name,
      englishName: item.english_name,
      warned: Boolean(item.market_event?.warning) || Object.values(item.market_event?.caution ?? {}).some(Boolean),
    }));
}

export async function fetchKrwTickers(): Promise<MarketTicker[]> {
  const response = await requestJson<UpbitTickerResponse[]>('/ticker/all?quote_currencies=KRW');
  return response.map((item) => ({
    market: item.market,
    tradePrice: item.trade_price,
    signedChangeRate: item.signed_change_rate,
    quoteVolume24h: item.acc_trade_price_24h,
    timestamp: item.timestamp,
  }));
}

function boundaryFor(unit: CandleUnit, asOf: number): number {
  const width = unit * 60_000;
  return Math.floor(asOf / width) * width;
}

function parseUtc(value: string): number {
  return Date.parse(value.endsWith('Z') ? value : `${value}Z`);
}

function fillMissingCandles(candles: readonly Candle[], unit: CandleUnit): Candle[] {
  if (candles.length < 2) return [...candles];
  const width = unit * 60_000;
  const filled: Candle[] = [candles[0]];
  for (const current of candles.slice(1)) {
    const previous = filled.at(-1)!;
    let nextOpen = previous.openTime + width;
    let guard = 0;
    while (nextOpen < current.openTime && guard < 1_000) {
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
        synthetic: true,
      });
      nextOpen += width;
      guard += 1;
    }
    filled.push(current);
  }
  return filled;
}

function normalizeCandles(rows: readonly UpbitCandleResponse[], unit: CandleUnit, asOf: number): Candle[] {
  const boundary = boundaryFor(unit, asOf);
  const unique = new Map<number, Candle>();
  for (const row of rows) {
    const openTime = parseUtc(row.candle_date_time_utc);
    if (!Number.isFinite(openTime) || openTime >= boundary) continue;
    unique.set(openTime, {
      market: row.market,
      unit,
      openTime,
      closeTime: openTime + unit * 60_000,
      open: row.opening_price,
      high: row.high_price,
      low: row.low_price,
      close: row.trade_price,
      baseVolume: row.candle_acc_trade_volume,
      quoteVolume: row.candle_acc_trade_price,
      synthetic: false,
    });
  }
  const filled = fillMissingCandles([...unique.values()].sort((left, right) => left.openTime - right.openTime), unit);
  if (filled.length === 0) return filled;
  const width = unit * 60_000;
  let guard = 0;
  while (filled.at(-1)!.closeTime < boundary && guard < 1_000) {
    const previous = filled.at(-1)!;
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
      synthetic: true,
    });
    guard += 1;
  }
  return filled;
}

async function fetchCandlePage(
  market: string,
  unit: CandleUnit,
  to: number,
): Promise<UpbitCandleResponse[]> {
  const query = new URLSearchParams({
    market,
    to: new Date(to).toISOString(),
    count: '200',
  });
  return requestJson<UpbitCandleResponse[]>(`/candles/minutes/${unit}?${query}`);
}

async function fetchCandlePageSafely(
  market: string,
  unit: CandleUnit,
  to: number,
): Promise<UpbitCandleResponse[]> {
  try {
    return await fetchCandlePage(market, unit, to);
  } catch (error) {
    console.warn(`캔들 조회 실패: ${market} ${unit}분`, error);
    return [];
  }
}

export async function fetchCandlesForMarkets(
  markets: readonly string[],
  asOf: number,
): Promise<Map<string, Record<'15' | '60' | '240', Candle[]>>> {
  const firstPageTasks = markets.flatMap((market) => ([15, 60, 240] as const).map((unit) => ({ market, unit })));
  const firstPages = await batchMap(firstPageTasks, async ({ market, unit }) => ({
    market,
    unit,
    rows: await fetchCandlePageSafely(market, unit, boundaryFor(unit, asOf)),
  }));
  const older240Pages = await batchMap(
    firstPages.filter((page) => page.unit === 240 && page.rows.length > 0),
    async (page) => ({
      market: page.market,
      rows: await fetchCandlePageSafely(page.market, 240, parseUtc(page.rows.at(-1)!.candle_date_time_utc)),
    }),
  );
  const olderByMarket = new Map(older240Pages.map((page) => [page.market, page.rows]));
  const result = new Map<string, Record<'15' | '60' | '240', Candle[]>>();

  for (const market of markets) {
    const record = {} as Record<'15' | '60' | '240', Candle[]>;
    for (const unit of [15, 60, 240] as const) {
      const first = firstPages.find((page) => page.market === market && page.unit === unit)?.rows ?? [];
      const combined = unit === 240 ? [...(olderByMarket.get(market) ?? []), ...first] : first;
      record[String(unit) as '15' | '60' | '240'] = normalizeCandles(combined, unit, asOf);
    }
    result.set(market, record);
  }
  return result;
}

export async function updateCandleCache(market: string, cache: CandleCache, asOf: number): Promise<CandleCache> {
  const result = { ...cache };
  for (const unit of dueUnits(cache, asOf)) {
    const key = String(unit) as keyof CandleCache;
    const page = await fetchCandlePage(market, unit, boundaryFor(unit, asOf));
    await delay(150);
    const older = unit === 240 && cache['240'].length < 220 && page.length > 0
      ? await fetchCandlePage(market, 240, parseUtc(page.at(-1)!.candle_date_time_utc)) : [];
    if (older.length) await delay(150);
    const normalized = normalizeCandles([...older, ...page], unit, asOf);
    if (!normalized.length) { result[key] = []; continue; }
    const combined = new Map(cache[key].map(candle => [candle.openTime, candle]));
    for (const candle of normalized) combined.set(candle.openTime, candle);
    result[key] = [...combined.values()].sort((a, b) => a.openTime - b.openTime).slice(-(unit === 240 ? 400 : 200));
  }
  return result;
}

export async function fetchExecutionQualities(
  markets: readonly string[],
  notionalKrw: number,
  asOf: number,
): Promise<Map<string, ExecutionQuality>> {
  if (markets.length === 0) return new Map();
  const encodedMarkets = encodeURIComponent(markets.join(','));
  const [books, instruments] = await Promise.all([
    requestJson<UpbitOrderbookResponse[]>(`/orderbook?markets=${encodedMarkets}&level=0&count=30`),
    requestJson<UpbitInstrumentResponse[]>(`/orderbook/instruments?markets=${encodedMarkets}`),
  ]);
  const tickSizes = new Map(instruments.map((item) => {
    const parsed = Number(item.tick_size);
    return [item.market, Number.isFinite(parsed) && parsed > 0 ? parsed : undefined] as const;
  }));
  return new Map(books.map((book) => {
    const normalized: OrderbookSnapshot = {
      market: book.market,
      timestamp: book.timestamp,
      levels: book.orderbook_units.map((level) => ({
        askPrice: level.ask_price,
        bidPrice: level.bid_price,
        askSize: level.ask_size,
        bidSize: level.bid_size,
      })),
    };
    return [book.market, calculateExecutionQuality(normalized, notionalKrw, tickSizes.get(book.market), asOf)];
  }));
}

export function calculateExecutionQuality(
  book: OrderbookSnapshot,
  notionalKrw: number,
  instrumentTickSize: number | undefined,
  asOf: number,
): ExecutionQuality {
  const best = book.levels[0];
  if (!best || asOf - book.timestamp > 30_000) {
    return {
      spreadPct: Number.POSITIVE_INFINITY,
      buySlippagePct: Number.POSITIVE_INFINITY,
      sufficientDepth: false,
      tickSize: 1,
      tickSizeReferencePrice: 0,
    };
  }
  const midpoint = (best.askPrice + best.bidPrice) / 2;
  const spreadPct = midpoint <= 0 ? Number.POSITIVE_INFINITY : ((best.askPrice - best.bidPrice) / midpoint) * 100;
  let remaining = notionalKrw;
  let quantity = 0;
  let spent = 0;
  for (const level of book.levels) {
    const availableValue = level.askPrice * level.askSize;
    const value = Math.min(remaining, availableValue);
    quantity += value / level.askPrice;
    spent += value;
    remaining -= value;
    if (remaining <= 0.000001) break;
  }
  const sufficientDepth = remaining <= 0.000001 && quantity > 0;
  const averageBuy = sufficientDepth ? spent / quantity : Number.POSITIVE_INFINITY;
  const buySlippagePct = sufficientDepth ? ((averageBuy - best.askPrice) / best.askPrice) * 100 : Number.POSITIVE_INFINITY;
  return {
    spreadPct,
    buySlippagePct,
    sufficientDepth,
    tickSize: instrumentTickSize && instrumentTickSize > 0 ? instrumentTickSize : krwTickSize(best.askPrice),
    tickSizeReferencePrice: best.askPrice,
  };
}
