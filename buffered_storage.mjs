// 분석 자료를 로컬 SQLite에 먼저 보존하고 D1 전송만 별도로 재시도한다.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBackup} from './r2_backup.mjs';
import {mergePerformance} from './recommendation_performance.mjs';

const DAY=86400000;
const TABLES=[
  {name:'radar_plans',key:'id',columns:['id','market','payload_json'],cost:2,definition:'id TEXT PRIMARY KEY, market TEXT NOT NULL, payload_json TEXT NOT NULL'},
  {name:'surge_beta_cohorts',key:'id',columns:['id','created_at','payload_json'],cost:3,definition:'id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL'},
  {name:'candle_cache',key:'market',columns:['market','candles_json'],cost:2,definition:'market TEXT PRIMARY KEY, candles_json TEXT NOT NULL'},
  {name:'radar_state',key:'market',columns:['market','payload_json'],cost:2,definition:'market TEXT PRIMARY KEY, payload_json TEXT NOT NULL'},
  {name:'radar_snapshot',key:'id',columns:['id','payload_json'],cost:1,definition:'id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL'}
];
const LEASE='CREATE TABLE IF NOT EXISTS scan_lease (id INTEGER PRIMARY KEY, until_ms INTEGER NOT NULL, token TEXT NOT NULL, last_run INTEGER NOT NULL)';
const first=(...values)=>{const valid=values.filter(v=>Number.isFinite(v)&&v>0);return valid.length?Math.min(...valid):null;};

export function mergePlanRows(saved,current){
  if(!saved)return current;if(!current)return saved;
  if(saved.plan?.id!==current.plan?.id)throw new Error('서로 다른 추천 원장은 합칠 수 없습니다.');
  const result=structuredClone(saved),a=saved.plan,b=current.plan,p=result.plan;
  if(saved.performance||current.performance)result.performance=mergePerformance(saved.performance,current.performance);
  result.firstShownAt=first(saved.firstShownAt,current.firstShownAt);
  p.createdAt=first(a.createdAt,b.createdAt);
  p.hits=[0,1,2].map(i=>Boolean(a.hits?.[i]||b.hits?.[i]));
  for(const key of ['stoppedAt','completedAt'])p[key]=first(a[key],b[key]);
  if(a.entryTracking||b.entryTracking){
    const x=a.entryTracking??{},y=b.entryTracking??{};
    p.entryTracking={...y,...x};
    for(const key of ['qualifiedAt','startedAt','enteredAt','firstTargetAt','reviewAt'])
      p.entryTracking[key]=first(x[key],y[key]);
    p.entryTracking.checkedThrough=Math.max(x.checkedThrough??0,y.checkedThrough??0);
    p.entryTracking.targetTimes=[0,1,2].map(i=>first(x.targetTimes?.[i],y.targetTimes?.[i]));
  }
  return result;
}

export function mergeCohort(saved,current){
  if(!current)return saved;
  if(saved.selectedAt!==current.selectedAt)return saved;
  const result=structuredClone(saved);
  for(const group of ['selected','controls'])for(const row of result[group]??[]){
    const other=current[group]?.find(r=>r.market===row.market&&r.entryPrice===row.entryPrice);
    if(!other)continue;
    row.preparationEndedAt=first(row.preparationEndedAt,other.preparationEndedAt);
    for(const [key,w] of Object.entries(row.windows??{})){
      const v=other.windows?.[key];if(!v)continue;
      w.high=Math.max(w.high,v.high);w.low=Math.min(w.low,v.low);
      w.hit30At=first(w.hit30At,v.hit30At);w.lastObservationAt=Math.max(w.lastObservationAt,v.lastObservationAt);
      if(v.returnAt&&(!w.returnAt||v.returnAt<w.returnAt)){w.returnAt=v.returnAt;w.returnPrice=v.returnPrice;}
      w.closed=Boolean(w.closed||v.closed);
    }
  }
  result.savedAt=Math.max(saved.savedAt??0,current.savedAt??0);return result;
}

export function bufferedDatabase({remote,file,adapter,clock=Date.now,emit=()=>{},dailyBudget=80000,r2=null,r2Transport}){
  mkdirSync(dirname(file),{recursive:true});
  const sqlite=new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  sqlite.exec("CREATE TABLE IF NOT EXISTS buffer_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS buffer_queue (table_name TEXT NOT NULL,row_key TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(table_name,row_key)); CREATE TABLE IF NOT EXISTS buffer_conflicts (id TEXT PRIMARY KEY,payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS buffer_sent (table_name TEXT NOT NULL,row_key TEXT NOT NULL,sent_at INTEGER NOT NULL,PRIMARY KEY(table_name,row_key));");
  const get=(key,fallback=null)=>{const row=sqlite.prepare('SELECT value FROM buffer_meta WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;};
  const set=(key,value)=>sqlite.prepare('INSERT INTO buffer_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  set('importing',false);
  let archive=null;
  sqlite.exec('CREATE TABLE IF NOT EXISTS buffer_versions (table_name TEXT NOT NULL,row_key TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(table_name,row_key));');
  for(const t of TABLES){
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${t.name} (${t.definition});`);
    const payload=t.columns.at(-1);
    for(const event of ['INSERT','UPDATE'])sqlite.exec(`CREATE TRIGGER IF NOT EXISTS buffer_${t.name}_${event} AFTER ${event} ON ${t.name}
      WHEN (SELECT value FROM buffer_meta WHERE key='importing')='false' ${event==='UPDATE'?`AND old.${payload} IS NOT new.${payload}`:''}
      BEGIN INSERT INTO buffer_queue VALUES ('${t.name}',CAST(new.${t.key} AS TEXT),1)
      ON CONFLICT(table_name,row_key) DO UPDATE SET revision=revision+1; END;`);
    for(const event of ['INSERT','UPDATE'])sqlite.exec(`CREATE TRIGGER IF NOT EXISTS version_${t.name}_${event} AFTER ${event} ON ${t.name}
      ${event==='UPDATE'?`WHEN old.${payload} IS NOT new.${payload}`:''}
      BEGIN INSERT INTO buffer_versions VALUES ('${t.name}',CAST(new.${t.key} AS TEXT),1)
      ON CONFLICT(table_name,row_key) DO UPDATE SET seq=seq+1; END;`);
    sqlite.exec(`INSERT OR IGNORE INTO buffer_versions SELECT '${t.name}',CAST(${t.key} AS TEXT),1 FROM ${t.name};`);
  }
  sqlite.exec(LEASE+"; INSERT OR IGNORE INTO scan_lease VALUES (1,0,'',0); CREATE INDEX IF NOT EXISTS surge_beta_created ON surge_beta_cohorts(created_at);");
  function transaction(fn){sqlite.exec('BEGIN IMMEDIATE');try{const result=fn();sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}
  const db=adapter(async queries=>{const results=transaction(()=>queries.map(q=>({success:true,results:sqlite.prepare(q.sql).all(...q.params)})));
    if(queries.some(q=>/^(INSERT|UPDATE)/i.test(q.sql)&&q.sql.includes('radar_plans')))archive?.notify();return results;});
  let busy=null,closed=false,bootstrapped=false,remoteSchema=false,lastClaim=0;
  const owner='buffer:'+randomUUID(),restoredPlans=new Map(),restoredCohorts=new Map();
  let status={mode:'local',reason:'로컬 복구본 확인',file,pending:0,historyRestored:get('hydrated',false)};
  function publish(extra={}){
    const day=Math.floor(clock()/DAY);
    status={...status,...extra,pending:sqlite.prepare('SELECT COUNT(*) AS n FROM buffer_queue').get().n,
      retryAt:get('retryAt',0),used:get('budgetDay')===day?get('budgetUsed',0):0,budget:dailyBudget,
      historyRestored:get('hydrated',false),r2:archive?.status()??{enabled:false}};
    emit({type:'storage',...status});return status;
  }
  async function request(queries,cost=0){
    if(clock()<get('retryAt',0)){const e=new Error('D1 전송 재시도 대기');e.retryAt=get('retryAt');throw e;}
    transaction(()=>{
      const day=Math.floor(clock()/DAY);
      if(get('budgetDay')!==day){set('budgetDay',day);set('budgetUsed',0);}
      const used=get('budgetUsed',0);
      if(used+cost>dailyBudget){const e=new Error('D1 하루 전송 예산 도달');e.retryAt=(day+1)*DAY+60000;throw e;}
      // 응답을 받기 전에 종료되거나 통신이 끊겨도 예약한 비용은 남긴다.
      set('budgetUsed',used+cost);
    });
    const chargedDay=Math.floor(clock()/DAY),result=await remote.batch(queries);
    if(cost){
      const actual=result.every(r=>Number.isFinite(r.meta?.rows_written))?result.reduce((sum,r)=>sum+r.meta.rows_written,0):cost;
      const stats=get('d1Usage',{}),dayKey=new Date(clock()).toISOString().slice(0,10);
      stats[dayKey]={writes:(stats[dayKey]?.writes??0)+actual,estimated:!!stats[dayKey]?.estimated||!result.every(r=>Number.isFinite(r.meta?.rows_written))};
      set('d1Usage',Object.fromEntries(Object.entries(stats).slice(-7)));
      transaction(()=>{
        const returnedDay=Math.floor(clock()/DAY);
        if(returnedDay!==chargedDay){if(get('budgetDay')!==returnedDay){set('budgetDay',returnedDay);set('budgetUsed',0);}set('budgetUsed',get('budgetUsed',0)+actual);}
        else if(get('budgetDay')===chargedDay)set('budgetUsed',Math.max(0,get('budgetUsed',0)+actual-cost));
      });
    }
    return result;
  }
  const prepared=(sql,params=[])=>remote.prepare(sql).bind(...params);
  function importRows(t,rows){
    transaction(()=>{
      set('importing',true);
      for(const incoming of rows){
        const key=incoming[t.key],local=sqlite.prepare(`SELECT * FROM ${t.name} WHERE ${t.key}=?`).get(key);
        let row=incoming,changed=false;
        if(local){
          if(t.name==='radar_plans'){
            row={...incoming,payload_json:JSON.stringify(mergePlanRows(JSON.parse(incoming.payload_json),JSON.parse(local.payload_json)))};
          }else if(t.name==='surge_beta_cohorts'){
            const saved=JSON.parse(incoming.payload_json),current=JSON.parse(local.payload_json);
            if(saved.selectedAt!==current.selectedAt)sqlite.prepare('INSERT OR IGNORE INTO buffer_conflicts VALUES (?,?)').run('cohort:'+current.id+':'+current.selectedAt,local.payload_json);
            row={...incoming,payload_json:JSON.stringify(mergeCohort(saved,current))};
          }else if(t.name==='radar_snapshot'&&Number(key)===2){
            const saved=JSON.parse(incoming.payload_json),current=JSON.parse(local.payload_json);
            if((current.generatedAt??0)>=(saved.generatedAt??0))continue;
          }else continue;
          changed=row.payload_json!==incoming.payload_json;
        }
        const cols=t.columns;
        sqlite.prepare(`INSERT INTO ${t.name} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')}) ON CONFLICT(${t.key}) DO UPDATE SET ${cols.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`).run(...cols.map(c=>row[c]));
        if(changed)sqlite.prepare('INSERT INTO buffer_queue VALUES (?,?,1) ON CONFLICT(table_name,row_key) DO UPDATE SET revision=revision+1').run(t.name,String(key));
        if(t.name==='radar_plans')restoredPlans.set(String(key),JSON.parse(row.payload_json));
        if(t.name==='surge_beta_cohorts')restoredCohorts.set(String(key),JSON.parse(row.payload_json));
      }
      set('importing',false);
    });
  }
  async function claim(){
    if(lastClaim&&clock()-lastClaim<60000)return true;
    const now=clock(),rows=await request([prepared('UPDATE scan_lease SET token=?,until_ms=?,last_run=? WHERE id=1 AND (token=? OR until_ms<=?) RETURNING token',[owner,now+180000,now,owner,now])],1);
    if(rows[0].results[0]?.token!==owner){bootstrapped=false;return false;}
    lastClaim=now;return true;
  }
  async function bootstrap(){
    if(!remoteSchema){
      await request([...TABLES.map(t=>prepared(`CREATE TABLE IF NOT EXISTS ${t.name} (${t.definition})`)),prepared(LEASE),prepared("INSERT OR IGNORE INTO scan_lease VALUES (1,0,'',0)"),prepared('CREATE INDEX IF NOT EXISTS surge_beta_created ON surge_beta_cohorts(created_at)')],100);
      remoteSchema=true;
    }
    if(!await claim()){publish({mode:'local',reason:'다른 실행의 D1 저장 완료 대기'});return false;}
    if(!bootstrapped){
      for(const t of TABLES){
        for(let offset=0;;offset+=10){
          if(!await claim())return false;
          const result=await request([prepared(`SELECT ${t.columns.join(',')} FROM ${t.name} ORDER BY ${t.key} LIMIT 10 OFFSET ?`,[offset])]);
          importRows(t,result[0].results);publish({mode:'local',reason:'D1 기존 기록 복원 중'});
          if(result[0].results.length<10)break;
        }
      }
      set('hydrated',true);bootstrapped=true;
    }
    return true;
  }
  async function runSync({bootstrapOnly=false}={}){
    try{
      if(clock()<get('retryAt',0)){publish({mode:'local'});return;}
      if(!await bootstrap())return;
      if(!bootstrapOnly){
        // 한 번에 최대 20행만 전송해 초기화 직후 밀린 자료가 한도를 다시 소진하지 않게 한다.
        let pending=sqlite.prepare("SELECT q.* FROM buffer_queue q LEFT JOIN buffer_sent s ON s.table_name=q.table_name AND s.row_key=q.row_key WHERE s.sent_at IS NULL OR q.table_name NOT IN ('candle_cache','radar_state','radar_snapshot','surge_beta_cohorts') OR s.sent_at<=? ORDER BY CASE q.table_name WHEN 'radar_plans' THEN 0 WHEN 'surge_beta_cohorts' THEN 1 ELSE 2 END, q.rowid LIMIT 20").all(clock()-900000);
        for(const t of TABLES.filter(t=>['radar_plans','surge_beta_cohorts'].includes(t.name))){
          const keys=pending.filter(p=>p.table_name===t.name).map(p=>p.row_key);
          if(keys.length){const result=await request([prepared(`SELECT ${t.columns.join(',')} FROM ${t.name} WHERE ${t.key} IN (${keys.map(()=>'?').join(',')})`,keys)]);importRows(t,result[0].results);}
        }
        pending=pending.map(p=>sqlite.prepare('SELECT * FROM buffer_queue WHERE table_name=? AND row_key=?').get(p.table_name,p.row_key)).filter(Boolean);
        const queries=[],sent=[];let cost=0;
        for(const p of pending){
          const t=TABLES.find(t=>t.name===p.table_name),row=sqlite.prepare(`SELECT * FROM ${t.name} WHERE ${t.key}=?`).get(p.row_key);
          if(!row)throw new Error('전송 대기 원본을 찾을 수 없습니다.');
          const payload=t.columns.at(-1);
          const timeKey=t.name==='radar_state'?'checkedAt':t.name==='radar_snapshot'?'generatedAt':null;
          let newer=timeKey?` AND COALESCE(json_extract(${t.name}.${payload},'$.${timeKey}'),0)<=COALESCE(json_extract(excluded.${payload},'$.${timeKey}'),0)`:'';
          const params=t.columns.map(c=>row[c]);
          if(t.name==='candle_cache'){
            const state=JSON.parse(sqlite.prepare('SELECT payload_json FROM radar_state WHERE market=?').get(row.market)?.payload_json??'{}');
            newer=" AND COALESCE((SELECT COALESCE(json_extract(payload_json,'$.storageSavedAt'),json_extract(payload_json,'$.checkedAt')) FROM radar_state WHERE market=?),0)<=?";
            params.push(row.market,state.storageSavedAt??state.checkedAt??0);
          }
          queries.push(prepared(`INSERT INTO ${t.name} (${t.columns.join(',')}) VALUES (${t.columns.map(()=>'?').join(',')}) ON CONFLICT(${t.key}) DO UPDATE SET ${payload}=excluded.${payload} WHERE ${t.name}.${payload} IS NOT excluded.${payload}${newer}`,params));
          sent.push({...p,seq:sqlite.prepare('SELECT seq FROM buffer_versions WHERE table_name=? AND row_key=?').get(p.table_name,p.row_key)?.seq??0,payload:row[payload]});cost+=t.cost;
        }
        if(queries.length){
          await request(queries,cost);
          if(archive){
            const verified=await request(sent.map(p=>{const t=TABLES.find(t=>t.name===p.table_name);return prepared(`SELECT ${t.columns.at(-1)} AS payload FROM ${t.name} WHERE ${t.key}=?`,[p.row_key]);}));
            archive.confirm(sent.filter((p,i)=>verified[i].results[0]?.payload===p.payload));
          }
          transaction(()=>{for(const p of sent){sqlite.prepare('DELETE FROM buffer_queue WHERE table_name=? AND row_key=? AND revision=?').run(p.table_name,p.row_key,p.revision);sqlite.prepare('INSERT INTO buffer_sent VALUES (?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET sent_at=excluded.sent_at').run(p.table_name,p.row_key,clock());}});
        }
      }
      set('retryAt',0);publish({mode:sqlite.prepare('SELECT COUNT(*) AS n FROM buffer_queue').get().n?'syncing':'cloud',reason:null,lastSyncAt:clock()});
    }catch(e){
      const retry=Number.isFinite(e.retryAt)&&e.retryAt>clock()?e.retryAt:clock()+60000;
      set('retryAt',retry);publish({mode:'local',reason:e.message});
    }
  }
  db.storageStatus=()=>({...status});
  function restoreBackup(t,incoming,at){
    const key=String(incoming[t.key]),local=sqlite.prepare(`SELECT * FROM ${t.name} WHERE ${t.key}=?`).get(incoming[t.key]);let row=incoming;
    if(local){
      if(t.name==='radar_plans')row={...incoming,payload_json:JSON.stringify(mergePlanRows(JSON.parse(incoming.payload_json),JSON.parse(local.payload_json)))};
      else if(t.name==='surge_beta_cohorts'){
        const a=JSON.parse(incoming.payload_json),b=JSON.parse(local.payload_json);
        if(a.selectedAt!==b.selectedAt)sqlite.prepare('INSERT OR IGNORE INTO buffer_conflicts VALUES (?,?)').run('cohort:'+b.id+':'+b.selectedAt,local.payload_json);
        row={...incoming,payload_json:JSON.stringify(mergeCohort(a,b))};
      }else {
        const stamp=t.name==='radar_state'?'checkedAt':t.name==='radar_snapshot'?'generatedAt':null;
        const existingTime=stamp?JSON.parse(local.payload_json)[stamp]??0:JSON.parse(sqlite.prepare('SELECT payload_json FROM radar_state WHERE market=?').get(key)?.payload_json??'{}').storageSavedAt??0;
        const newTime=stamp?JSON.parse(incoming.payload_json)[stamp]??0:at;
        if(existingTime>newTime||get('r2Restored:'+t.name+':'+key,0)>at)row=local;
      }
    }
    set('r2Restored:'+t.name+':'+key,Math.max(at,get('r2Restored:'+t.name+':'+key,0)));
    sqlite.prepare(`INSERT INTO ${t.name} (${t.columns.join(',')}) VALUES (${t.columns.map(()=>'?').join(',')}) ON CONFLICT(${t.key}) DO UPDATE SET ${t.columns.slice(1).map(c=>`${c}=excluded.${c}`).join(',')}`).run(...t.columns.map(c=>row[c]));
    sqlite.prepare('INSERT INTO buffer_queue VALUES (?,?,1) ON CONFLICT(table_name,row_key) DO UPDATE SET revision=revision+1').run(t.name,key);
    if(t.name==='radar_plans')restoredPlans.set(key,JSON.parse(row.payload_json));
    if(t.name==='surge_beta_cohorts')restoredCohorts.set(key,JSON.parse(row.payload_json));
  }
  if(r2)archive=createBackup({sqlite,get,set,transaction,tables:TABLES,restore:restoreBackup,clock,publish:()=>publish({d1Usage:get('d1Usage',{})}),config:r2,client:r2Transport});
  db.takeRestored=()=>{const result={plans:[...restoredPlans.values()],cohorts:[...restoredCohorts.values()]};restoredPlans.clear();restoredCohorts.clear();return result;};
  const sync=options=>{if(closed)return Promise.resolve();if(busy)return busy;busy=runSync(options).finally(()=>{busy=null;});return busy;};
  publish();
  return {db,sync,backup:()=>archive?.tick()??Promise.resolve(),status:()=>({...status}),async close(){closed=true;if(busy)await busy;await archive?.close();sqlite.close();}};
}
