function jsonResponse(data, status) {
    status = status || 200;
    var headers = {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    return new Response(JSON.stringify(data, null, 2), { status: status, headers: headers });
}

var HTML_PAGE = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>TVBox 源聚合器</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box;}\nbody{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;}\n.card{background:#16213e;border-radius:16px;padding:30px;max-width:550px;width:100%%;box-shadow:0 8px 32px rgba(0,0,0,0.3);}\nh1{font-size:22px;color:#e94560;margin-bottom:6px;}\n.sub{color:#888;font-size:13px;margin-bottom:20px;}\nbutton{width:100%%;padding:14px;font-size:16px;background:#e94560;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px 0;transition:background 0.2s;}\nbutton:hover{background:#c73550;}\nbutton:disabled{background:#555;cursor:not-allowed;}\n#log{background:#0f0f23;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;max-height:250px;overflow-y:auto;margin:10px 0;white-space:pre-wrap;word-break:break-all;color:#aaa;}\n.success{color:#4ade80;font-weight:bold;}\n.error{color:#f87171;}\n.info{color:#818cf8;}\n</style>\n</head>\n<body>\n<div class="card">\n<h1>TVBox 源聚合器</h1>\n<p class="sub">搜索并聚合 GitHub 上的 TVBox 影视源</p>\n<button id="startBtn" onclick="startTask()">开始聚合任务</button>\n<div id="log">就绪。点击上方按钮开始聚合。</div>\n</div>\n<script>\nasync function startTask(){\n  var btn=document.getElementById("startBtn");\n  var log=document.getElementById("log");\n  btn.disabled=true;\n  btn.textContent="正在运行...";\n  log.textContent="";\n  function addLog(msg,cls){log.innerHTML+="<span class=\\""+(cls||"")+"\\">"+msg+"</span>\\n";log.scrollTop=log.scrollHeight;}\n  try{\n    addLog("正在启动聚合任务...","info");\n    var res=await fetch("/api/start-task",{method:"POST"});\n    var data=await res.json();\n    if(!data.taskId) throw new Error("未获取到 taskId");\n    addLog("任务已启动，ID: "+data.taskId,"info");\n    var attempts=0;\n    while(attempts<60){\n      await new Promise(function(r){setTimeout(r,2000);});\n      var statusRes=await fetch("/api/task-status?taskId="+data.taskId);\n      var status=await statusRes.json();\n      addLog(status.logs||"",status.status==="completed"?"success":status.status==="failed"?"error":"");\n      if(status.status==="completed"){addLog("任务成功完成！","success");addLog("订阅地址: /subscribe.json","info");break;}\n      if(status.status==="failed"){addLog("任务失败: "+(status.error||"未知错误"),"error");break;}\n      attempts++;\n    }\n    if(attempts>=60) addLog("任务超时，请刷新页面重试","error");\n  }catch(e){addLog("错误: "+e.message,"error");}\n  finally{btn.disabled=false;btn.textContent="开始聚合任务";}\n}\n</script>\n</body>\n</html>';

async function runAggregation(taskId, env) {
    var logs = [];
    function log(message) { logs.push('[' + new Date().toISOString() + '] ' + message); }
    var taskState = { status: 'running', logs: '' };
    async function updateTaskState() {
        taskState.logs = logs.join('\n');
        if (env.TVBOX_KV) {
            try { await env.TVBOX_KV.put(taskId, JSON.stringify(taskState)); } catch(e) { log('KV write error: ' + e.message); }
        }
    }
    try {
        log('任务开始: 聚合TVBox源');
        await updateTaskState();
        var ghToken = env.GH_TOKEN;
        if (!ghToken) throw new Error("GH_TOKEN 未设置");
        log('步骤 1/3: 正在从 GitHub 搜索...');
        var searchUrl = 'https://api.github.com/search/code?q=sites+spider+extension:json+tvbox';
        var searchResponse = await fetch(searchUrl, {
            headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': 'token ' + ghToken, 'User-Agent': 'TVBox-Aggregator' }
        });
        if (!searchResponse.ok) throw new Error('GitHub API 搜索失败: ' + searchResponse.status + '. Token可能无效或API限流。');
        var searchResult = await searchResponse.json();
        if (!searchResult.items || searchResult.items.length === 0) { log("未找到任何源文件。"); taskState.status = 'completed'; await updateTaskState(); return; }
        var sourceUrls = searchResult.items.map(function(item) { return item.html_url.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/'); });
        log('搜索完成，发现 ' + sourceUrls.length + ' 个潜在源。');
        await updateTaskState();
        log('步骤 2/3: 正在下载并合并...');
        var downloadPromises = sourceUrls.map(function(url) { return fetch(url).then(function(res) { return res.json(); }).catch(function() { return null; }); });
        var downloadResults = await Promise.all(downloadPromises);
        var aggregatedJson = { "sites": [], "lives": [], "rules": [] };
        var siteKeys = new Set();
        (downloadResults || []).forEach(function(sourceJson) {
            if (sourceJson && Array.isArray(sourceJson.sites)) {
                sourceJson.sites.forEach(function(site) { if (site && site.key && !siteKeys.has(site.key)) { aggregatedJson.sites.push(site); siteKeys.add(site.key); } });
            }
        });
        log('合并完成。聚合站点数: ' + aggregatedJson.sites.length);
        await updateTaskState();
        log('步骤 3/3: 正在写入 KV...');
        if (!env.TVBOX_KV) throw new Error("TVBOX_KV 未绑定");
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
    var request = context.request;
    var env = context.env;
    var url = new URL(request.url);
    var pathname = url.pathname;
    
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
    }
    
    try {
        if (pathname === '/api/start-task' && request.method === 'POST') {
            var taskId = 'task-' + Date.now();
            context.waitUntil(runAggregation(taskId, env));
            return jsonResponse({ message: '任务已启动', taskId: taskId });
        }
        if (pathname === '/api/task-status') {
            var taskId2 = url.searchParams.get('taskId');
            if (!taskId2) return jsonResponse({ error: '缺少 taskId' }, 400);
            if (!env.TVBOX_KV) return jsonResponse({ error: 'KV 未绑定' }, 500);
            var taskStateJson = await env.TVBOX_KV.get(taskId2);
            if (!taskStateJson) return jsonResponse({ status: 'pending', logs: '正在初始化...' });
            return jsonResponse(JSON.parse(taskStateJson));
        }
        if (pathname === '/subscribe.json') {
            if (!env.TVBOX_KV) return jsonResponse({ note: "KV 未绑定" }, 500);
            var latestResult = await env.TVBOX_KV.get('latest_aggregated_result');
            if (!latestResult) return jsonResponse({ note: "尚未生成聚合数据" }, 404);
            return new Response(latestResult, { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
        }
    } catch (e) {
        return jsonResponse({ error: 'Server error: ' + e.message }, 500);
    }
    
    return new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
