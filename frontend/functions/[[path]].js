function jsonResponse(data, status) {
    status = status || 200;
    var headers = { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' };
    return new Response(JSON.stringify(data), { status: status, headers: headers });
}

var HTML_PAGE = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>TVBox</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:#1a1a2e;color:#eee;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.c{background:#16213e;border-radius:16px;padding:30px;max-width:550px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.3)}h1{font-size:22px;color:#e94560;margin-bottom:6px}.s{color:#888;font-size:13px;margin-bottom:20px}button{width:100%;padding:14px;font-size:16px;background:#e94560;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px 0}button:hover{background:#c73550}button:disabled{background:#555;cursor:not-allowed}#log{background:#0f0f23;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;max-height:250px;overflow-y:auto;margin:10px 0;white-space:pre-wrap;word-break:break-all;color:#aaa}.ok{color:#4ade80;font-weight:700}.err{color:#f87171}.inf{color:#818cf8}</style></head><body><div class="c"><h1>TVBox 源聚合器</h1><p class="s">搜索并聚合 GitHub 上的 TVBox 影视源</p><button id="b" onclick="go()">开始聚合任务</button><div id="log">就绪</div></div><script>async function go(){var b=document.getElementById("b"),l=document.getElementById("log");b.disabled=true;b.textContent="运行中...";l.textContent="";function a(m,c){l.innerHTML+="<span class=\\""+(c||"")+"\\">"+m+"</span><br>";l.scrollTop=9999}try{a("启动中...","inf");var tid="t"+Date.now();var r=await fetch("/api/start-task?tid="+tid);var d=await r.json();if(!d.ok)throw new Error(d.error||"失败");a("已启动","inf");for(var i=0;i<120;i++){await new Promise(function(x){setTimeout(x,2000)});var sr=await fetch("/api/status?tid="+tid);var s=await sr.json();a(s.logs||"",s.status=="completed"?"ok":s.status=="failed"?"err":"");if(s.status=="completed"){a("成功！订阅地址: /subscribe.json","ok");break}if(s.status=="failed"){a("失败:"+(s.error||""),"err");break}}if(i>=120)a("超时","err")}catch(e){a("错误:"+e.message,"err")}finally{b.disabled=false;b.textContent="开始聚合任务"}}</script></body></html>';

async function runAggregation(tid, env) {
    var logs = [];
    function log(m) { logs.push('[' + new Date().toISOString() + '] ' + m); }
    var st = { status: 'running', logs: '' };
    async function upd() { st.logs = logs.join('\n'); if (env.TVBOX_KV) try { await env.TVBOX_KV.put(tid, JSON.stringify(st)); } catch(e) {} }
    try {
        log('开始聚合');
        await upd();
        var tk = env.GH_TOKEN;
        if (!tk) throw new Error("GH_TOKEN 未设置");
        log('搜索 GitHub...');
        var sr = await fetch('https://api.github.com/search/code?q=sites+spider+extension:json+tvbox', { headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': 'token ' + tk, 'User-Agent': 'TVBox' } });
        if (!sr.ok) throw new Error('GitHub API ' + sr.status);
        var res = await sr.json();
        if (!res.items || !res.items.length) { log("无源"); st.status = 'completed'; await upd(); return; }
        var urls = res.items.map(function(i) { return i.html_url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/'); });
        log('发现' + urls.length + '个源');
        await upd();
        log('下载合并中...');
        var dl = await Promise.all(urls.map(function(u) { return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; }); }));
        var out = { sites: [], lives: [], rules: [] };
        var keys = new Set();
        dl.forEach(function(s) { if (s && s.sites) s.sites.forEach(function(x) { if (x && x.key && !keys.has(x.key)) { out.sites.push(x); keys.add(x.key); } }); });
        log('合并完成:' + out.sites.length + '个站点');
        await upd();
        if (!env.TVBOX_KV) throw new Error("KV未绑定");
        await env.TVBOX_KV.put('latest_aggregated_result', JSON.stringify(out));
        log('完成!');
        st.status = 'completed';
        await upd();
    } catch(e) {
        log('失败:' + e.message);
        st.status = 'failed';
        st.error = e.message;
        await upd();
    }
}

export async function onRequest(context) {
    var req = context.request, env = context.env;
    var u = new URL(req.url), p = u.pathname;
    try {
        if (p.indexOf('/api/start-task') >= 0) {
            var tid = u.searchParams.get('tid') || ('t' + Date.now());
            context.waitUntil(runAggregation(tid, env));
            return jsonResponse({ ok: true, tid: tid });
        }
        if (p.indexOf('/api/status') >= 0) {
            var tid2 = u.searchParams.get('tid');
            if (!tid2) return jsonResponse({ error: 'no tid' }, 400);
            if (!env.TVBOX_KV) return jsonResponse({ error: 'no KV' }, 500);
            var raw = await env.TVBOX_KV.get(tid2);
            if (!raw) return jsonResponse({ status: 'pending', logs: '...' });
            return jsonResponse(JSON.parse(raw));
        }
        if (p.indexOf('/subscribe.json') >= 0) {
            if (!env.TVBOX_KV) return jsonResponse({ note: 'no KV' }, 500);
            var data = await env.TVBOX_KV.get('latest_aggregated_result');
            if (!data) return jsonResponse({ note: 'no data' }, 404);
            return new Response(data, { headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Access-Control-Allow-Origin': '*' } });
        }
    } catch(e) {
        return jsonResponse({ error: e.message }, 500);
    }
    return new Response(HTML_PAGE, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
