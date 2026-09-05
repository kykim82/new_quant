// 분석 결과를 D1에 저장하고 가장 최근의 정상 결과를 조회한다
import type { DashboardPayload } from '@/lib/domain';

interface ScanRow {
  payload_json: string;
}

export async function getLatestDashboard(db: D1Database): Promise<DashboardPayload | null> {
  const row = await db
    .prepare('SELECT payload_json FROM scan_results ORDER BY generated_at DESC, id DESC LIMIT 1')
    .first<ScanRow>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as DashboardPayload;
  } catch {
    return null;
  }
}

export async function saveDashboard(db: D1Database, payload: DashboardPayload): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare(
      `INSERT INTO scan_results (generated_at, status, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(payload.generatedAt, payload.stale ? 'partial' : 'ok', JSON.stringify(payload), now),
    db.prepare(
      `DELETE FROM scan_results
       WHERE id NOT IN (SELECT id FROM scan_results ORDER BY generated_at DESC, id DESC LIMIT 96)`,
    ),
  ]);
}

