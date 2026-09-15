import type { DashboardSnapshot } from "./dashboard-model.ts";

export interface DashboardPageOptions {
	title?: string;
	runId: string;
	liveEndpoint?: string;
	snapshotUrl?: string;
	initialSnapshot?: DashboardSnapshot;
}

export function renderDashboardPage(options: DashboardPageOptions): string {
	const initial = options.initialSnapshot ? safeJson(options.initialSnapshot) : "null";
	const liveEndpoint = safeJson(options.liveEndpoint ?? null);
	const snapshotUrl = safeJson(options.snapshotUrl ?? null);
	const runId = safeJson(options.runId);
	const title = escapeHtml(options.title ?? "IPD 运行看板");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
:root{color-scheme:light;--bg:#fff;--panel:#fff;--panel2:#f8fafc;--line:#d8deea;--text:#172033;--muted:#687386;--accent:#1769e0;--ok:#159566;--warn:#b7791f;--bad:#d74747;--review:#7754d8;--shadow:0 10px 30px rgba(30,47,76,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);font:13px/1.5 Inter,"PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text)}a{color:inherit}.shell{max-width:1500px;margin:0 auto;padding:24px}.top{display:flex;gap:20px;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:800}.title{font-size:26px;font-weight:760;letter-spacing:-.02em;margin:3px 0}.sub{color:var(--muted);max-width:850px;word-break:break-all}.actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.btn{appearance:none;border:1px solid var(--line);background:var(--panel);color:var(--text);padding:8px 11px;border-radius:9px;text-decoration:none;cursor:pointer;font-weight:650;box-shadow:0 2px 8px rgba(31,48,78,.04)}.btn:hover{border-color:#9fb5da;background:#fbfdff}.live{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.live.on .dot{background:var(--ok);box-shadow:0 0 0 5px rgba(21,149,102,.09)}
.card{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:16px;min-width:0;box-shadow:0 5px 18px rgba(31,48,78,.04)}.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:14px;margin-top:14px}.section-title{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:11px}.section-title h2{font-size:14px;margin:0}.meta{color:var(--muted);font-size:11px}.list{margin:0;padding-left:18px}.list li{margin:5px 0}.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}.kv .k{color:var(--muted)}.tag{font-size:10px;padding:3px 7px;border-radius:999px;border:1px solid var(--line);background:#f2f5f9;color:#526078}.status{font-size:10px;font-weight:800;letter-spacing:.04em;padding:4px 8px;border-radius:999px;border:1px solid currentColor}.s-running,.s-active,.s-ready{color:var(--accent)}.s-succeeded{color:var(--ok)}.s-blocked,.s-failed,.s-cancelled{color:var(--bad)}.s-waiting_rework,.s-waiting_review{color:var(--warn)}.s-planned,.s-waiting{color:var(--muted)}
.stages{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:8px}.stage{border:1px solid var(--line);background:#fbfcfe;border-radius:10px;padding:10px 12px;color:var(--muted);min-height:57px}.stage b{display:block;font-size:12px}.stage small{font-size:10px;opacity:.85}.stage.done{border-color:rgba(21,149,102,.52);color:#0b7953;background:#f1fbf6}.stage.current{border-color:rgba(23,105,224,.82);color:#174f9c;background:#edf4ff;box-shadow:0 0 0 1px rgba(23,105,224,.1) inset}.stage.error{border-color:rgba(215,71,71,.75);color:var(--bad);background:#fff5f5}
.scroll-panel{overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.task-markdown{height:310px;padding:2px 8px 2px 0;font-size:11px;line-height:1.62;color:#26354d}.task-markdown h1,.task-markdown h2,.task-markdown h3,.task-markdown h4,.task-markdown h5,.task-markdown h6{margin:12px 0 6px;line-height:1.35;color:#172033}.task-markdown h1{font-size:16px}.task-markdown h2{font-size:14px}.task-markdown h3{font-size:12px}.task-markdown p{margin:6px 0}.task-markdown ul,.task-markdown ol{margin:6px 0;padding-left:22px}.task-markdown li{margin:3px 0}.task-markdown code{font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:#edf2f8;border:1px solid #dfe5ee;border-radius:4px;padding:1px 4px}.task-markdown pre{margin:8px 0;padding:10px;border-radius:8px;background:#f1f4f8;border:1px solid #dce3ed;overflow:auto}.task-markdown pre code{padding:0;border:0;background:none}.task-markdown blockquote{margin:8px 0;padding:5px 10px;border-left:3px solid #9fb5da;background:#f7f9fc;color:#526078}.selection-rationale{max-height:190px;margin-top:5px;padding:10px 12px;border:1px solid #e0e5ed;border-radius:9px;background:#f8fafc;white-space:pre-wrap;font-size:11px;line-height:1.65;color:#354259}.selection-details{margin-top:11px}.selection-details summary{cursor:pointer;color:#3f4d63;font-weight:700}.selection-details-body{max-height:220px;overflow:auto;margin-top:8px;padding:10px 12px;background:#f8fafc;border-radius:9px}
.workflow-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.metrics{display:flex;gap:8px;flex-wrap:wrap}.metric{background:#f8fafc;border:1px solid var(--line);border-radius:9px;padding:8px 10px;min-width:90px}.metric b{font-size:16px;display:block}.metric span{font-size:9px;color:var(--muted);letter-spacing:.07em}.graph-wrap{margin-top:12px;border:1px solid var(--line);border-radius:12px;background-color:#f7f9fc;background-image:radial-gradient(circle,#d3dae6 1px,transparent 1px);background-size:22px 22px;overflow:auto;min-height:360px}.graph-wrap svg{display:block}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:10px;margin-top:8px}.legend i{display:inline-block;width:16px;height:2px;vertical-align:middle;margin-right:5px;background:#66758b}.legend i.rework{height:0;border-top:2px dashed var(--bad);background:none}.graph-node{cursor:pointer}.graph-node rect{filter:drop-shadow(0 5px 8px rgba(36,52,79,.08))}.graph-node:hover rect,.graph-node.selected rect{filter:drop-shadow(0 7px 11px rgba(23,105,224,.18))}
.node-detail{margin-top:12px;display:none;padding:0;overflow:hidden}.node-detail.show{display:block}.detail-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:15px 17px;border-bottom:1px solid var(--line);background:#fbfcfe}.detail-head h2{font-size:18px;line-height:1.35;margin:3px 0}.detail-body{padding:16px}.detail-hero{padding:15px;border:1px solid #d8e3f3;background:linear-gradient(130deg,#edf4ff,#fbfcfe);border-radius:11px;margin-bottom:12px}.detail-hero.review{border-color:#ded4fb;background:linear-gradient(130deg,#f2eeff,#fbfaff)}.detail-hero .label{font-size:10px;color:#667891;font-weight:850;letter-spacing:.06em;margin-bottom:6px}.detail-hero .objective{font-size:14px;font-weight:700;line-height:1.65}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.detail-section{border:1px solid #dbe1eb;border-radius:11px;background:#fff;padding:13px;margin-top:12px}.detail-section h3{font-size:12px;margin:0 0 9px}.person-card{display:grid;grid-template-columns:40px 1fr;gap:10px;align-items:center;padding:11px;border-radius:10px;background:#f7f9fc}.avatar{width:40px;height:40px;display:grid;place-items:center;border-radius:11px;color:#fff;font-weight:850;background:linear-gradient(135deg,#276fd2,#63a0ef)}.avatar.review{background:linear-gradient(135deg,#6843ca,#9a80e7)}.person-card strong{display:block;font-size:12px}.person-card small{display:block;color:var(--muted);font-size:10px;margin-top:3px;overflow-wrap:anywhere}.pill-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.pill{display:inline-flex;padding:4px 7px;border-radius:7px;background:#edf2f8;color:#44536b;font-size:10px}.plain-list{list-style:none;padding:0;margin:0;display:grid;gap:7px}.plain-list li{position:relative;padding-left:19px;color:#354259;font-size:11px;line-height:1.58}.plain-list li:before{content:"✓";position:absolute;left:0;color:var(--ok);font-weight:900}.plain-list.boundary li:before{content:"—";color:#9099a8}.flow-list{display:grid;gap:7px}.flow-item{padding:9px 10px;border:1px solid #e0e5ed;border-radius:8px;background:#f8fafc;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.access{font-size:11px;line-height:1.7;color:#46536a}.empty{color:var(--muted);padding:22px;text-align:center}.events{max-height:390px;overflow:auto}.event{display:grid;grid-template-columns:78px 175px 1fr;gap:10px;padding:8px 0;border-top:1px solid #e1e6ee;align-items:start}.event:first-child{border-top:0}.event .seq{color:var(--muted);font-variant-numeric:tabular-nums}.event .type{font-weight:700}.event .data{color:#526078;word-break:break-word;font-size:11px}.errorbox{border:1px solid rgba(215,71,71,.4);background:#fff2f2;border-radius:9px;padding:10px;color:#a92f2f;margin-top:10px}.hidden{display:none!important}.foot{color:var(--muted);font-size:10px;margin:16px 2px}
@media(max-width:900px){.grid{grid-template-columns:1fr}.top{flex-direction:column}.actions{justify-content:flex-start}.stages{grid-template-columns:repeat(2,1fr)}.detail-grid{grid-template-columns:1fr}.event{grid-template-columns:60px 120px 1fr}.task-markdown{height:260px}}
</style>
</head>
<body>
<div class="shell">
  <div class="top"><div><div class="eyebrow">IPD 实时看板</div><div class="title">IPD 运行看板</div><div class="sub" id="run-subtitle">运行 ${escapeHtml(options.runId)}</div></div><div class="actions"><span class="live" id="live-indicator"><span class="dot"></span><span id="live-label">快照</span></span><button class="btn" id="refresh-btn">刷新</button><a class="btn hidden" id="snapshot-btn" href="#">下载当前快照</a></div></div>
  <div class="card"><div class="stages" id="stages"></div><div id="run-failure"></div></div>
  <div class="grid"><section class="card"><div class="section-title"><h2>用户任务</h2><span class="meta" id="task-meta"></span></div><div class="task-markdown scroll-panel" id="task-text">等待任务输入……</div><div id="task-detail"></div></section><section class="card"><div class="section-title"><h2>IPD Selection</h2><span id="selection-status"></span></div><div id="selection-body" class="empty">等待 IPD 完成流程选择……</div></section></div>
  <section class="card" style="margin-top:14px"><div class="workflow-head"><div><div class="section-title" style="margin:0"><h2>工作流设计与执行</h2></div><div class="meta" id="workflow-meta">等待工作流设计……</div></div><div class="metrics" id="workflow-metrics"></div></div><div class="graph-wrap" id="graph-wrap"><div class="empty">设计器创建节点后将在这里显示工作流。</div></div><div class="legend"><span><i></i>前向依赖</span><span><i class="rework"></i>评审返工路径</span><span>点击节点查看详情</span></div><div class="node-detail card" id="node-detail"></div></section>
  <section class="card" style="margin-top:14px"><div class="section-title"><h2>运行事件</h2><span class="meta" id="event-meta"></span></div><div class="events" id="events"><div class="empty">暂无事件。</div></div></section><div class="foot" id="generated-at"></div>
</div>
<script>
const RUN_ID=${runId};
const LIVE_ENDPOINT=${liveEndpoint};
const SNAPSHOT_URL=${snapshotUrl};
let currentData=${initial};
let selectedNodeId=null;
let selectionApplicabilityOpen=false;

const PHASES=[["intake","任务受理"],["selection","IPD 选择"],["design","工作流设计"],["compile","编译"],["execute","执行"],["closed","结束"]];
const PHASE_LABELS={intake:"任务受理",selection:"IPD 选择",design:"工作流设计",compile:"编译",execute:"执行",closed:"结束"};
const STATUS_LABELS={pending:"等待选择",running:"运行中",blocked:"已阻塞",succeeded:"已成功",failed:"已失败",cancelled:"已取消",planned:"待安排",waiting:"等待中",ready:"已就绪",active:"执行中",waiting_review:"等待评审",waiting_rework:"等待返工"};
const EVENT_LABELS={process_selected:"流程已选择",process_staffing_checked:"人员配置已检查",workflow_draft_validated:"工作流草稿已校验",workflow_designed:"工作流已设计",workflow_compiled:"工作流已编译",round_started:"工作轮次开始",round_submitted:"工作轮次已提交",review_recorded:"评审已记录",node_succeeded:"节点已完成",node_blocked:"节点已阻塞",run_succeeded:"运行已成功",run_failed:"运行已失败",run_cancelled:"运行已取消"};
const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>ch.charCodeAt(0)===38?"&amp;":ch.charCodeAt(0)===60?"&lt;":ch.charCodeAt(0)===62?"&gt;":ch.charCodeAt(0)===34?"&quot;":"&#39;");
const statusClass=value=>"status s-"+String(value||"planned").replace(/[^a-z_]/gi,"_").toLowerCase();
const statusLabel=value=>STATUS_LABELS[value]||String(value||"未知");
const phaseLabel=value=>PHASE_LABELS[value]||String(value||"未知");
const kindLabel=value=>value==="review"?"独立评审":"执行节点";

function inlineMarkdown(value){
  const codes=[];
  const tick=String.fromCharCode(96);
  let html=esc(value).replace(new RegExp(tick+"([^"+tick+"]+)"+tick,"g"),(_match,code)=>{const token="@@IPD_CODE_"+codes.length+"@@";codes.push("<code>"+code+"</code>");return token});
  html=html.replace(/[*][*]([^*]+)[*][*]/g,"<strong>$1</strong>").replace(/__([^_]+)__/g,"<strong>$1</strong>").replace(/[*]([^*]+)[*]/g,"<em>$1</em>");
  return html.replace(/@@IPD_CODE_([0-9]+)@@/g,(_match,index)=>codes[Number(index)]||"");
}

function markdownBlockStart(line,fence){
  return line.startsWith(fence)||/^(#{1,6})[ ]+/.test(line)||/^[ ]*[-*+][ ]+/.test(line)||/^[ ]*[0-9]+[.][ ]+/.test(line)||line.startsWith("> ")||/^[ ]*---+[ ]*$/.test(line);
}

function renderMarkdown(value){
  const newline=String.fromCharCode(10);
  const lines=String(value||"").replaceAll(String.fromCharCode(13),"").split(newline);
  const fence=String.fromCharCode(96,96,96);
  const blocks=[];
  let index=0;
  while(index<lines.length){
    const line=lines[index];
    if(!line.trim()){index++;continue}
    if(line.startsWith(fence)){
      const code=[];index++;
      while(index<lines.length&&!lines[index].startsWith(fence))code.push(lines[index++]);
      if(index<lines.length)index++;
      blocks.push('<pre><code>'+esc(code.join(newline))+'</code></pre>');continue;
    }
    const heading=/^(#{1,6})[ ]+(.*)$/.exec(line);
    if(heading){const level=heading[1].length;blocks.push("<h"+level+">"+inlineMarkdown(heading[2])+"</h"+level+">");index++;continue}
    if(/^[ ]*[-*+][ ]+/.test(line)){
      const items=[];
      while(index<lines.length&&/^[ ]*[-*+][ ]+/.test(lines[index]))items.push(lines[index++].replace(/^[ ]*[-*+][ ]+/,""));
      blocks.push("<ul>"+items.map(item=>"<li>"+inlineMarkdown(item)+"</li>").join("")+"</ul>");continue;
    }
    if(/^[ ]*[0-9]+[.][ ]+/.test(line)){
      const items=[];
      while(index<lines.length&&/^[ ]*[0-9]+[.][ ]+/.test(lines[index]))items.push(lines[index++].replace(/^[ ]*[0-9]+[.][ ]+/,""));
      blocks.push("<ol>"+items.map(item=>"<li>"+inlineMarkdown(item)+"</li>").join("")+"</ol>");continue;
    }
    if(line.startsWith("> ")){const quote=[];while(index<lines.length&&lines[index].startsWith("> "))quote.push(lines[index++].slice(2));blocks.push("<blockquote>"+quote.map(inlineMarkdown).join("<br>")+"</blockquote>");continue}
    if(/^[ ]*---+[ ]*$/.test(line)){blocks.push("<hr>");index++;continue}
    const paragraph=[line];index++;
    while(index<lines.length&&lines[index].trim()&&!markdownBlockStart(lines[index],fence))paragraph.push(lines[index++]);
    blocks.push("<p>"+paragraph.map(inlineMarkdown).join("<br>")+"</p>");
  }
  return blocks.join("");
}

function displayPhase(data){if(data.run.phase==="intake"&&!data.selection.processSpec&&data.run.status==="running")return"selection";return data.run.phase}
function render(data){currentData=data;renderHeader(data);renderStages(data);renderTask(data);renderSelection(data);renderWorkflow(data);renderEvents(data);document.getElementById("generated-at").textContent="页面更新于 "+new Date(data.generatedAt).toLocaleString("zh-CN")+" · 状态版本 "+data.run.revision}
function renderHeader(data){document.getElementById("run-subtitle").innerHTML="运行 <b>"+esc(data.run.id)+"</b> · 阶段 <b>"+esc(phaseLabel(displayPhase(data)))+"</b> · 状态 <b>"+esc(statusLabel(data.run.status))+"</b>";const live=Boolean(LIVE_ENDPOINT);document.getElementById("live-indicator").classList.toggle("on",live);document.getElementById("live-label").textContent=live?"实时刷新":"离线快照";const snap=document.getElementById("snapshot-btn");if(SNAPSHOT_URL){snap.href=SNAPSHOT_URL;snap.classList.remove("hidden")}else snap.classList.add("hidden")}
function renderStages(data){const phase=displayPhase(data),idx=Math.max(0,PHASES.findIndex(([id])=>id===phase));document.getElementById("stages").innerHTML=PHASES.map(([id,label],i)=>{let cls="stage";if(i<idx||(phase==="closed"&&i<=idx))cls+=" done";if(i===idx&&phase!=="closed")cls+=" current";if(i===idx&&["blocked","failed"].includes(data.run.status))cls+=" error";const note=id==="selection"?"流程规范":id==="design"?"设计器":id==="execute"?"执行与评审":"";return'<div class="'+cls+'"><b>'+esc(label)+'</b><small>'+esc(note)+'</small></div>'}).join("");document.getElementById("run-failure").innerHTML=data.run.failure?'<div class="errorbox"><b>'+esc(data.run.failure.code)+'</b><br>'+esc(data.run.failure.message)+'</div>':""}

function renderTask(data){
  const taskRoot=document.getElementById("task-text");
  const scrollTop=taskRoot.scrollTop;
  const task=data.task;
  if(!task){taskRoot.textContent="等待任务输入……";document.getElementById("task-meta").textContent="";return}
  taskRoot.innerHTML=renderMarkdown(task.text);
  taskRoot.scrollTop=scrollTop;
  document.getElementById("task-meta").textContent=task.materials.length+" 项材料 · "+task.unresolvedFacts.length+" 个待确认事项";
  const requirements=task.requirements.length?'<h3 style="font-size:11px">任务要求</h3><ul class="list">'+task.requirements.map(item=>'<li><span class="tag">'+esc(item.id)+'</span> '+esc(item.text)+'</li>').join("")+"</ul>":"";
  const facts=task.unresolvedFacts.length?'<h3 style="font-size:11px">待确认事项</h3><ul class="list">'+task.unresolvedFacts.map(item=>'<li><span class="tag">'+esc(item.id)+'</span> '+esc(item.description)+'</li>').join("")+"</ul>":"";
  document.getElementById("task-detail").innerHTML=requirements+facts;
}

function renderSelection(data){
  const selection=data.selection;
  document.getElementById("selection-status").innerHTML='<span class="'+statusClass(selection.status==="selected"?"succeeded":selection.status)+'">'+esc(selection.status==="selected"?"已选择":statusLabel(selection.status))+"</span>";
  const body=document.getElementById("selection-body");
  const previousDetails=document.getElementById("selection-applicability");
  if(previousDetails)selectionApplicabilityOpen=previousDetails.open;
  const previousRationale=document.getElementById("selection-rationale");
  const rationaleScrollTop=previousRationale?.scrollTop||0;
  if(selection.status!=="selected"||!selection.processSpec){body.className="empty";body.textContent=selection.status==="blocked"?"流程选择已阻塞，请查看失败信息和运行事件。":"IPD 正在检索并评估可用的流程规范。";return}
  body.className="";
  const process=selection.processSpec;
  body.innerHTML='<div style="font-size:16px;font-weight:750">'+esc(process.name)+'</div><div class="meta">'+esc(process.id)+" @ "+esc(process.version)+'</div><p style="font-size:11px">'+esc(process.description)+'</p><div class="kv"><div class="k">选择理由</div><div id="selection-rationale" class="selection-rationale scroll-panel">'+esc(selection.rationale||"")+'</div><div class="k">治理规模</div><div>'+process.requiredActivityCount+" 项活动 · "+process.requiredDeliverableCount+" 项交付 · "+process.requiredReviewCount+' 项评审</div></div><details class="selection-details" id="selection-applicability"><summary>IPD 评估的适用性</summary><div class="selection-details-body"><b>适用条件</b><ul class="list">'+process.applicableWhen.map(item=>"<li>"+esc(item)+"</li>").join("")+'</ul><b>不适用条件</b><ul class="list">'+process.notApplicableWhen.map(item=>"<li>"+esc(item)+"</li>").join("")+"</ul></div></details>";
  const details=document.getElementById("selection-applicability");
  details.open=selectionApplicabilityOpen;
  details.addEventListener("toggle",()=>{selectionApplicabilityOpen=details.open});
  document.getElementById("selection-rationale").scrollTop=rationaleScrollTop;
}

function metric(value,label){return'<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+"</span></div>"}
function renderWorkflow(data){const workflow=data.workflow;const sourceText=workflow.source==="compiled"?"已编译执行基线":workflow.source==="candidate"?"编译候选版本":workflow.source==="draft"?"设计草稿":"等待设计";const bits=[sourceText];if(workflow.name)bits.push(workflow.name);if(workflow.draftRevision!==undefined)bits.push("草稿版本 "+workflow.draftRevision);document.getElementById("workflow-meta").textContent=bits.join(" · ");const succeeded=workflow.nodes.filter(node=>node.status==="succeeded").length,active=workflow.nodes.filter(node=>node.status==="active").length;document.getElementById("workflow-metrics").innerHTML=metric(workflow.nodes.length,"节点")+metric(workflow.criteriaCount,"准出标准")+metric(workflow.coverageCount,"规范覆盖")+metric(succeeded+"/"+workflow.nodes.length,"已完成")+(active?metric(active,"执行中"):"");drawGraph(workflow.nodes,workflow.edges);if(selectedNodeId&&workflow.nodes.some(node=>node.id===selectedNodeId))renderNodeDetail(workflow.nodes.find(node=>node.id===selectedNodeId));else document.getElementById("node-detail").classList.remove("show")}

function drawGraph(nodes,edges){
  const wrap=document.getElementById("graph-wrap");
  if(!nodes.length){wrap.innerHTML='<div class="empty">设计器创建节点后将在这里显示工作流。</div>';return}
  const dependency=edges.filter(edge=>edge.kind==="dependency"),ids=new Set(nodes.map(node=>node.id)),indeg=new Map(nodes.map(node=>[node.id,0])),out=new Map(nodes.map(node=>[node.id,[]]));
  dependency.forEach(edge=>{if(ids.has(edge.from)&&ids.has(edge.to)){indeg.set(edge.to,(indeg.get(edge.to)||0)+1);out.get(edge.from).push(edge.to)}});
  const queue=nodes.filter(node=>indeg.get(node.id)===0).map(node=>node.id),layer=new Map(queue.map(id=>[id,0]));let queueIndex=0;
  while(queueIndex<queue.length){const id=queue[queueIndex++],base=layer.get(id)||0;for(const next of out.get(id)||[]){layer.set(next,Math.max(layer.get(next)||0,base+1));indeg.set(next,(indeg.get(next)||1)-1);if(indeg.get(next)===0)queue.push(next)}}
  nodes.forEach(node=>{if(!layer.has(node.id))layer.set(node.id,0)});
  const groups=new Map();nodes.forEach(node=>{const current=layer.get(node.id)||0;if(!groups.has(current))groups.set(current,[]);groups.get(current).push(node)});
  const box={w:250,h:90},gapX=85,gapY=46,pad=34,maxLayer=Math.max(...layer.values()),maxRows=Math.max(...[...groups.values()].map(group=>group.length));
  const width=pad*2+(maxLayer+1)*box.w+maxLayer*gapX,height=Math.max(330,pad*2+maxRows*box.h+(maxRows-1)*gapY),positions=new Map();
  [...groups.entries()].sort((a,b)=>a[0]-b[0]).forEach(([current,group])=>{const total=group.length*box.h+(group.length-1)*gapY;let y=(height-total)/2;group.forEach(node=>{positions.set(node.id,{x:pad+current*(box.w+gapX),y});y+=box.h+gapY})});
  const namespace="http://www.w3.org/2000/svg",svg=document.createElementNS(namespace,"svg");svg.setAttribute("width",width);svg.setAttribute("height",height);svg.setAttribute("viewBox","0 0 "+width+" "+height);
  const defs=document.createElementNS(namespace,"defs");defs.innerHTML='<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#66758b"/></marker><marker id="reworkArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d74747"/></marker>';svg.appendChild(defs);
  edges.forEach(edge=>{const start=positions.get(edge.from),end=positions.get(edge.to);if(!start||!end)return;const path=document.createElementNS(namespace,"path"),forward=edge.kind==="dependency",x1=forward?start.x+box.w:start.x+box.w/2,y1=forward?start.y+box.h/2:start.y+box.h,x2=forward?end.x:end.x+box.w/2,y2=forward?end.y+box.h/2:end.y+box.h,bend=forward?(x1+x2)/2:Math.max(start.y,end.y)+box.h+30;path.setAttribute("d",forward?("M "+x1+" "+y1+" C "+bend+" "+y1+", "+bend+" "+y2+", "+x2+" "+y2):("M "+x1+" "+y1+" C "+x1+" "+bend+", "+x2+" "+bend+", "+x2+" "+y2));path.setAttribute("fill","none");path.setAttribute("stroke",forward?"#66758b":"#d74747");path.setAttribute("stroke-width","1.6");if(!forward)path.setAttribute("stroke-dasharray","6 5");path.setAttribute("marker-end",forward?"url(#arrow)":"url(#reworkArrow)");svg.appendChild(path)});
  nodes.forEach(node=>{const position=positions.get(node.id),group=document.createElementNS(namespace,"g");group.setAttribute("class","graph-node"+(selectedNodeId===node.id?" selected":""));const rect=document.createElementNS(namespace,"rect");rect.setAttribute("x",position.x);rect.setAttribute("y",position.y);rect.setAttribute("width",box.w);rect.setAttribute("height",box.h);rect.setAttribute("rx","11");rect.setAttribute("fill",nodeFill(node.status,node.kind));rect.setAttribute("stroke",nodeStroke(node.status,node.kind));rect.setAttribute("stroke-width",selectedNodeId===node.id?"2.8":node.status==="active"?"2.4":"1.2");group.appendChild(rect);svgText(group,position.x+14,position.y+22,kindLabel(node.kind)+" · "+statusLabel(node.status),10,"#687386",700);svgText(group,position.x+14,position.y+45,short(node.name,30),14,"#172033",700);svgText(group,position.x+14,position.y+66,short(node.agent,34),11,"#596579",500);svgText(group,position.x+14,position.y+82,node.roundCount?"已执行 "+node.roundCount+" 轮":"尚未开始",9,"#7b8595",500);group.addEventListener("click",()=>{selectedNodeId=node.id;drawGraph(nodes,edges);renderNodeDetail(node)});svg.appendChild(group)});
  wrap.replaceChildren(svg);
}

function nodeFill(status,kind){if(status==="active")return"#eaf2ff";if(status==="succeeded")return"#e7f7ef";if(status==="blocked"||status==="failed")return"#fff0f0";if(status==="waiting_rework"||status==="waiting_review")return"#fff8e7";return kind==="review"?"#f5f1ff":"#ffffff"}
function nodeStroke(status,kind){if(status==="active")return"#6ea8fe";if(status==="succeeded")return"#55d187";if(status==="blocked"||status==="failed")return"#ff6b6b";if(status==="waiting_rework"||status==="waiting_review")return"#e5b454";return kind==="review"?"#8069bf":"#334257"}
function svgText(group,x,y,value,size,color,weight){const element=document.createElementNS("http://www.w3.org/2000/svg","text");element.setAttribute("x",x);element.setAttribute("y",y);element.setAttribute("font-size",size);element.setAttribute("font-family",'Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif');element.setAttribute("fill",color);element.setAttribute("font-weight",weight);element.textContent=value;group.appendChild(element)}
function short(value,length){const text=String(value||"");return text.length>length?text.slice(0,length-1)+"…":text}
function initials(value){const parts=String(value||"").replace(/｜.*$/g,"").split(/[ ]+/).filter(Boolean);return parts.map(part=>part[0]).join("").slice(0,2)||"IPD"}
function pills(items){if(!items?.length)return'<span class="meta">无额外配置</span>';return'<div class="pill-list">'+items.map(item=>'<span class="pill">'+esc(item)+"</span>").join("")+"</div>"}
function plainList(items,boundary=false){if(!items?.length)return'<div class="meta">无</div>';return'<ul class="plain-list'+(boundary?' boundary':'')+'">'+items.map(item=>"<li>"+esc(item)+"</li>").join("")+"</ul>"}
function flowList(items){if(!items?.length)return'<div class="meta">无</div>';return'<div class="flow-list">'+items.map(item=>'<div class="flow-item">'+esc(item)+"</div>").join("")+"</div>"}
function detailSection(title,content){return'<section class="detail-section"><h3>'+esc(title)+"</h3>"+content+"</section>"}

function renderNodeDetail(node){
  const box=document.getElementById("node-detail");if(!node){box.classList.remove("show");return}
  const activeRound=node.activeRoundId?'<span class="pill">当前轮次：'+esc(node.activeRoundId)+"</span>":"";
  const access='<div class="access"><b>读取范围：</b>'+esc(node.permissions.readPaths.join("、")||"无")+'<br><b>写入范围：</b>'+esc(node.permissions.writePaths.join("、")||"只读")+'<br><b>外部操作：</b>'+(node.permissions.externalActions?"允许":"不允许")+"</div>";
  box.classList.add("show");
  box.innerHTML='<div class="detail-head"><div><div class="eyebrow">'+esc(kindLabel(node.kind))+'</div><h2>'+esc(node.name)+'</h2><div class="meta">节点 '+esc(node.id)+" · 已执行 "+node.roundCount+' 轮</div></div><span class="'+statusClass(node.status)+'">'+esc(statusLabel(node.status))+'</span></div><div class="detail-body"><div class="detail-hero '+(node.kind==="review"?"review":"")+'"><div class="label">'+(node.kind==="review"?"这个质量门要判断什么":"这个节点要完成什么")+'</div><div class="objective">'+esc(node.objective)+'</div></div><div class="detail-grid"><div class="person-card"><div class="avatar '+(node.kind==="review"?"review":"")+'">'+esc(initials(node.agent))+'</div><div><strong>'+esc(node.agent)+'</strong><small>'+esc(node.requiredCapabilities.join(" · ")||"未声明专业能力")+'</small></div></div><div class="person-card"><div><strong>运行概况</strong><small>'+esc(statusLabel(node.status))+" · "+node.roundCount+' 个工作轮次</small><div class="pill-list">'+activeRound+'</div></div></div>'+detailSection("具体职责",plainList(node.responsibilities))+detailSection("工作要求与检查清单",plainList(node.workRequirements))+'<div class="detail-grid">'+detailSection("所需输入",flowList(node.inputs))+detailSection(node.kind==="review"?"评审对象":"交付输出",flowList(node.outputs))+'</div>'+detailSection("边界与限制",plainList(node.nonResponsibilities,true)+(node.constraints.length?'<div style="margin-top:11px" class="meta">必须遵守</div>'+plainList(node.constraints):""))+'<div class="detail-grid">'+detailSection("工具与专业方法",'<div class="meta">工具</div>'+pills(node.tools)+'<div class="meta" style="margin-top:10px">专业方法</div>'+pills(node.skills))+detailSection("文件与外部访问权限",access)+'</div></div>';
}

function renderEvents(data){document.getElementById("event-meta").textContent="最近 "+data.events.length+" 条事件";const root=document.getElementById("events");if(!data.events.length){root.innerHTML='<div class="empty">暂无事件。</div>';return}root.innerHTML=[...data.events].reverse().map(event=>'<div class="event"><div class="seq">#'+event.sequence+"<br>"+new Date(event.timestamp).toLocaleTimeString("zh-CN")+'</div><div class="type">'+esc(EVENT_LABELS[event.type]||event.type)+(event.nodeId?'<br><span class="tag">'+esc(event.nodeId)+"</span>":"")+'</div><div class="data">'+esc(JSON.stringify(event.data))+"</div></div>").join("")}
async function refresh(){if(!LIVE_ENDPOINT){if(currentData)render(currentData);return}try{const response=await fetch(LIVE_ENDPOINT,{cache:"no-store"});if(!response.ok)throw new Error(await response.text());render(await response.json())}catch(error){document.getElementById("generated-at").textContent="实时刷新失败："+String(error)}}
document.getElementById("refresh-btn").addEventListener("click",refresh);
if(currentData)render(currentData);
if(LIVE_ENDPOINT){refresh();setInterval(refresh,1200)}
</script>
</body>
</html>`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}
