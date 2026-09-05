// 스프레드를 추천 점수나 탈락 조건이 아닌 갱신 가능한 주의 문구로 변환한다.
import type { Strategy } from './domain';

export function withSpreadWarning(warnings: readonly string[], strategy: Strategy, spreadPct: number): string[] {
  const retained = warnings.filter(warning => !warning.startsWith('호가 스프레드 '));
  const threshold = strategy === 'scalp' ? 0.2 : 0.35;
  if (Number.isFinite(spreadPct) && spreadPct > threshold) {
    retained.push(`호가 스프레드 ${spreadPct.toFixed(3)}% · 시장가 체결 주의. 후보 제외·점수 감점에는 사용하지 않습니다.`);
  }
  return retained;
}
