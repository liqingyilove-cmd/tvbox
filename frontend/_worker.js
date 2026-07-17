// TVBox Aggregator Worker - Fixed Version (No next())
// Handles all routes explicitly

function jsonResponse(data, status = 200) {
    const headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    return new Response(JSON.stringify(data, null, 2), { status, headers });
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TVBox 源聚合器</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;}
.card{background:#16213e;border-radius:16px;padding:30px;max-width:550px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);}
h1{font-size:22px;color:#e94560;margin-bottom:6px;}
.sub{color:#888;font-size:13px;margin-bottom:20px;}
button{width:100%;padding:14px;font-size:16px;background:#e94560;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px 0;transition:background 0.2s;}
button:hover{background:#c73550;}
button:disabled{background:#555;cursor:not-allowed;}
#log{background:#0f0f23;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;max-height:250px;overflow-y:auto;margin:10px 0;white-space:pre-wrap;word-break:break-all;color:#aaa;}
.success{color:#4ade80;font-weight:bold;}
.error{color:#f87171;}
.info{color:#818cf8;}
</style>
</head>
<body>
<div class="card">
<h1>📺 TVBox 源聚合器</h1>
<p class="sub">搜索并聚合 GitHub 上的 TVBox 影视源</p>
<button id="startBtn" onclick="startTask()">开始聚合任务</button>
<div id="log">就绪。点击上方按钮开始聚合。</div>
</div>
<script>
async function startTask(){
  const btn=document.getElementById('startBtn');
  const log=document.getElementById('log');
  btn.disabled=true;
  btn.textContent='正在运行...';
  log.textContent='';
  function addLog(msg,cls){log.innerHTML+=`<span class="${cls||''}">${msg}</span>\n`;log.scrollTop=log.scrollHeight;}
  try{
    addLog('正在启动聚合任务...','info');
    const res=await fetch('/api/start-task',{method:'POST'});
    const data=await res.json();
    if(!data.taskId) throw new Error('未获取到 taskId');
    addLog('任务已启动，ID: '+data.taskId,'info');
    let attempts=0;
    while(attempts<60){
      await new Promise(r=>setTimeout(r,2000));
      const statusRes=await fetch('/api/task-status?taskId='+data.taskId);
      const status=await statusRes.json();
      addLog(status.logs||'',status.status==='completed'?'success':status.status==='failed'?'error':'');
      if(status.status==='completed'){addLog('✅ 任务成功完成！','success');addLog('订阅地址: /subscribe.json','info');break;}
      if(status.status==='failed'){addLog('❌ 任务失败: '+(status.error||'未知错误'),'error');break;}
      attempts++;
    }
    if(attempts>=60) addLog('⚠️ 任务超时，请刷新页面重试','error');
  }catch(e){addLog('❌ 错误: '+e.message,'error');}
  finally{btn.disabled=false;btn.textContent='开始聚合任务';}
}
</script>
</body>
</html>`;

async function runAggregation(taskId, env) {
    const logs = [];
    const log = (message) => logs.push('[' + new Date().toISOString() + '] ' + message);
    let taskState = { status: 'running', logs: '' };
    const updateTaskState = async () => {
        taskState.logs = logs.join('\n');
        if (env.TVBOX_KV) {
            try { await env.TVBOX_KV.put(taskId, JSON.stringify(taskState)); } catch(e) { log('KV write error: ' + e.message); }
        }
    };
    try {
        log('任务开始: 聚合TVBox源');
        await updateTaskState();
        const ghToken = env.GH_TOKEN;
        if (!ghToken) throw new Error("配置错误: 未找到 GH_TOKEN 环境变量。请在 Cloudflare 项目设置 → 环境变量中添加 GH_TOKEN。");
        log('步骤 1/3: 正在从 GitHub 搜索...');
        const query = 'q=sites+spider+extension:json+tvbox';
        const searchUrl = 'https://api.github.com/search/code?' + query;
        const searchResponse = await fetch(searchUrl, {
            headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': 'token ' + ghToken, 'User-Agent': 'TVBox-Aggregator' }
        });
        if (!searchResponse.ok) throw new Error('GitHub API 搜索失败: ' + searchResponse.status + ' ' + searchResponse.statusText + '. Token可能无效或API限流.');
        const searchResult = await searchResponse.json();
        if (!searchResult.items || searchResult.items.length === 0) { log("警告: 未找到任何源文件。"); taskState.status = 'completed'; await updateTaskState(); return; }
        const sourceUrls = searchResult.items.map(item => item.html_url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/'));
        log('搜索完成，发现 ' + sourceUrls.length + ' 个潜在源。');
        await updateTaskState();
        log('步骤 2/3: 正在下载并合并...');
        const downloadPromises = sourceUrls.map(url => fetch(url).then(res => res.json()).catch(() => null));
        const downloadResults = await Promise.all(downloadPromises);
        const aggregatedJson = { "sites": [], "lives": [], "rules": [] };
        const siteKeys = new Set();
        for (const sourceJson of downloadResults) {
            if (sourceJson && Array.isArray(sourceJson.sites)) {
                sourceJson.sites.forEach(site => { if (site && site.key && !siteKeys.has(site.key)) { aggregatedJson.sites.push(site); siteKeys.add(site.key); } });
            }
        }
        log('合并完成。聚合站点数: ' + aggregatedJson.sites.length);
        await updateTaskState();
        log('步骤 3/3: 正在写入 KV...');
        if (!env.TVBOX_KV) throw new Error("配置错误: 未绑定 TVBOX_KV 命名空间。");
        await env.TVBOX_KV.put('latest_aggregated_result', JSON.stringify(aggregatedJson, null, 2));
        log('写入成功！任务完成！');
        taskState.status = 'completed';
        await updateTaskState();
    } catch (error) {
        log('任务失败: ' + error.message);
        taskState.status = 'failed';
        taskState.error = error.message;
        await updateTaskState();
    }
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    }

    try {
        if (pathname === '/api/start-task' && request.method === 'POST') {
            const taskId = 'task-' + Date.now();
            context.waitUntil(runAggregation(taskId, env));
            return jsonResponse({ message: '任务已启动，请稍后查询状态。', taskId: taskId });
        }
        if (pathname === '/api/task-status') {
            const taskId = url.searchParams.get('taskId');
            if (!taskId) return jsonResponse({ error: '缺少 taskId' }, 400);
            if (!env.TVBOX_KV) return jsonResponse({ error: 'KV 未绑定' }, 500);
            const taskStateJson = await env.TVBOX_KV.get(taskId);
            if (!taskStateJson) return jsonResponse({ status: 'pending', logs: '正在初始化...' });
            return jsonResponse(JSON.parse(taskStateJson));
        }
        if (pathname === '/subscribe.json') {
            if (!env.TVBOX_KV) return jsonResponse({ note: "KV 未绑定" }, 500);
            const latestResult = await env.TVBOX_KV.get('latest_aggregated_result');
            if (!latestResult) return jsonResponse({ note: "尚未生成聚合数据，请先启动聚合任务。" }, 404);
            return new Response(latestResult, { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
        }
    } catch (e) {
        return jsonResponse({ error: 'Server error: ' + e.message }, 500);
    }

    return new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
