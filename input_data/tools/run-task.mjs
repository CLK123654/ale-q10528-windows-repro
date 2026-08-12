import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';

const inputRoot=path.resolve(import.meta.dirname,'..');
const taskRoot=path.dirname(inputRoot);
const outputRoot=path.join(taskRoot,'output');
const reportRoot=path.join(outputRoot,'reports');
const sqlPath=path.join(outputRoot,'sql','rebuild_privacy_window.sql');
const sourceDb=path.join(inputRoot,'privacy_request.db');
const rulesPath=path.join(inputRoot,'retention_exceptions.json');
const windowPath=path.join(inputRoot,'window','deletion_window.json');
const resultDb=path.join(outputRoot,'privacy_window.db');
const decisionPath=path.join(outputRoot,'window_decision.json');
const sqliteBin=process.env.SQLITE_BIN||'sqlite3';

function clearBusinessOutputs(){for(const target of [resultDb,reportRoot,decisionPath])fs.rmSync(target,{recursive:true,force:true});}
function sqlite(database,sql,args=[]){const result=spawnSync(sqliteBin,[...args,database],{cwd:inputRoot,input:sql,encoding:'utf8',timeout:60000});if(result.error||result.status!==0)throw new Error(result.error?.message??result.stderr.trim()??'SQLite执行失败');return result.stdout;}
function rows(database,sql){const text=sqlite(database,sql,['-json']).trim();return text?JSON.parse(text):[];}
function csv(database,sql){return sqlite(database,sql,['-header','-csv']);}
function sameRows(left,right,table){return JSON.stringify(rows(left,`SELECT * FROM ${table} ORDER BY rowid`))===JSON.stringify(rows(right,`SELECT * FROM ${table} ORDER BY rowid`));}

clearBusinessOutputs();
try{
  for(const file of [sourceDb,rulesPath,windowPath,sqlPath])if(!fs.existsSync(file))throw new Error('缺少窗口输入或完成SQL '+path.relative(taskRoot,file));
  const rules=JSON.parse(fs.readFileSync(rulesPath,'utf8')),window=JSON.parse(fs.readFileSync(windowPath,'utf8'));
  if(!Array.isArray(rules.exceptions)||rules.exceptions.length<1||!rules.run_at)throw new Error('保留条款结构无效');
  if(!window.window_id||!window.scheduled_start_utc||!window.approver_role)throw new Error('删除窗口说明不完整');
  const sqlSource=fs.readFileSync(sqlPath,'utf8');if(/pending|请补全|\bTODO\b/i.test(sqlSource))throw new Error('交付SQL尚未完成');
  const version=spawnSync(sqliteBin,['--version'],{encoding:'utf8',timeout:10000});if(version.error||version.status!==0)throw new Error('找不到SQLite命令行程序');
  fs.mkdirSync(reportRoot,{recursive:true});fs.copyFileSync(sourceDb,resultDb);sqlite(resultDb,sqlSource);
  const sourceTables=['users','privacy_requests','devices','orders','messages','audit_events'];
  const sourceUnchanged=sourceTables.every(table=>sameRows(sourceDb,resultDb,table));
  const integrity=sqlite(resultDb,'PRAGMA integrity_check;').trim()==='ok'&&rows(resultDb,'PRAGMA foreign_key_check;').length===0;
  const scoped=Number(sqlite(resultDb,"SELECT NOT EXISTS(SELECT 1 FROM object_action a LEFT JOIN privacy_requests r USING(request_id) WHERE r.request_type<>'delete' OR r.status<>'open');").trim())===1;
  const legalHold=Number(sqlite(resultDb,"SELECT NOT EXISTS(SELECT 1 FROM object_action a JOIN retention_rule r ON r.rule_kind='legal_hold' AND r.user_id=a.user_id WHERE a.planned_action<>'retain_exception' OR a.exception_id<>r.exception_id);").trim())===1;
  const registerMatches=Number(sqlite(resultDb,"SELECT (SELECT count(*) FROM retention_register)=(SELECT count(*) FROM object_action WHERE planned_action='retain_exception') AND NOT EXISTS(SELECT request_id,user_id,object_type,object_id,exception_id FROM object_action WHERE planned_action='retain_exception' EXCEPT SELECT request_id,user_id,object_type,object_id,exception_id FROM retention_register);").trim())===1;
  const actionCsv=csv(resultDb,'SELECT request_id,user_id,object_type,object_id,object_created_at,object_state,planned_action,exception_id,action_rationale FROM object_action ORDER BY request_id,object_type,object_id;');
  const retentionCsv=csv(resultDb,'SELECT request_id,user_id,object_type,object_id,exception_id,retain_reason,retain_until FROM retention_register ORDER BY request_id,object_type,object_id;');
  fs.writeFileSync(path.join(reportRoot,'object_actions.csv'),actionCsv,'utf8');fs.writeFileSync(path.join(reportRoot,'retention_register.csv'),retentionCsv,'utf8');
  const totals=Object.fromEntries(rows(resultDb,'SELECT metric,value FROM window_summary ORDER BY metric').map(item=>[item.metric,Number(item.value)]));
  const issues=[];if(!sourceUnchanged)issues.push('SOURCE_SNAPSHOT_CHANGED');if(!integrity)issues.push('DATABASE_INTEGRITY');if(!scoped)issues.push('REQUEST_SCOPE');if(!legalHold)issues.push('LEGAL_HOLD_PRIORITY');if(!registerMatches)issues.push('RETENTION_REGISTER');
  const decision={window_id:window.window_id,decision:issues.length?'HOLD':'READY_FOR_APPROVAL',issues,scheduled_start_utc:window.scheduled_start_utc,approver_role:window.approver_role,rollback_contact:window.rollback_contact,rule_effective_date:rules.run_at,retention_rule_ids:rules.exceptions.map(item=>item.exception_id).sort(),totals,sqlite_version:version.stdout.trim()};
  fs.writeFileSync(decisionPath,JSON.stringify(decision,null,2)+'\n','utf8');if(issues.length)throw new Error('删除窗口材料未满足审批条件 '+issues.join(','));
  console.log('隐私删除窗口材料已生成');
}catch(error){clearBusinessOutputs();console.error(error instanceof Error?error.message:String(error));process.exit(1);}
