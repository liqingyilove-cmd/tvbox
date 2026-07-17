// TVBox Aggregator - No KV needed, uses Cache API
var CACHE_KEY = new Request('https://internal.cache/subscribe');

async function getCached() {
    var cache = caches.default;
    var r = await cache.match(CACHE_KEY);
    if (r) return await r.text();
    return null;
}

async function setCached(data) {
    var cache = caches.default;
    await cache.put(CACHE_KEY, new Response(data, {headers: {'Content-Type':'application/json','Cache-Control':'max-age=86400'}}));
}

var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>TVBox</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:sans-serif;background:#1a1a2e;color:#eee;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.c{background:#16213e;border-radius:16px;padding:30px;max-width:550px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.3)}h1{font-size:22px;color:#e94560;margin-bottom:6px}.s{color:#888;font-size:13px;margin-bottom:20px}button{width:100%;padding:14px;font-size:16px;background:#e94560;color:#fff;border:none;border-radius:8px;cursor:pointer;margin:10px 0}button:hover{background:#c73550}button:disabled{background:#555;cursor:not-allowed}#log{background:#0f0f23;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;max-height:300px;overflow-y:auto;margin:10px 0;white-space:pre-wrap;word-break:break-all;color:#aaa}.ok{color:#4ade80;font-weight:700}.err{color:#f87171}.inf{color:#818cf8}</style></head><body><div class="c"><h1>TVBox 源聚合器</h1><p class="s">搜索并聚合 GitHub 上的 TVBox 影视源</p><button id="b" onclick="go()">开始聚合任务</button><div id="log">就绪</div></div><script>async function go(){var b=document.getElementById("b"),l=document.getElementById("log");b.disabled=true;b.textContent="运行中...";l.textContent="";function a(m,c){l.innerHTML+="<span class=\\\""+(c||"")+"\\\">"+m+"</span><br>";l.scrollTop=9999}try{a("正在聚合，请等待30-60秒...","inf");var r=await fetch("/api/start-task");var d=await r.json();if(d.error)throw new Error(d.error);if(d.sites){a("成功! 共"+d.sites.length+"个站点","ok");a("订阅地址: /subscribe.json","ok")}else throw new Error("未知错误")}catch(e){a("错误:"+e.message,"err")}finally{b.disabled=false;b.textContent="开始聚合任务"}}</script></body></html>';

async function doAggregation(env) {
    var tk = env.GH_TOKEN;
    if (!tk) throw new Error("GH_TOKEN 未设置");
    var sr = await fetch('https://api.github.com/search/code?q=sites+spider+extension:json+tvbox', {headers: {'Accept':'application/vnd.github.v3+json','Authorization':'token '+tk,'User-Agent':'TVBox'}});
    if (!sr.ok) throw new Error('GitHub API ' + sr.status + (sr.status===403?' 限流或Token无效':''));
    var res = await sr.json();
    if (!res.items || !res.items.length) return {sites:[],lives:[],rules:[]};
    var urls = res.items.map(function(i) { return i.html_url.replace('github.com','raw.githubusercontent.com').replace('/blob/','/'); });
    var dl = await Promise.all(urls.map(function(u) { return fetch(u).then(function(r) { return r.json(); }).catch(function() { return null; }); }));
    var out = {sites:[],lives:[],rules:[]};
    var keys = new Set();
    dl.forEach(function(s) { if (s && s.sites) s.sites.forEach(function(x) { if (x && x.key && !keys.has(x.key)) { out.sites.push(x); keys.add(x.key); } }); });
    return out;
}

export default {
  async fetch(request, env, ctx) {
    var u = new URL(request.url);
    var p = u.pathname;
    
    if (p.indexOf('/api/start-task') >= 0) {
        try {
            var out = await doAggregation(env);
            var json = JSON.stringify(out);
            await setCached(json);
            return new Response(json, {headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        } catch(e) {
            return new Response(JSON.stringify({error: e.message}), {status:200, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        }
    }
    
    if (p.indexOf('/subscribe.json') >= 0) {
        var cached = await getCached();
        if (cached) return new Response(cached, {headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
        return new Response(JSON.stringify({sites:[],note:"请先运行聚合任务"}), {headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
    }
    
    return new Response(html, {headers: {'Content-Type':'text/html;charset=UTF-8'}});
  }
};
