// 저장된 급등 전 공통점을 집계하고 기존 기준의 새 사례 재현성을 먼저 기록한다.
import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const DAY=86400000,ROOT=new URL('./',import.meta.url);
export const SCHEMA='surge-common-daily-v1';
const finite=Number.isFinite;
const above=(v,n=0)=>finite(v)?v>n:null;
export const RULES=[
  ['ma20up','20일선 상승',f=>above(f.slopes?.[20])],
  ['ma7up','7일선 상승',f=>above(f.slopes?.[7])],
  ['close20','가격이 20일선 위',f=>above(f.distanceToMaPct?.[20])],
  ['close7','가격이 7일선 위',f=>above(f.distanceToMaPct?.[7])],
  ['ma7over20','7일선이 20일선 위',f=>finite(f.averages?.[7])&&finite(f.averages?.[20])?f.averages[7]>f.averages[20]:null],
  ['ma20under60','20일선은 아직 60일선 아래',f=>finite(f.averages?.[20])&&finite(f.averages?.[60])?f.averages[20]<f.averages[60]:null],
  ['ma100down','100일선은 아직 하락',f=>finite(f.slopes?.[100])?f.slopes[100]<0:null],
  ['ma200down','200일선은 아직 하락',f=>finite(f.slopes?.[200])?f.slopes[200]<0:null],
  ['volume3','최근 3일 평균 거래량이 평소보다 큼',f=>above(f.volume3dRatio,1)],
  ['turnover3','최근 3일 평균 거래대금이 평소보다 큼',f=>above(f.turnover3Ratio,1)],
  ['volumeConsecutive','거래량 3일 연속 증가',f=>typeof f.volumeIncreasing3==='boolean'?f.volumeIncreasing3:null],
  ['cross','최근 5봉에 이평선 상향 교차',f=>Array.isArray(f.crosses)?f.crosses.length>0:null],
];
export function describe(event,turnover3Ratio=null){
  const f=event.pre?.frames?.[1440],valid=f?.ready===true&&f.cutoff===event.dayStart&&f.latestClose===event.dayStart;
  return {id:event.date+':'+event.market,date:event.date,market:event.market,name:event.name,dayStart:event.dayStart,
    valid,values:Object.fromEntries(RULES.map(([id,,check])=>[id,valid?check({...f,turnover3Ratio}):null]))};
}
export function summarize(rows){
  return RULES.map(([id,label])=>{
    const known=rows.filter(r=>typeof r.values[id]==='boolean'),matched=known.filter(r=>r.values[id]);
    return {id,label,hits:matched.length,total:known.length,missing:rows.length-known.length,
      ratio:known.length?matched.length/known.length:null,
      matched:matched.map(r=>r.id),exceptions:known.filter(r=>!r.values[id]).map(r=>r.id)};
  });
}
export function evaluate(previous,rows){
  const novel=rows.filter(r=>r.date>previous.through&&!previous.caseIds.includes(r.id));
  const stats=summarize(novel);
  return {baselineThrough:previous.through,baselineCreatedAt:previous.createdAt,newCases:novel.length,
    beforeNewDays:novel.every(r=>previous.createdAt<=r.dayStart),
    features:previous.commonIds.map(id=>{
      const old=previous.features.find(f=>f.id===id),current=stats.find(f=>f.id===id);
      return {...current,previousHits:old.hits,previousTotal:old.total,previousRatio:old.ratio};
    })};
}
export function readCases(root,through){
  const data=new URL('data/',root),rows=[],sources=[];
  const dates=readdirSync(data).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&d<=through).sort();
  if(!dates.includes(through))throw new Error('해당 완료 일자 수집이 없습니다. '+through);
  for(let i=0;i<dates.length;i++){
    if(i&&Date.parse(dates[i])-Date.parse(dates[i-1])!==DAY)throw new Error('중간 완료 일자 수집 공백입니다.');
    const date=dates[i],path=new URL(`${date}/index.json`,data),bytes=readFileSync(path),index=JSON.parse(bytes);
    if(index.date!==date||!index.final||!index.complete)throw new Error('완료 수집부터 확인해 주세요. '+date);
    sources.push({date,sha256:createHash('sha256').update(bytes).digest('hex')});
    const rawCache=new Map();
    for(const event of index.cases){
      if(event.date!==date||event.dayStart!==Date.parse(date+'T00:00:00Z')||!finite(event.open)||event.open<=0||!finite(event.high)||event.high/event.open<1.3)throw new Error('급등 원장 기준 불일치. '+date);
      if(!rawCache.has(event.evidence))rawCache.set(event.evidence,JSON.parse(readFileSync(new URL(`${date}/${event.evidence}`,data))));
      const raw=rawCache.get(event.evidence),bars=(raw.histories[event.market]?.[1440]?.rows??[])
        .filter(b=>Date.parse(b.candle_date_time_utc.replace(/Z$/,'')+'Z')+DAY<=event.dayStart)
        .sort((a,b)=>a.candle_date_time_utc.localeCompare(b.candle_date_time_utc));
      const avg=bs=>bs.reduce((s,b)=>s+b.candle_acc_trade_price,0)/bs.length;
      const base=bars.slice(-25,-5),tail=bars.slice(-3);
      const ratio=base.length===20&&tail.length===3&&[...base,...tail].every(b=>finite(b.candle_acc_trade_price)&&b.candle_acc_trade_price>=0)&&avg(base)>0?avg(tail)/avg(base):null;
      rows.push(describe(event,ratio));
    }
  }
  if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('같은 날짜·종목 중복입니다.');
  return {rows,sources};
}
const fmt=f=>f.total?`${f.hits}/${f.total} (${(100*f.ratio).toFixed(1)}%)`:'확인 자료 없음';
export function run({root=ROOT,through=new Date(Math.floor(Date.now()/DAY)*DAY-DAY).toISOString().slice(0,10),now=Date.now()}={}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(through)||Date.parse(through+'T00:00:00Z')+DAY>now)throw new Error('완료 일자만 집계합니다.');
  const {rows,sources}=readCases(root,through),out=new URL('common-history/',root);mkdirSync(out,{recursive:true});
  const target=new URL(`${through}.json`,out);
  if(existsSync(target)){
    const saved=JSON.parse(readFileSync(target));
    if(JSON.stringify(saved.sources)!==JSON.stringify(sources))throw new Error('기존 기준 이후 원장이 변경됐습니다. 과거 기준은 보존하고 변경 내용을 별도 검토해 주세요.');
    return saved;
  }
  const names=readdirSync(out).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  if(names.some(n=>n.slice(0,10)>through))throw new Error('최신 기준보다 과거로 되돌려 생성할 수 없습니다.');
  const previous=names.length?JSON.parse(readFileSync(new URL(names.at(-1),out))):null;
  if(previous&&previous.schema!==SCHEMA)throw new Error('기준 버전이 다릅니다. 별도 검토가 필요합니다.');
  if(previous&&JSON.stringify(previous.sources)!==JSON.stringify(sources.filter(s=>s.date<=previous.through)))throw new Error('이전 기준에 사용한 원장이 변경됐습니다. 과거 기준 보존 후 별도 검토가 필요합니다.');
  // 반드시 이전 기준으로 먼저 평가한 뒤 새 누적 기준을 만든다.
  const assessment=previous?evaluate(previous,rows):null;
  const features=summarize(rows),commonIds=features.filter(f=>f.total>=5&&f.ratio>=.7).map(f=>f.id);
  const record={schema:SCHEMA,through,createdAt:now,cases:rows.length,uniqueMarkets:new Set(rows.map(r=>r.market)).size,
    dailyReady:rows.filter(r=>r.valid).length,caseIds:rows.map(r=>r.id),sources,assessment,features,commonIds,
    commonDefinition:'자료 5건 이상, 해당 특징 70% 이상 반복된 항목을 잠정 공통점으로 표시. 매수 조건이나 급등 확률이 아님.'};
  const text=['# 급등 전 공통점 일일 비교', '',`집계 일봉 ${through}까지. ${rows.length}건·${record.uniqueMarkets}종목. 일봉 비교 가능 ${record.dailyReady}건.`,
    '', '급등 기준은 일봉 시가 대비 장중 고가 +30% 이상이며 종가·72시간 조건은 사용하지 않는다.',
    '일봉은 급등일 시작 이전 완료 봉만 사용한다. 기울기는 기존 연구의 3봉 차이다. 거래량·거래대금은 최근 3일 평균을 최근 5일을 제외한 직전 20일 평균과 비교한다.',
    '', '## 1. 기존 공통점의 새 사례 재현성', '',
    ...(assessment?[`기존 기준 ${assessment.baselineThrough}, 새 사례 ${assessment.newCases}건.`,
      assessment.beforeNewDays?'기준이 새 사례 일봉 시작 전에 확정됐다.':'일부 새 사례 일봉 시작 이후 기준을 확정했다. 엄격한 하루 전체 사전 검증과 구분한다.',
      '| 기존 공통점 | 이전 빈도 | 새 사례 재현 | 미확인 |','|---|---:|---:|---:|',
      ...assessment.features.map(f=>`| ${f.label} | ${f.previousHits}/${f.previousTotal} | ${fmt(f)} | ${f.missing} |`)]
      :['오늘 최초 기준표를 확정했다. 아직 새 사례에 대한 사전 확정 기준의 재현 결과는 없다.']),
    '', '## 2. 새 사례를 포함한 누적 공통점', '', record.commonDefinition,
    '| 특징 | 해당 / 확인 가능 | 미확인 | 잠정 공통점 |','|---|---:|---:|---|',
    ...features.slice().sort((a,b)=>(b.ratio??-1)-(a.ratio??-1)).map(f=>`| ${f.label} | ${fmt(f)} | ${f.missing} | ${commonIds.includes(f.id)?'예':'아니오'} |`),
    '', '## 해석과 예외', '',
    '위 비율은 이미 급등한 사례 안에서 특징이 반복된 정도다. 이 특징을 가진 현재 종목의 급등 확률은 아니다. 새 사례에서의 재현 빈도와 예외를 매일 누적한다.',
    '같은 종목의 다른 날짜 급등은 별도 사건이다. 이미 상승한 뒤 재급등한 사건도 포함돼 있으므로 이 전체 공통점을 미상승 후보의 필수 조건으로 그대로 쓰지 않는다.',
    '분봉은 첫 +30% 도달 직전 자료로 상승 시작 전과 다르고 공백도 있어 이번 일봉 기준표와 섞지 않았다. 기존 수집 자료는 그대로 보존한다.',
    ...features.filter(f=>commonIds.includes(f.id)).map(f=>`- ${f.label}의 예외. ${f.exceptions.join(', ')||'확인 가능한 사례에서는 없음'}.`),
    '', '기존 기준표는 덮어쓰지 않는다. 원장 보충으로 과거 자료가 바뀌면 자동 재작성하지 않고 검토한다. 운영 코드·추천 조건은 변경하지 않는다.',''];
  writeFileSync(target,JSON.stringify(record,null,2)+'\n',{flag:'wx'});
  writeFileSync(new URL(`${through}.md`,out),text.join('\n'),{flag:'wx'});
  return record;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{const r=run({through:process.argv[2]});console.log(JSON.stringify({through:r.through,cases:r.cases,dailyReady:r.dailyReady,assessment:r.assessment,features:r.features.map(({matched,exceptions,...f})=>f)},null,2));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
