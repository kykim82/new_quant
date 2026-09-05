// 업비트 원화마켓의 가격 구간별 주문 호가 단위를 결정한다
export function krwTickSize(price: number): number {
  if (price >= 1_000_000) return 1_000;
  if (price >= 500_000) return 500;
  if (price >= 100_000) return 100;
  if (price >= 50_000) return 50;
  if (price >= 10_000) return 10;
  if (price >= 5_000) return 5;
  if (price >= 1_000) return 1;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 0.001;
  if (price >= 0.01) return 0.0001;
  if (price >= 0.001) return 0.00001;
  if (price >= 0.0001) return 0.000001;
  if (price >= 0.00001) return 0.0000001;
  return 0.00000001;
}

export function resolvedKrwTickSize(
  price: number,
  instrumentTickSize: number,
  referencePrice: number,
): number {
  const policyTick = krwTickSize(price);
  const referencePolicyTick = krwTickSize(referencePrice);
  return policyTick === referencePolicyTick
    && Number.isFinite(instrumentTickSize)
    && instrumentTickSize > 0
    ? instrumentTickSize
    : policyTick;
}
