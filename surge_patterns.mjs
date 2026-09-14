// 급등 이전 일봉의 공통 특징과 이미 상승한 이력을 계산해 실제 사례와 비교한다.
const DAY = 86400000;
const mean = xs => xs.reduce((a,b) => a+b, 0) / xs.length;
const pct = (a,b) => (a/b-1)*100;
const ma = (bars,n,offset=0) => mean(bars.slice(-n-offset,offset ? -offset : undefined).map(b=>b.close));
export const PATTERN_SCHEMA = 'daily-pre-surge-v2';
export const MIN_SIMILARITY = 70;

export function priorRise(bars, today = null) {
  let low = Infinity, maxRise = 0, peakAt = null;
  for (const b of bars.slice(-20)) {
    const rise = Math.max(pct(b.high,b.open), Number.isFinite(low) ? pct(b.high,low) : 0);
    if (rise > maxRise) {maxRise = rise; peakAt = b.openTime;}
    low = Math.min(low,b.low);
  }
  if (today) {
    const rise = Math.max(pct(today.high,today.open),pct(today.high,low));
    if (rise > maxRise) {maxRise = rise; peakAt = today.openTime;}
  }
  return {maxRise, peakAt, alreadyRisen: maxRise >= 30 - 1e-9};
}

export function preSurgeFeatures(input, cutoff) {
  const bars = input.filter(b=>b.closeTime<=cutoff).slice(-63);
  if (bars.length<63 || bars.at(-1).closeTime!==cutoff
      || bars.some((b,i)=> ![b.open,b.high,b.low,b.close,b.baseVolume].every(Number.isFinite)
        || Math.min(b.open,b.high,b.low,b.close)<=0 || b.baseVolume<0
        || b.high<Math.max(b.open,b.close,b.low) || b.low>Math.min(b.open,b.close)
        || b.closeTime-b.openTime!==DAY || i>0 && b.openTime!==bars[i-1].closeTime)) return null;
  const close=bars.at(-1).close, m7=ma(bars,7), m20=ma(bars,20), m60=ma(bars,60);
  const range=n=>pct(Math.max(...bars.slice(-n).map(b=>b.high)),Math.min(...bars.slice(-n).map(b=>b.low)));
  const v3=mean(bars.slice(-3).map(b=>b.baseVolume)), v5=mean(bars.slice(-5).map(b=>b.baseVolume));
  const baseline=mean(bars.slice(-25,-5).map(b=>b.baseVolume));
  if (baseline<=0 || v3<=0 || v5<=0) return null;
  // 단위가 다른 특징을 고정 척도로 나눠 네 범주를 같은 비중으로 비교한다.
  return {cutoff, groups: {
    price:[pct(close,m20)/10,pct(close,bars.at(-6).close)/15,pct(close,bars.at(-21).close)/20],
    averages:[pct(m7,m20)/8,pct(m20,m60)/20,pct(m7,ma(bars,7,3))/5,pct(m20,ma(bars,20,3))/3],
    range:[range(5)/15,range(20)/30],
    volume:[Math.log(v3/baseline)/Math.log(3),Math.log(v3/v5)/Math.log(2)]
  }};
}

export function matchSurgePattern(features, templates, asOf, market) {
  if (!features || features.cutoff>asOf) return {score:0,matches:[],available:0};
  const scored=templates.filter(t=>t.schema===PATTERN_SCHEMA && t.eventEnd<=asOf && t.market!==market)
    .map(t=>{
      const distances=Object.keys(features.groups).map(key=>Math.sqrt(mean(features.groups[key]
        .map((x,i)=>(x-t.features.groups[key][i])**2))));
      const score=100*Math.exp(-mean(distances));
      return {market:t.market,name:t.name,date:t.date,leadDays:t.leadDays,featureCutoff:t.features.cutoff,
        eventEnd:t.eventEnd,source:t.source,sourceHash:t.sourceHash,score};
    }).sort((a,b)=>b.score-a.score || a.market.localeCompare(b.market) || a.date.localeCompare(b.date));
  const distinct=new Map();
  for (const row of scored) if (!distinct.has(row.market)) distinct.set(row.market,row);
  const matches=[...distinct.values()].slice(0,3);
  return {score:matches.length===3 ? Math.round(mean(matches.map(m=>m.score))*10)/10 : 0,
    matches,available:distinct.size};
}
