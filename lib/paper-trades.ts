// 기존·개선 전략의 모의 진입과 분할 청산을 추적하며 봉 내 순서 불명확은 별도 분류한다
import type { Candle, Candidate, DashboardPayload } from './domain';

export interface PaperTrade {
  id: string; variant: 'legacy' | 'improved'; market: string;
  status: 'pending' | 'open' | 'closed' | 'expired' | 'ambiguous' | 'data_gap';
  createdAt: number; lastClose: number; entryExpires: number; holdUntil: number;
  entry: number; stop: number; targets: [number, number, number];
  filledAt?: number; sold: number; netPct: number; costRate: number;
}

export function newPaper(candidate: Candidate, variant: PaperTrade['variant'], now: number): PaperTrade {
  return { id: `${variant}:${candidate.market}:${candidate.strategy}:${candidate.signalTime}`,
    variant, market: candidate.market, status: 'pending', createdAt: now, lastClose: now,
    entryExpires: candidate.plan.expiresAt,
    holdUntil: now + (candidate.strategy === 'scalp' ? 6 : 72) * 3_600_000,
    entry: candidate.plan.entryAnchor, stop: candidate.plan.stop, targets: candidate.plan.targets,
    sold: 0, netPct: 0, costRate: 0.0005 + candidate.metrics.slippagePct / 100 };
}

function returnAt(trade: PaperTrade, price: number): number {
  return (price * (1 - trade.costRate) / (trade.entry * (1 + trade.costRate)) - 1) * 100;
}

export function advancePaper(original: PaperTrade, candles: Candle[], now: number): PaperTrade {
  const trade = { ...original };
  if (trade.status !== 'pending' && trade.status !== 'open') return trade;
  const bars = candles.filter(c => c.openTime >= trade.createdAt && c.closeTime > trade.lastClose && c.closeTime <= now);
  if (bars.length && bars[0].openTime > Math.ceil(trade.lastClose / 900_000) * 900_000) {
    trade.status = 'data_gap'; return trade;
  }
  for (const bar of bars) {
    if (bar.synthetic) { trade.status = 'data_gap'; return trade; }
    trade.lastClose = bar.closeTime;
    if (trade.status === 'pending') {
      if (bar.openTime >= trade.entryExpires) { trade.status = 'expired'; return trade; }
      if (bar.low <= trade.entry && bar.high >= trade.entry) {
        trade.status = 'open'; trade.filledAt = bar.openTime;
        // 진입 봉은 매수와 청산 가격 도달의 선후를 알 수 없다.
        if (bar.low <= trade.stop || bar.high >= trade.targets[0]) { trade.status = 'ambiguous'; return trade; }
      }
      continue;
    }
    const hitsStop = bar.low <= trade.stop;
    const hitsTarget = trade.sold < 3 && bar.high >= trade.targets[trade.sold];
    if (hitsStop && hitsTarget) { trade.status = 'ambiguous'; return trade; }
    if (hitsStop) {
      trade.netPct += returnAt(trade, Math.min(bar.open, trade.stop)) * (3 - trade.sold) / 3;
      trade.status = 'closed'; return trade;
    }
    while (trade.sold < 3 && bar.high >= trade.targets[trade.sold]) {
      trade.netPct += returnAt(trade, trade.targets[trade.sold]) / 3;
      trade.sold++;
    }
    if (trade.sold === 3) { trade.status = 'closed'; return trade; }
    if (bar.closeTime >= trade.holdUntil) {
      trade.netPct += returnAt(trade, bar.close) * (3 - trade.sold) / 3;
      trade.status = 'closed'; return trade;
    }
  }
  if (trade.status === 'pending' && now >= trade.entryExpires) trade.status = 'expired';
  return trade;
}

export async function trackPaper(db: D1Database, market: string, candles: Candle[], improved: Candidate[], legacy: Candidate[], now: number): Promise<void> {
  const rows = (await db.prepare("SELECT payload_json FROM paper_signals WHERE market = ? AND status IN ('pending', 'open')")
    .bind(market).all<{ payload_json: string }>()).results;
  const writes: D1PreparedStatement[] = [];
  for (const row of rows) {
    const original = JSON.parse(row.payload_json) as PaperTrade;
    const updated = advancePaper(original, candles, now);
    if (JSON.stringify(updated) !== row.payload_json) writes.push(db.prepare('UPDATE paper_signals SET status = ?, payload_json = ? WHERE id = ?')
      .bind(updated.status, JSON.stringify(updated), updated.id));
  }
  for (const [variant, candidates] of [['improved', improved], ['legacy', legacy]] as const) {
    for (const candidate of candidates) {
      const trade = newPaper(candidate, variant, now);
      writes.push(db.prepare('INSERT OR IGNORE INTO paper_signals VALUES (?, ?, ?, ?, ?)')
        .bind(trade.id, variant, market, trade.status, JSON.stringify(trade)));
    }
  }
  if (writes.length) await db.batch(writes);
}

export async function paperSummary(db: D1Database): Promise<DashboardPayload['paper']> {
  const rows = (await db.prepare(`SELECT variant, COUNT(*) AS total,
    SUM(status = 'pending') AS pending, SUM(status = 'open') AS open,
    SUM(status = 'closed') AS closed, SUM(status IN ('ambiguous', 'data_gap')) AS ambiguous,
    AVG(CASE WHEN status = 'closed' THEN json_extract(payload_json, '$.netPct') ELSE NULL END) AS meanNetPct
    FROM paper_signals GROUP BY variant`).all<NonNullable<DashboardPayload['paper']>[number]>()).results;
  return rows;
}
