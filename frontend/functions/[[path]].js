function jsonResponse(data, status) {
    status = status || 200;
    var headers = { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' };
    return new Response(JSON.stringify(data), { status: status, headers: headers });
}

var HTML_PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>TVBox 源聚合器</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.card{background:#16213e;border-radius:16px;padding:30px;max-width:550px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.3)}h1{font-size:22px;color:#e94560;margin-bottom:6px}.sub{color:#888;font-size:13px;margin-bottom:20px}button{width:100%;padding:14px;font-size:16px;background:#e94560;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px 0}button:hover{background:#c73550}button:disabled{background:#555;cursor:not-allowed}#log{background:#0f0f23;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;max-height:250px;overflow-y:auto;margin:10px 0;white-space:pre-wrap;word-break:break-all;color:#aaa}.success{color:#4ade80;font-weight:700}.error{color:#f87171}.info{color:#818cf8}</style></head><body><div class="card"><h1>TVBox 源聚合器</h1><p class="sub">搜索并聚合 GitHub 上的 TVBox 影视源</p><button id="startBtn" onclick="startTask()">开始聚合任务</button><div id="log">就绪。点击上方按钮开始聚合。</div></div><script>async function startTask(){var btn=document.getElementById("startBtn");var log=document.getElementById("log");btn.disabled=true;btn.textContent="正在运行...";log.textContent="";function addLog(msg,cls){log.innerHTML+="<span class=\\\""+(cls||"")+"\\\">"+msg+"</span>\\n";log.scrollTop=log.scrollHeight}try{addLog("正在启动...","info");var taskId="task-"+Date.now();var res=await fetch("/api/start-task?taskId="+taskId);var data=await res.json();if(!data.ok)throw new Error(data.error||"启动失败");addLog("任务已启动","info");var attempts=0;while(attempts<120){await new Promise(function(r){setTimeout(r,2000)});var sr=await fetch("/api/task-status?taskId="+taskId);var s=await sr.json();addLog(s.logs||"",s.status==="completed"?"success":s.status==="failed"?"error":"");if(s.status==="completed"){addLog("任务成功完成！","success");addLog("订阅地址: /subscribe.json","info");break}if(s.status==="failed"){addLog("任务失败: "+(s.error||"未知"),"error");break}attempts++}if(attempts>=120)addLog("超时","error")}catch(e){addLog("错误: "+e.message,"error")}finally{btn.disabled=false;btn.textContent="开始聚合任务"}}</script></body></html>';

async function runAggregation(taskId, env) {
    var logs = [];
    function log(msg) { logs.push('[' + new Date().toISOString() + '] ' + msg); }
    var taskState = { status: 'running', logs: '' };
    async function update() {
        taskState.logs = logs.join('\n');
        if (env.TVBOX_KV) try { await env.TVBOX_KV.put(taskId, JSON.stringify(taskState)); } catch(e) {}
    }
    try {
        log('开始聚合TVBox源');
        await update();
        var ghToken = env.GH_TOKEN;
        if (!ghToken) throw new Error("GH_TOKEN 未设置");
        log('从 GitHub 搜索TVBox源...');
        var searchUrl = 'https://api.github.com/search/code?q=sites+spider+extension:json+tvbox';
        var sr = await fetch(searchUrl, { headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': 'token ' + ghToken, 'User-Agent': 'TVBox' } });
        if (!sr.ok) throw new Error('GitHub API 返回 ' + sr.status + '. 可能限流或Token无效。');
        var result = await sr.json();
        if (!result.items || !result.items.length) { log("未找到源文件"); taskState.status = 'completed'; await update(); return; }
        var urls = result.items.map(function(i) { return i.html_url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/'); });
        log('发现 ' + urls.length + ' 个源，正在下载合并...');
        await update();
        var downloads = await Promise.all(urls.map(function(u) { return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; }); }));
        var out = { sites: [], lives: [], rules: [] };
        var keys = new Set();
        downloads.forEach(function(s) { if (s && s.sites) s.sites.forEach(function(site) { if (site && site.key && !keys.has(site.key)) { out.sites.push(site); keys.add(site.key); } }); });
        log('合并完成，共 ' + out.sites.length + ' 个站点');
        await update();
        if (!env.TVBOX_KV) throw new Error("TVBOX_KV 未绑定");
        await env.TVBOX_KV.put('latest_aggregated_result', JSON.stringify(out));
        log('写入KV成功！');
        taskState.status = 'completed';
        await update();
    } catch(e) {
        log('失败: ' + e.message);
        taskState.status = 'failed';
        taskState.error = e.message;
        await update();
    }
}

export async function onRequest(context) {
    var req = context.request;
    var env = context.env;
    var u = new URL(req.url);
    var p = u.pathname;
    
    try {
        if (p.endsWith('/api/start-task')) {
            var taskId = u.searchParams.get('taskId') || ('task-' + Date.now());
            context.waitUntil(runAggregation(taskId, env));
            return jsonResponse({ ok: true, taskId: taskId });
        }
        if (p.endsWith('/api/task-status')) {
            var tid = u.searchParams.get('taskId');
            if (!tid) return jsonResponse({ error: 'missing taskId' }, 400);
            if (!env.TVBOX_KV) return jsonResponse({ error: 'KV missing' }, 500);
            var raw = await env.TVBOX_KV.get(tid);
            if (!raw) return jsonResponse({ status: 'pending', logs: '初始化中...' });
            return jsonResponse(JSON.parse(raw));
        }
        if (p.endsWith('/subscribe.json')) {
            if (!env.TVBOX_KV) return jsonResponse({ note: 'KV missing' }, 500);
            var data = await env.TVBOX_KV.get('latest_aggregated_result');
            if (!data) return jsonResponse({ note: '未生成数据' }, 404);
            return new Response(data, { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
        }
    } catch(e) {
        return jsonResponse({ error: e.message }, 500);
    }
    return new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
