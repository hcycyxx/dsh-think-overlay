/* dsh-think-overlay — 实时思考悬浮窗（纯 DOM 客户端插件）
 * 数据来源：DSH 页面里的思考行 DOM，不读磁盘会话日志、不用 PowerShell。
 * 英文思考自动翻成中文（宿主翻译服务优先，免 key 公共端点兜底）；安装即启用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-think-overlay',
  factory(require) {
    if (window.__dshThinkOverlay) return window.__dshThinkOverlay

    let React = null
    try { React = require('react') } catch (e) {}
    const h = React ? React.createElement : null

    const ID = 'dsh-think-overlay'
    const STYLE_ID = 'dsh-think-overlay-style'
    const CFG_KEY = 'dsh-think-overlay.cfg.v1'
    const CHANNEL = 'dsh-think-overlay'
    const MAX = 80

    const TOOL_MAP = {
      pwsh: '终端', bash: '终端', shell: '终端', run_code: '终端',
      read: '读文件', write: '写文件', edit: '改文件', glob: '找文件', grep: '搜索',
      skill: '读技能', subagent: '子任务', compress: '压缩上下文',
      web_search: '联网搜索', web_fetch: '抓网页', todo_write: '任务清单',
      present: '交付文件', visualize: '可视化', see_now: '看屏幕',
      ask_user: '问用户', send_message: '发消息', think: '思考',
      reasoning: '思考', search: '搜索', image: '看图', video: '视频'
    }
    const TOOL_KEYS = Object.keys(TOOL_MAP)
    function toolLabel(txt) {
      const s = String(txt || '').toLowerCase()
      for (let i = 0; i < TOOL_KEYS.length; i++) {
        if (s.indexOf(TOOL_KEYS[i]) !== -1) return TOOL_MAP[TOOL_KEYS[i]]
      }
      return ''
    }
    function nowHM() { return new Date().toTimeString().slice(0, 8) }
    function norm(t) { return String(t || '').replace(/\s+/g, ' ').trim() }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }
    function el(tag, cls, txt) {
      const n = document.createElement(tag)
      if (cls) n.className = cls
      if (txt != null) n.textContent = txt
      return n
    }

    function defaults() {
      return {
        w: 428, h: 380, x: -1, y: -1,
        opacity: 0.9, fontSize: 15,
        clickThrough: false, visible: true, paused: false,
        translate: true
      }
    }
    function loadCfg() {
      let c = defaults()
      try {
        const raw = localStorage.getItem(CFG_KEY)
        if (raw) c = Object.assign(c, JSON.parse(raw) || {})
      } catch (e) {}
      c.w = clamp(Number(c.w) || 428, 260, 1200)
      c.h = clamp(Number(c.h) || 380, 180, 900)
      c.opacity = clamp(Number(c.opacity) || 0.9, 0.2, 1)
      c.fontSize = clamp(Number(c.fontSize) || 15, 11, 26)
      if (c.x === -1 || c.y === -1 || c.x == null || c.y == null) {
        c.x = Math.max(12, window.innerWidth - c.w - 28)
        c.y = Math.max(12, window.innerHeight - c.h - 28)
      }
      return c
    }
    function saveCfg() {
      try { localStorage.setItem(CFG_KEY, JSON.stringify(state.cfg)) } catch (e) {}
    }

    const state = {
      cfg: defaults(), entries: [], seq: 0,
      seen: new Map(), rowMap: new WeakMap(),
      title: '', lastTool: '', pop: null, bc: null,
      scanTimer: null, clockTimer: null, pollTimer: null, observer: null,
      lastHref: '', els: {}, mounted: false
    }
    // 英译中：宿主 cotTranslation 服务优先，免 key 公共端点兜底；结果只影响显示，不改写原文去重键。
    const tstate = {
      cache: new Map(), timers: new Map(), queue: [], busy: false,
      ctx: null, pref: null, tmax: 900, fail: 0, warned: false,
      display: new Map()
    }
    // 流式吐字 + 绿灯跟速：主窗口是唯一打字机，逐字推进并把片段推给独立小窗。
    const TYPER_BASE = 52, TYPER_MAX = 620, TYPER_TICK = 33
    const DOT_IDLE_HZ = 1 / 3.4, DOT_ACTIVE_HZ = 1 / 0.55
    const typer = {
      disp: new Map(), timer: null, lastTs: 0, carry: 0, targetCps: 0,
      u: 0, phase: 0, rafTs: 0, raf: null, lastPulseBc: 0
    }
    const plugin = { name: ID, inject: ['slots'], api: null }

    /* ── 流式吐字 + 绿灯跟速 ─────────────────────────────── */
    // 主窗口是唯一打字机：每条记录维护「已吐出的字 / 目标全文」，逐字逼近，
    // 并把片段推给独立小窗（小窗不做打字机，直接显示 → 同样丝滑）。
    function dispRendered(id, fallback) {
      const d = typer.disp.get(id)
      return d ? d.rendered : (fallback == null ? '' : fallback)
    }
    function writeEntry(id, text) {
      const feed = state.els.feed
      if (feed) {
        const n = feed.querySelector('.dto-entry[data-id="' + id + '"] .dto-etext')
        if (n && n.textContent !== text) n.textContent = text
        // 只在不偏离底部时跟随，不打断用户手动上翻阅读
        if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60) feed.scrollTop = feed.scrollHeight
      }
      broadcast({ type: 'update', id, text })
    }
    function typerSet(id, target) {
      target = String(target == null ? '' : target)
      let d = typer.disp.get(id)
      if (!d) { d = { rendered: '', target: '' }; typer.disp.set(id, d) }
      if (d.target === target) return
      d.target = target
      // 流式增长（新文本以已吐出的字为前缀）→ 保留进度接着吐，不回退。
      // 整体替换（英译中 / 关翻译回退原文 / React 重写节点）→ 按最长公共前缀
      // 对齐，从第一个不同的字重新逐字吐，避免译文更短时整段 snap 或残留错字。
      let k = 0
      const lim = Math.min(d.rendered.length, target.length)
      while (k < lim && d.rendered[k] === target[k]) k++
      d.rendered = target.slice(0, k)
      writeEntry(id, d.rendered)
      typerStart()
    }
    function typerStart() {
      if (typer.timer) return
      typer.lastTs = 0; typer.carry = 0
      typer.timer = setInterval(typerTick, TYPER_TICK)
    }
    function typerStop() {
      if (typer.timer) { clearInterval(typer.timer); typer.timer = null }
      typer.targetCps = 0
    }
    function typerTick() {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
      let dt = typer.lastTs ? (now - typer.lastTs) / 1000 : TYPER_TICK / 1000
      typer.lastTs = now
      if (dt > 0.25) dt = 0.25   // 后台节流回来别一口气吐完
      const active = []
      let backlog = 0
      typer.disp.forEach((d, id) => {
        const need = d.target.length - d.rendered.length
        if (need > 0) { backlog += need; active.push({ id, d, need }) }
      })
      if (!active.length) { typerStop(); return }
      // 待吐的字越多吐得越快，上限避免大段文字糊成一片
      const rate = clamp(TYPER_BASE + backlog * 0.8, TYPER_BASE, TYPER_MAX)
      typer.targetCps = rate
      typer.carry += rate * dt
      const step = Math.floor(typer.carry)
      typer.carry -= step
      if (step <= 0) return
      const per = Math.max(1, Math.floor(step / active.length))
      active.forEach(({ id, d, need }) => {
        const n = Math.min(need, per)
        if (n <= 0) return
        d.rendered = d.target.slice(0, d.rendered.length + n)
        writeEntry(id, d.rendered)
      })
    }
    // 绿灯用「连续相位 + requestAnimationFrame」驱动，而不是改 animation-duration：
    // 改 duration 会让 CSS 动画相位重启、肉眼可见地跳一下。这里相位只累加不回退，
    // 频率 = 待机 0.29Hz ↔ 活跃 1.8Hz，随吐字速率平滑过渡，永远连贯。
    function pulseFrame(ts) {
      typer.raf = null
      let dt = typer.rafTs ? (ts - typer.rafTs) / 1000 : 0.016
      typer.rafTs = ts
      if (dt > 0.1) dt = 0.1   // 标签页后台回来别猛跳
      const goal = clamp(typer.targetCps / 300, 0, 1)
      typer.u += (goal - typer.u) * (goal > typer.u ? 0.18 : 0.045)  // 快升慢降
      if (typer.u < 0.002) typer.u = 0
      const hz = DOT_IDLE_HZ + (DOT_ACTIVE_HZ - DOT_IDLE_HZ) * typer.u
      typer.phase = (typer.phase + hz * dt) % 1
      const b = (1 - Math.cos(2 * Math.PI * typer.phase)) / 2   // 0→1→0 平滑呼吸
      const min = 0.62 - 0.34 * typer.u
      const sMin = 0.92 - 0.20 * typer.u
      const o = 1 - (1 - min) * b
      const sc = 1 - (1 - sMin) * b
      const root = state.els.root
      if (root) {
        root.style.setProperty('--dto-dot-o', o.toFixed(3))
        root.style.setProperty('--dto-dot-scale', sc.toFixed(3))
      }
      const now = Date.now()
      if (now - typer.lastPulseBc > 60) {   // ~16fps 足够让小窗也丝滑
        typer.lastPulseBc = now
        broadcast({ type: 'pulse', o: +o.toFixed(3), s: +sc.toFixed(3) })
      }
      if (state.mounted) startPulse()
    }
    function startPulse() {
      if (typer.raf != null || !state.mounted) return
      typer.rafTs = 0
      typer.raf = requestAnimationFrame(pulseFrame)
    }
    function stopPulse() {
      if (typer.raf != null) {
        try { cancelAnimationFrame(typer.raf) } catch (e) {}
        typer.raf = null
      }
    }

    /* ── 英译中 ─────────────────────────────────────────── */
    function isChinese(s) { return /[\u3400-\u9fff]/.test(s) }
    function needsTranslate(text) {
      if (!text || !state.cfg.translate) return false
      const letters = (text.match(/[A-Za-z]/g) || []).length
      if (!letters) return false
      const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
      return letters > cjk * 2
    }
    function shown(e) { return e.zh || e.text }
    function cleanZh(v, src) {
      const z = tidy(String(v == null ? '' : v))
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      if (!z || z === tidy(src) || !isChinese(z)) return null
      return z
    }
    function parseGoogle(data) {
      if (typeof data === 'string') return data
      if (!Array.isArray(data) || !data.length) return ''
      if (typeof data[0] === 'string') return data.join('')
      if (Array.isArray(data[0])) {
        let out = ''
        for (const seg of data[0]) {
          if (Array.isArray(seg) && typeof seg[0] === 'string') out += seg[0]
        }
        return out
      }
      return ''
    }
    function splitText(text, max) {
      const out = []
      let rest = text
      while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max)
        if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
        if (cut < max * 0.5) cut = max
        out.push(rest.slice(0, cut + 1))
        rest = rest.slice(cut + 1)
      }
      if (rest) out.push(rest)
      return out.length ? out : [text]
    }
    function hostSignal(ctx) {
      try { return (new AbortController()).signal } catch (e) { return undefined }
    }
    async function hostPrefs(ctx) {
      const r = ctx && ctx.remote && ctx.remote.cotTranslation
      if (!r || typeof r.limits !== 'function') return
      try {
        const res = await r.limits(hostSignal(ctx))
        const v = res && res.ok ? res.value : res
        if (v && v.preferences) tstate.pref = v.preferences
        if (v && v.maxTextChars) tstate.tmax = Math.min(1800, Math.max(200, v.maxTextChars))
      } catch (e) {}
    }
    async function hostTranslate(ctx, part) {
      const r = ctx && ctx.remote && ctx.remote.cotTranslation
      if (!r || typeof r.translate !== 'function') return null
      try {
        if (!tstate.pref) await hostPrefs(ctx)
        const p = tstate.pref || {}
        const tl = p.targetLanguage || 'zh'
        // 宿主目标语言被设成非中文时，跳过宿主，交给公共端点翻成中文
        if (!/^(auto|zh|cmn)/i.test(tl)) return null
        // 宿主 resolveSelected 要求显式配置下传完全一致的值；auto 才允许指定 zh-CN
        const req = { text: part, targetLanguage: (tl === 'auto' ? 'zh-CN' : tl), sourceLanguage: 'en' }
        if (p.provider) req.provider = p.provider
        const res = await r.translate(req, hostSignal(ctx))
        const v = res && typeof res === 'object' && 'ok' in res ? (res.ok ? res.value : null) : res
        return cleanZh(v, part)
      } catch (e) { return null }
    }
    async function publicChunk(chunk) {
      const q = encodeURIComponent(chunk)
      const urls = [
        { u: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=' + q, kind: 'g' },
        { u: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + q, kind: 'g' },
        { u: 'https://api.mymemory.translated.net/get?q=' + q + '&langpair=en%7Czh-CN', kind: 'm' }
      ]
      for (let i = 0; i < urls.length; i++) {
        try {
          const ctrl = new AbortController()
          const to = setTimeout(() => ctrl.abort(), 9000)
          let data
          try {
            const resp = await fetch(urls[i].u, { signal: ctrl.signal })
            if (!resp.ok) throw new Error('http ' + resp.status)
            data = await resp.json()
          } finally { clearTimeout(to) }
          const raw = urls[i].kind === 'g'
            ? parseGoogle(data)
            : (data && data.responseData ? data.responseData.translatedText : '')
          const z = cleanZh(raw, chunk)
          if (z) return z
        } catch (e) {}
      }
      return null
    }
    async function publicTranslate(part) {
      // 公共匿名端点对单次文本长度有限制（MyMemory ≈500 字符），拆块翻再拼回
      const chunks = splitText(part, 450)
      const out = []
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]
        if (!c.trim() || !/[A-Za-z]/.test(c)) { out.push(c); continue }
        const z = await publicChunk(c)
        out.push(z || c)
      }
      const joined = out.join('')
      if (isChinese(joined)) { tstate.fail = 0; return joined }
      tstate.fail++
      return null
    }
    async function translateOne(part) {
      const z = await hostTranslate(tstate.ctx, part)
      if (z) { tstate.fail = 0; return z }
      return await publicTranslate(part)
    }
    async function translateText(text) {
      const parts = splitText(text, tstate.tmax || 900)
      const out = []
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        if (!needsTranslate(p)) { out.push(p); continue }
        const k = norm(p)
        if (tstate.cache.has(k)) { out.push(tstate.cache.get(k)); continue }
        const z = await translateOne(p)
        if (z) {
          tstate.cache.set(k, z)
          if (tstate.cache.size > 300) tstate.cache.delete(tstate.cache.keys().next().value)
          out.push(z)
        } else out.push(p)
      }
      return out.join('')
    }
    function applyDisplay(id, text) {
      // 译文到达 / 关翻译回退原文：交给打字机逐字变换，不整段替换。
      typerSet(id, text)
    }
    function scheduleTranslate(id, text) {
      if (!needsTranslate(text)) return
      const t = tstate.timers.get(id)
      if (t) clearTimeout(t)
      tstate.timers.set(id, setTimeout(() => {
        tstate.timers.delete(id)
        if (!tstate.queue.some(j => j.id === id)) tstate.queue.push({ id })
        drainQueue()
      }, 650))
    }
    async function drainQueue() {
      if (tstate.busy) return
      tstate.busy = true
      try {
        while (tstate.queue.length) {
          const job = tstate.queue.shift()
          const it = state.entries.find(x => x.id === job.id)
          if (!it) continue
          const src = it.text
          if (!needsTranslate(src)) continue
          const k = norm(src)
          let zh = tstate.cache.get(k)
          if (!zh) {
            zh = await translateText(src)
            if (zh && zh !== src && isChinese(zh)) tstate.cache.set(k, zh)
          }
          const cur = state.entries.find(x => x.id === job.id)
          if (!cur || cur.text !== src || !state.cfg.translate) continue
          if (zh && zh !== src && isChinese(zh)) {
            cur.zh = zh
            tstate.fail = 0; tstate.warned = false
            applyDisplay(job.id, zh)
          } else {
            if (++tstate.fail >= 2 && !tstate.warned) {
              tstate.warned = true
              flash('翻译通道暂不可用 · 已显示英文原文，稍后自动重试')
            }
            const r = (job.retry || 0) + 1
            if (r <= 4) {
              const jid = job.id
              setTimeout(() => {
                if (!state.cfg.translate) return
                const it2 = state.entries.find(x => x.id === jid)
                if (!it2 || it2.zh || !needsTranslate(it2.text)) return
                if (!tstate.queue.some(j => j.id === jid)) tstate.queue.push({ id: jid, retry: r })
                drainQueue()
              }, 6000 + r * 3000)
            }
          }
        }
      } finally { tstate.busy = false }
    }
    function retranslateAll() {
      tstate.timers.forEach(t => clearTimeout(t)); tstate.timers.clear()
      tstate.queue.length = 0
      if (!state.cfg.translate) {
        state.entries.forEach(e => { if (e.zh) { delete e.zh; applyDisplay(e.id, e.text) } })
        return
      }
      state.entries.forEach(e => { if (!e.zh) scheduleTranslate(e.id, e.text) })
    }
    window.__dshThinkOverlay = plugin

    /* ── 样式 ───────────────────────────────────────────── */
    const CSS = `
.dto-root{position:fixed;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#c9d8e6;line-height:1.5}
.dto-panel{position:relative;width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;background:#0B1118;border:1px solid #24384a;border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.55),0 0 0 1px rgba(87,227,174,.06);overflow:hidden;backdrop-filter:blur(6px)}
.dto-head{display:flex;align-items:center;gap:8px;padding:9px 12px;flex:0 0 auto;cursor:move;user-select:none;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,0));border-bottom:1px solid #1d2c3b}
.dto-root{--dto-dot-o:1;--dto-dot-scale:1}
.dto-dot{width:9px;height:9px;border-radius:50%;background:#57E3AE;box-shadow:0 0 10px #57E3AE;opacity:var(--dto-dot-o);transform:scale(var(--dto-dot-scale));will-change:opacity,transform;flex:0 0 auto}
.dto-brand{font-size:11px;letter-spacing:.14em;color:#57E3AE;font-weight:700;flex:0 0 auto}
.dto-title{font-size:12px;color:#8aa0b4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:32%}
.dto-clock{font-size:11px;color:#5f7689;font-variant-numeric:tabular-nums;flex:0 0 auto}
.dto-spacer{flex:1 1 auto}
.dto-btn{appearance:none;border:1px solid transparent;background:transparent;color:#7e93a6;font-size:13px;line-height:1;width:24px;height:24px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto}
.dto-btn:hover{background:#1a2a38;color:#dceaf6;border-color:#2c4154}
.dto-btn.on{background:rgba(87,227,174,.16);color:#57E3AE;border-color:rgba(87,227,174,.4)}
.dto-tools{display:flex;align-items:center;gap:10px;padding:6px 12px;flex:0 0 auto;border-bottom:1px solid #1d2c3b;background:rgba(255,255,255,.015)}
.dto-lab{font-size:11px;color:#6f869a;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dto-range{width:76px;height:3px;accent-color:#57E3AE;cursor:pointer}
.dto-count{font-size:11px;color:#5f7689;white-space:nowrap}
.dto-feed{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:10px 12px 4px;scrollbar-width:thin;scrollbar-color:#2c4154 transparent}
.dto-feed::-webkit-scrollbar{width:6px}
.dto-feed::-webkit-scrollbar-thumb{background:#2c4154;border-radius:3px}
.dto-entry{margin:0 0 8px}
.dto-ehead{display:flex;align-items:center;gap:7px;font-size:.72em;color:#5f7689;margin-bottom:3px}
.dto-arrow{color:#57E3AE;font-size:.85em}
.dto-tool{color:#8aa0b4;font-weight:600}
.dto-etime{font-variant-numeric:tabular-nums;opacity:.75}
.dto-etext{white-space:pre-wrap;word-break:break-word;color:#c9d8e6;font-size:1em;line-height:1.62}
.dto-sep{height:1px;background:linear-gradient(90deg,#24384a,transparent);margin-top:9px}
.dto-hint{color:#5f7689;font-size:.86em;text-align:center;padding:26px 12px;line-height:1.8}
.dto-foot{flex:0 0 auto;padding:5px 12px 7px;font-size:10px;color:#4c6274;border-top:1px solid #1d2c3b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dto-handles{position:absolute;inset:0;pointer-events:none}
.dto-handle{position:absolute;pointer-events:auto}
.dto-h-n{top:-3px;left:10px;right:10px;height:8px;cursor:ns-resize}
.dto-h-s{bottom:-3px;left:10px;right:10px;height:8px;cursor:ns-resize}
.dto-h-w{left:-3px;top:10px;bottom:10px;width:8px;cursor:ew-resize}
.dto-h-e{right:-3px;top:10px;bottom:10px;width:8px;cursor:ew-resize}
.dto-h-nw{left:-4px;top:-4px;width:13px;height:13px;cursor:nwse-resize}
.dto-h-ne{right:-4px;top:-4px;width:13px;height:13px;cursor:nesw-resize}
.dto-h-sw{left:-4px;bottom:-4px;width:13px;height:13px;cursor:nesw-resize}
.dto-h-se{right:-4px;bottom:-4px;width:13px;height:13px;cursor:nwse-resize}
.dto-pill,.dto-unlock{position:fixed;z-index:2147483600;appearance:none;border:1px solid #2c4154;background:#0B1118;color:#57E3AE;font-family:inherit;font-size:12px;padding:8px 14px;border-radius:999px;cursor:pointer;box-shadow:0 8px 26px rgba(0,0,0,.5)}
.dto-pill{right:20px;bottom:20px;display:none}
.dto-unlock{right:20px;bottom:64px;display:none}
.dto-pill:hover,.dto-unlock:hover{border-color:#57E3AE}
`
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const s = el('style'); s.id = STYLE_ID; s.dataset.plugin = ID
      s.textContent = CSS
      document.head.appendChild(s)
    }

    /* ── 独立小窗的 HTML（自己渲染，靠 BroadcastChannel 收数据）── */
    const POP_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>思考悬浮窗 · DSH</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:#0B1118;color:#c9d8e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.5;overflow:hidden;border:1px solid #24384a;border-radius:12px}
.bar{display:flex;align-items:center;gap:8px;padding:9px 12px;flex:0 0 auto;border-bottom:1px solid #1d2c3b;background:linear-gradient(180deg,rgba(255,255,255,.045),transparent)}
.dot{width:9px;height:9px;border-radius:50%;background:#57E3AE;box-shadow:0 0 10px #57E3AE;opacity:var(--dot-o,1);transform:scale(var(--dot-s,1));will-change:opacity,transform}
.brand{font-size:11px;letter-spacing:.14em;color:#57E3AE;font-weight:700}
.ttl{font-size:12px;color:#8aa0b4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
.clk{font-size:11px;color:#5f7689;font-variant-numeric:tabular-nums}
.sp{flex:1}
button{appearance:none;border:1px solid transparent;background:transparent;color:#7e93a6;font:inherit;font-size:11px;padding:4px 9px;border-radius:6px;cursor:pointer}
button:hover{background:#1a2a38;color:#dceaf6;border-color:#2c4154}
button.on{background:rgba(87,227,174,.16);color:#57E3AE;border-color:rgba(87,227,174,.4)}
.ctl{display:flex;align-items:center;gap:14px;padding:6px 12px;flex:0 0 auto;border-bottom:1px solid #1d2c3b;font-size:11px;color:#6f869a}
.ctl label{display:inline-flex;align-items:center;gap:6px}
input[type=range]{width:80px;accent-color:#57E3AE}
.feed{flex:1;overflow-y:auto;padding:10px 12px 4px;scrollbar-width:thin;scrollbar-color:#2c4154 transparent}
.entry{margin:0 0 8px}
.eh{display:flex;align-items:center;gap:7px;font-size:.72em;color:#5f7689;margin-bottom:3px}
.ar{color:#57E3AE}.tl{color:#8aa0b4;font-weight:600}.tm{opacity:.75;font-variant-numeric:tabular-nums}
.tx{white-space:pre-wrap;word-break:break-word;line-height:1.62}
.sep{height:1px;background:linear-gradient(90deg,#24384a,transparent);margin-top:9px}
.hint{color:#5f7689;font-size:.86em;text-align:center;padding:26px 12px;line-height:1.8}
.foot{flex:0 0 auto;padding:5px 12px 7px;font-size:10px;color:#4c6274;border-top:1px solid #1d2c3b}
</style></head><body>
<div class="bar"><span class="dot"></span><span class="brand">LIVE THINK</span><span class="ttl" id="ttl">思考</span><span class="clk" id="clk"></span><span class="sp"></span><button id="tra" title="英译中：开 / 关">译</button><button id="top" title="尝试设为总在最前">置顶</button><button id="thr" title="点击穿透">穿透</button><button id="clr" title="清空">清空</button></div>
<div class="ctl"><label>透明度 <input id="op" type="range" min="0.2" max="1" step="0.02"></label><label>字号 <input id="fs" type="range" min="11" max="26" step="1"></label></div>
<div class="feed" id="feed"><div class="hint">等待思考内容…</div></div>
<div class="foot">独立小窗 · 数据由 DSH 主窗口实时推送 · 穿透后按 Esc 恢复</div>
<script>
(function(){
  var bc=null; try{ bc=new BroadcastChannel('dsh-think-overlay') }catch(e){}
  var feed=document.getElementById('feed'), map=new Map(), hint=feed.querySelector('.hint');
  function clock(){ document.getElementById('clk').textContent=new Date().toTimeString().slice(0,8) }
  clock(); setInterval(clock,1000);
  function setCfg(c){
    if(!c) return;
    var op=c.opacity==null?0.9:c.opacity, fs=c.fontSize||15;
    document.body.style.opacity=String(op); feed.style.fontSize=fs+'px';
    document.getElementById('op').value=String(op); document.getElementById('fs').value=String(fs);
    document.getElementById('thr').classList.toggle('on',!!c.clickThrough);
    var tb=document.getElementById('tra'); if(tb){ tb.classList.toggle('on',c.translate!==false); tb.title=c.translate!==false?'英译中：已开（点击关闭）':'英译中：已关（点击开启）'; }
    document.body.style.pointerEvents=c.clickThrough?'none':'auto';
  }
  function setTitle(t){ document.getElementById('ttl').textContent=t?('思考 · '+t):'思考'; document.title=t?('思考 · '+t+' · DSH'):'思考悬浮窗 · DSH' }
  function render(e){
    if(!e||map.has(String(e.id))) return;
    if(hint&&hint.parentNode) hint.parentNode.removeChild(hint);
    var box=document.createElement('div'); box.className='entry'; box.dataset.id=String(e.id);
    var hd=document.createElement('div'); hd.className='eh';
    var ar=document.createElement('span'); ar.className='ar'; ar.textContent='▶';
    var tl=document.createElement('span'); tl.className='tl'; tl.textContent=e.tool||'思考';
    var tm=document.createElement('span'); tm.className='tm'; tm.textContent=e.time||'';
    hd.appendChild(ar); hd.appendChild(tl); hd.appendChild(tm);
    var tx=document.createElement('div'); tx.className='tx'; tx.textContent=e.text||'';
    var sep=document.createElement('div'); sep.className='sep';
    box.appendChild(hd); box.appendChild(tx); box.appendChild(sep);
    feed.appendChild(box); map.set(String(e.id),box);
  }
  function nearBottom(){ return feed.scrollHeight-feed.scrollTop-feed.clientHeight<60 }
  function apply(m){
    if(!m) return;
    if(m.type==='pulse'){ document.body.style.setProperty('--dot-o',m.o); document.body.style.setProperty('--dot-s',m.s); return; }
    var stick=nearBottom();
    if(m.type==='sync'){ feed.innerHTML=''; map.clear(); (m.entries||[]).forEach(render); setCfg(m.cfg); setTitle(m.title); }
    else if(m.type==='entry'){ render(m.entry); }
    else if(m.type==='update'){ var b=map.get(String(m.id)); if(b){ var t=b.querySelector('.tx'); if(t) t.textContent=m.text; } }
    else if(m.type==='clear'){ feed.innerHTML=''; map.clear(); }
    else if(m.type==='config'){ setCfg(m.cfg); return; }
    else if(m.type==='title'){ setTitle(m.title); return; }
    if(m.type==='sync'||stick) feed.scrollTop=feed.scrollHeight;
  }
  window.__THINK_PUSH__=apply;
  if(bc) bc.onmessage=function(ev){ if(ev.data) apply(ev.data) };
  function emit(m){ if(bc) bc.postMessage(m) }
  document.getElementById('op').addEventListener('input',function(){ emit({type:'cfg',patch:{opacity:Number(this.value)}}) });
  document.getElementById('fs').addEventListener('input',function(){ emit({type:'cfg',patch:{fontSize:Number(this.value)}}) });
  document.getElementById('thr').addEventListener('click',function(){ emit({type:'cfg',patch:{clickThrough:!this.classList.contains('on')}}) });
  document.getElementById('tra').addEventListener('click',function(){ emit({type:'cfg',patch:{translate:!this.classList.contains('on')}}) });
  document.getElementById('clr').addEventListener('click',function(){ feed.innerHTML=''; map.clear(); emit({type:'clr'}) });
  document.addEventListener('keydown',function(ev){ if(ev.key==='Escape') emit({type:'cfg',patch:{clickThrough:false}}) });
  function tryTop(){
    var ok=false;
    try{
      var rq=window.require;
      if(rq){
        try{ var el=rq('electron'); var w=el&&el.remote&&el.remote.getCurrentWindow&&el.remote.getCurrentWindow(); if(w&&w.setAlwaysOnTop){ w.setAlwaysOnTop(true,'floating'); ok=true } }catch(e){}
        if(!ok){ try{ var r=rq('@electron/remote'); var w2=r.getCurrentWindow(); if(w2&&w2.setAlwaysOnTop){ w2.setAlwaysOnTop(true,'floating'); ok=true } }catch(e){} }
      }
    }catch(e){}
    var b=document.getElementById('top');
    b.textContent=ok?'已置顶':'置顶*';
    b.title=ok?'已设置为总在最前':'当前 DSH 未开放 Electron remote；可用系统窗口菜单手动置顶';
  }
  document.getElementById('top').addEventListener('click',tryTop);
  setTimeout(tryTop,300);
  try{ if(window.opener&&window.opener.__THINK_READY__) window.opener.__THINK_READY__() }catch(e){}
  if(bc) bc.postMessage({type:'ready'});
})();
</script></body></html>`

    /* ── 构建页面内悬浮层 ─────────────────────────────────── */
    function build() {
      const root = el('div', 'dto-root'); root.id = 'dto-root'
      const panel = el('div', 'dto-panel')
      const head = el('div', 'dto-head')
      const mkBtn = (act, label, tip) => {
        const b = el('button', 'dto-btn', label)
        b.dataset.act = act; b.title = tip; b.type = 'button'
        return b
      }
      head.append(
        el('span', 'dto-dot'), el('span', 'dto-brand', 'LIVE THINK'),
        el('span', 'dto-title', '思考'), el('span', 'dto-clock', nowHM()),
        el('span', 'dto-spacer'),
        mkBtn('pop', '⧉', '弹出独立小窗'),
        mkBtn('translate', '译', '英译中：开 / 关'),
        mkBtn('through', '◌', '点击穿透'),
        mkBtn('pause', 'Ⅱ', '暂停 / 继续跟随'),
        mkBtn('clear', '⌫', '清空'),
        mkBtn('hide', '—', '收起成小胶囊')
      )
      const tools = el('div', 'dto-tools')
      const oRange = el('input', 'dto-range'); oRange.type = 'range'
      oRange.min = '0.2'; oRange.max = '1'; oRange.step = '0.02'; oRange.dataset.k = 'opacity'
      const fRange = el('input', 'dto-range'); fRange.type = 'range'
      fRange.min = '11'; fRange.max = '26'; fRange.step = '1'; fRange.dataset.k = 'fontSize'
      const oLab = el('label', 'dto-lab', '透明度'); oLab.appendChild(oRange)
      const fLab = el('label', 'dto-lab', '字号'); fLab.appendChild(fRange)
      const count = el('span', 'dto-count', '0 条')
      tools.append(oLab, fLab, el('span', 'dto-spacer'), count)
      const feed = el('div', 'dto-feed')
      const hint = el('div', 'dto-hint', '等待思考内容…\n模型开始思考、或页面里展开思考行后，这里会实时出现。')
      feed.appendChild(hint)
      const foot = el('div', 'dto-foot', '拖动标题移动 · 拖边缘缩放 · 设置自动保存')
      panel.append(head, tools, feed, foot)
      const handles = el('div', 'dto-handles')
      ;['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].forEach(d => {
        const t = el('div', 'dto-handle dto-h-' + d); t.dataset.dir = d
        handles.appendChild(t)
      })
      root.append(panel, handles)
      document.body.appendChild(root)

      const pill = el('button', 'dto-pill', '💡 思考悬浮窗')
      pill.type = 'button'; pill.title = '展开思考悬浮窗'
      pill.addEventListener('click', () => setCfg({ visible: true }))
      document.body.appendChild(pill)

      const unlock = el('button', 'dto-unlock', '🔒 退出穿透')
      unlock.type = 'button'; unlock.title = '关闭点击穿透'
      unlock.addEventListener('click', () => setCfg({ clickThrough: false }))
      document.body.appendChild(unlock)

      head.addEventListener('click', ev => {
        const b = ev.target.closest && ev.target.closest('button[data-act]')
        if (!b) return
        ev.stopPropagation()
        const a = b.dataset.act
        if (a === 'pop') openPopup()
        else if (a === 'translate') setCfg({ translate: !state.cfg.translate })
        else if (a === 'through') setCfg({ clickThrough: !state.cfg.clickThrough })
        else if (a === 'pause') setCfg({ paused: !state.cfg.paused })
        else if (a === 'clear') clearFeed()
        else if (a === 'hide') setCfg({ visible: false })
      })
      tools.addEventListener('input', ev => {
        const k = ev.target.dataset && ev.target.dataset.k
        if (k) setCfg({ [k]: Number(ev.target.value) })
      })
      attachDrag(head)
      handles.querySelectorAll('.dto-handle').forEach(hd => attachResize(hd))

      state.els = { root, panel, head, title: head.querySelector('.dto-title'),
        clock: head.querySelector('.dto-clock'), feed, hint, foot, count,
        pill, unlock, oRange, fRange }
      return state.els
    }

    function attachDrag(handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, on = false
      handle.addEventListener('pointerdown', ev => {
        if (ev.target.closest && ev.target.closest('button,input')) return
        on = true; sx = ev.clientX; sy = ev.clientY
        ox = state.cfg.x; oy = state.cfg.y
        try { handle.setPointerCapture(ev.pointerId) } catch (e) {}
        ev.preventDefault()
      })
      handle.addEventListener('pointermove', ev => {
        if (!on) return
        state.cfg.x = clamp(ox + ev.clientX - sx, 0, Math.max(0, window.innerWidth - state.cfg.w))
        state.cfg.y = clamp(oy + ev.clientY - sy, 0, Math.max(0, window.innerHeight - state.cfg.h))
        applyGeom(); saveCfg(); broadcast({ type: 'config', cfg: state.cfg })
      })
      const end = () => { on = false }
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
    }

    function attachResize(hd) {
      const dir = hd.dataset.dir
      let sx = 0, sy = 0, o = null, on = false
      hd.addEventListener('pointerdown', ev => {
        on = true; sx = ev.clientX; sy = ev.clientY
        o = { x: state.cfg.x, y: state.cfg.y, w: state.cfg.w, h: state.cfg.h }
        try { hd.setPointerCapture(ev.pointerId) } catch (e) {}
        ev.preventDefault(); ev.stopPropagation()
      })
      hd.addEventListener('pointermove', ev => {
        if (!on || !o) return
        const dx = ev.clientX - sx, dy = ev.clientY - sy
        let x = o.x, y = o.y, w = o.w, height = o.h
        if (dir.indexOf('e') !== -1) w = clamp(o.w + dx, 260, 1200)
        if (dir.indexOf('s') !== -1) height = clamp(o.h + dy, 180, 900)
        if (dir.indexOf('w') !== -1) {
          w = clamp(o.w - dx, 260, 1200)
          x = o.x + (o.w - w)
        }
        if (dir.indexOf('n') !== -1) {
          height = clamp(o.h - dy, 180, 900)
          y = o.y + (o.h - height)
        }
        state.cfg.x = x; state.cfg.y = y; state.cfg.w = w; state.cfg.h = height
        applyGeom(); saveCfg(); broadcast({ type: 'config', cfg: state.cfg })
      })
      const end = () => { on = false; o = null }
      hd.addEventListener('pointerup', end)
      hd.addEventListener('pointercancel', end)
    }

    function applyGeom() {
      const e = state.els
      if (!e.root) return
      e.root.style.left = state.cfg.x + 'px'
      e.root.style.top = state.cfg.y + 'px'
      e.root.style.width = state.cfg.w + 'px'
      e.root.style.height = state.cfg.h + 'px'
    }
    function applyCfg() {
      const e = state.els
      if (!e.root) return
      applyGeom()
      e.panel.style.opacity = String(state.cfg.opacity)
      e.feed.style.fontSize = state.cfg.fontSize + 'px'
      e.root.style.pointerEvents = state.cfg.clickThrough ? 'none' : 'auto'
      e.unlock.style.display = state.cfg.clickThrough ? 'block' : 'none'
      e.pill.style.display = state.cfg.visible ? 'none' : 'block'
      e.root.style.display = state.cfg.visible ? 'block' : 'none'
      e.oRange.value = String(state.cfg.opacity)
      e.fRange.value = String(state.cfg.fontSize)
      const tb = e.head.querySelector('button[data-act="through"]')
      const pb = e.head.querySelector('button[data-act="pause"]')
      const trb = e.head.querySelector('button[data-act="translate"]')
      if (tb) tb.classList.toggle('on', !!state.cfg.clickThrough)
      if (pb) pb.classList.toggle('on', !!state.cfg.paused)
      if (trb) {
        trb.classList.toggle('on', !!state.cfg.translate)
        trb.title = state.cfg.translate ? '英译中：已开（点击关闭）' : '英译中：已关（点击开启）'
      }
      e.foot.textContent = state.cfg.paused
        ? '已暂停跟随 · 点 Ⅱ 继续 · 拖动标题移动 · 拖边缘缩放'
        : (state.cfg.translate ? '英译中已开 · ' : '英译中已关 · ') +
          '拖动标题移动 · 拖边缘缩放 · 设置自动保存'
    }
    function setCfg(patch) {
      const wasTranslate = state.cfg.translate
      Object.assign(state.cfg, patch || {})
      if ('w' in (patch || {})) state.cfg.w = clamp(state.cfg.w, 260, 1200)
      if ('h' in (patch || {})) state.cfg.h = clamp(state.cfg.h, 180, 900)
      if ('opacity' in (patch || {})) state.cfg.opacity = clamp(state.cfg.opacity, 0.2, 1)
      if ('fontSize' in (patch || {})) state.cfg.fontSize = clamp(state.cfg.fontSize, 11, 26)
      applyCfg(); saveCfg(); broadcast({ type: 'config', cfg: state.cfg })
      if (patch && 'translate' in patch && wasTranslate !== state.cfg.translate) {
        tstate.warned = false; tstate.fail = 0
        retranslateAll()
      }
    }

    /* ── 内容渲染 ───────────────────────────────────────── */
    // 推给独立小窗的是「打字机已吐出的片段」，小窗直接显示即与主窗同步丝滑。
    function wireEntry(e) { return Object.assign({}, e, { text: dispRendered(e.id, shown(e)) }) }
    function renderEntry(entry, feed) {
      const box = el('div', 'dto-entry'); box.dataset.id = String(entry.id)
      const hr = el('div', 'dto-ehead')
      hr.append(el('span', 'dto-arrow', '▶'),
        el('span', 'dto-tool', entry.tool || '思考'),
        el('span', 'dto-etime', entry.time || nowHM()))
      box.append(hr, el('div', 'dto-etext', dispRendered(entry.id, '')), el('div', 'dto-sep'))
      feed.appendChild(box)
    }
    function pushEntry(entry) {
      state.entries.push(entry)
      while (state.entries.length > MAX) {
        const old = state.entries.shift()
        typer.disp.delete(old.id)
        const n = state.els.feed && state.els.feed.querySelector('.dto-entry[data-id="' + old.id + '"]')
        if (n && n.parentNode) n.parentNode.removeChild(n)
      }
      const e = state.els
      if (e.feed) {
        if (e.hint && e.hint.parentNode) e.hint.parentNode.removeChild(e.hint)
        renderEntry(entry, e.feed)
        e.feed.scrollTop = e.feed.scrollHeight
        e.count.textContent = state.entries.length + ' 条'
        e.title.textContent = state.title ? ('思考 · ' + state.title) : '思考'
      }
      // 先建打字机状态（rendered 从空开始），再广播，让小窗也拿到片段而非全文。
      typerSet(entry.id, shown(entry))
      broadcast({ type: 'entry', entry: wireEntry(entry) })
      scheduleTranslate(entry.id, entry.text)
    }
    function updateEntry(id, text) {
      const it = state.entries.find(x => x.id === id)
      if (it) it.text = text
      typerSet(id, shown(it || { text }))
      scheduleTranslate(id, text)
    }
    function clearFeed() {
      state.entries = []
      state.seen.clear()
      state.rowMap = new WeakMap()
      typer.disp.clear(); typerStop()
      tstate.timers.forEach(t => clearTimeout(t)); tstate.timers.clear()
      tstate.queue.length = 0
      const e = state.els
      if (e.feed) {
        e.feed.innerHTML = ''
        const hint = el('div', 'dto-hint', '等待思考内容…\n模型开始思考、或页面里展开思考行后，这里会实时出现。')
        e.feed.appendChild(hint); e.hint = hint
        e.count.textContent = '0 条'
      }
      broadcast({ type: 'clear' })
    }

    /* ── 从 DSH 页面抓思考内容 ───────────────────────────── */
    const HIDDEN = '[aria-hidden="true"],[inert]'
    const PLACEHOLDER = /^(思考中|正在思考|thinking\b|思考了?\s*\d+|正在生成|\.{3}|…|\s|)+$/i
    function tidy(s) {
      return String(s || '').replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    }
    function cleanText(node) {
      // 展开态：正文在 <p> 里（跳过 aria-hidden 的打字动画副本）
      let parts = Array.from(node.querySelectorAll('p'))
        .filter(p => !p.closest(HIDDEN))
        .map(p => tidy(p.innerText || p.textContent || ''))
        .filter(Boolean)
      let out = parts.join('\n').trim()
      if (out.length >= 8 && !PLACEHOLDER.test(out)) return out
      // 折叠态 / 流式态兜底：摘要行、展开行、shimmer、整节点文本里取最长有效串
      const alts = []
      node.querySelectorAll('[data-sample],[data-disclosure-row],[data-shimmer]').forEach(n => {
        if (n.closest(HIDDEN)) return
        const t = tidy(n.innerText || n.textContent || '')
        if (t) alts.push(t)
      })
      const whole = tidy(node.innerText || node.textContent || '')
      if (whole) alts.push(whole)
      for (let i = 0; i < alts.length; i++) {
        const a = alts[i]
        if (a.length > out.length && a.length >= 4 && !PLACEHOLDER.test(a)) out = a
      }
      return out
    }
    // 思考文本会逐字增长，或完成后被 React 用新节点重写。
    // 按「同一节点」更新为主，节点被替换时用长公共前缀认回最后一条，避免一条思考裂成多条。
    function relatedId(text) {
      const k = norm(text)
      const exact = state.seen.get(k)
      if (exact) return exact
      const last = state.entries[state.entries.length - 1]
      if (last) {
        const lk = norm(last.text)
        if (k.length >= 20 && lk.length >= 20 && k.slice(0, 20) === lk.slice(0, 20)) return last.id
      }
      return 0
    }
    function toolFromCalls() {
      const calls = document.querySelectorAll('[data-chat-call-id],[data-tool-name],[data-call-name]')
      if (!calls.length) return ''
      const n = calls[calls.length - 1]
      const attr = n.getAttribute && (n.getAttribute('data-tool-name') || n.getAttribute('data-call-name') || n.getAttribute('data-name'))
      return toolLabel(attr || n.innerText || n.textContent || '')
    }
    function scan() {
      if (!state.mounted || state.cfg.paused) return
      try {
        const lab = toolFromCalls()
        if (lab) state.lastTool = lab
        const all = Array.from(document.querySelectorAll('[data-variant="think"],[data-chat-group-part="reasoning"]'))
          .filter(e => !e.closest(HIDDEN))
        const rows = all.filter(e => !all.some(o => o !== e && o.contains(e)))
        rows.forEach(r => {
          const text = cleanText(r)
          // 跳过折叠后的「思考了 N 秒」之类占位文字，别把已抓到的正文覆盖掉
          if (!text || text.length < 4 || PLACEHOLDER.test(text)) return
          const key = norm(text)
          const rec = state.rowMap.get(r)
          if (rec) {
            if (text === rec.text || text.length + 4 < rec.text.length) return
            if (state.seen.get(norm(rec.text)) === rec.id) state.seen.delete(norm(rec.text))
            rec.text = text
            state.seen.set(key, rec.id)
            updateEntry(rec.id, text)
            return
          }
          const rid = relatedId(text)
          if (rid) {
            state.rowMap.set(r, { id: rid, text })
            state.seen.set(key, rid)
            const it = state.entries.find(x => x.id === rid)
            if (it && text.length > it.text.length) updateEntry(rid, text)
            return
          }
          const id = ++state.seq
          state.rowMap.set(r, { id, text })
          state.seen.set(key, id)
          if (state.seen.size > 400) {
            const first = state.seen.keys().next().value
            state.seen.delete(first)
          }
          pushEntry({ id, text, time: nowHM(), tool: state.lastTool || '' })
        })
        const t = document.title || ''
        if (t && t !== state.title) {
          state.title = t.replace(/\s*[-–|]\s*(DeepSeek|DSH).*$/i, '').trim().slice(0, 60) || t.slice(0, 60)
          if (state.els.title) state.els.title.textContent = state.title ? ('思考 · ' + state.title) : '思考'
          broadcast({ type: 'title', title: state.title })
        }
      } catch (e) { /* 页面结构变化时静默跳过本轮 */ }
    }

    /* ── 跨窗口通道 ─────────────────────────────────────── */
    function openChannel() {
      try {
        state.bc = new BroadcastChannel(CHANNEL)
        state.bc.onmessage = ev => {
          const m = ev.data
          if (!m) return
          if (m.type === 'ready') syncPopup()
          else if (m.type === 'cfg' && m.patch) setCfg(m.patch)
          else if (m.type === 'clr') clearFeed()
        }
      } catch (e) { state.bc = null }
    }
    function broadcast(m) {
      try { if (state.bc) state.bc.postMessage(m) } catch (e) {}
      try {
        if (state.pop && !state.pop.closed && typeof state.pop.__THINK_PUSH__ === 'function') state.pop.__THINK_PUSH__(m)
      } catch (e) {}
    }
    function syncPopup() {
      broadcast({ type: 'sync', entries: state.entries.map(wireEntry), cfg: state.cfg, title: state.title })
    }
    function flash(msg) {
      const e = state.els
      if (!e.foot) return
      const old = e.foot.textContent
      e.foot.textContent = msg
      setTimeout(() => {
        if (e.foot) e.foot.textContent = state.cfg.paused
          ? '已暂停跟随 · 点 Ⅱ 继续 · 拖动标题移动 · 拖边缘缩放'
          : old
      }, 4200)
    }
    function openPopup() {
      if (state.pop && !state.pop.closed) {
        try { state.pop.focus() } catch (e) {}
        syncPopup(); return
      }
      const w = state.cfg.w, h = state.cfg.h
      const left = Math.max(0, Math.round((window.screenX || 0) + (window.innerWidth - w) / 2))
      const top = Math.max(0, Math.round((window.screenY || 0) + 80))
      let p = null
      try {
        p = window.open('', 'dsh-think-overlay-pop',
          'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top +
          ',menubar=no,toolbar=no,location=no,status=no,resizable=yes')
      } catch (e) {}
      if (!p) { flash('弹窗被拦截：请在 DSH 里允许弹出窗口，或继续用页面内悬浮层'); return }
      state.pop = p
      try { const d = p.document; d.open(); d.write(POP_HTML); d.close() } catch (e) {}
      window.__THINK_READY__ = () => syncPopup()
      setTimeout(syncPopup, 150)
      setTimeout(syncPopup, 700)
      if (state.pollTimer) clearInterval(state.pollTimer)
      state.pollTimer = setInterval(() => {
        if (!state.pop || state.pop.closed) {
          state.pop = null
          clearInterval(state.pollTimer); state.pollTimer = null
        }
      }, 1500)
    }

    /* ── 生命周期 ───────────────────────────────────────── */
    function startWatch() {
      let pending = false
      const trigger = () => {
        if (pending) return
        pending = true
        setTimeout(() => { pending = false; scan() }, 140)
      }
      try {
        state.observer = new MutationObserver(trigger)
        state.observer.observe(document.body, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['data-expanded', 'data-variant', 'data-chat-group-part']
        })
      } catch (e) {}
      state.scanTimer = setInterval(trigger, 600)
      state.lastHref = location.href
      state.clockTimer = setInterval(() => {
        if (state.els.clock) state.els.clock.textContent = nowHM()
        const href = location.href
        if (state.lastHref && href !== state.lastHref) clearFeed()
        state.lastHref = href
      }, 1000)
    }
    function mount() {
      if (state.mounted) return
      if (!document.body) { setTimeout(mount, 60); return }
      state.cfg = loadCfg()
      ensureStyle()
      build()
      applyCfg()
      openChannel()
      startWatch()
      state.mounted = true
      startPulse()
      scan()
    }
    function unmount() {
      state.mounted = false
      stopPulse()
      typer.disp.clear(); typerStop()
      try { state.observer && state.observer.disconnect() } catch (e) {}
      ;[state.scanTimer, state.clockTimer, state.pollTimer].forEach(t => { if (t) clearInterval(t) })
      tstate.timers.forEach(t => clearTimeout(t)); tstate.timers.clear()
      tstate.queue.length = 0
      try { state.bc && state.bc.close() } catch (e) {}
      try { state.pop && !state.pop.closed && state.pop.close() } catch (e) {}
      ;['root', 'pill', 'unlock'].forEach(k => {
        const n = state.els[k]; if (n && n.parentNode) n.parentNode.removeChild(n)
      })
      const st = document.getElementById(STYLE_ID)
      if (st && st.parentNode) st.parentNode.removeChild(st)
      state.els = {}
    }

    /* ── 设置页（可选；失败不影响悬浮窗）──────────────────── */
    const btnStyle = {
      appearance: 'none', font: 'inherit', fontSize: '12px', padding: '6px 12px',
      borderRadius: '7px', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2, #2c4154)',
      background: 'var(--dsw-alias-bg-layer-1, #0B1118)', color: 'inherit'
    }
    function SettingsPanel() {
      const [, setTick] = React.useState(0)
      const cfg = plugin.api.getCfg()
      const bump = () => setTick(v => v + 1)
      const row = (label, node) => h('div',
        { style: { display: 'flex', alignItems: 'center', gap: '12px', margin: '10px 0' } },
        h('span', { style: { width: '96px', fontSize: '13px', opacity: .75 } }, label), node)
      return h('div', { style: { padding: '4px 0', fontSize: '13px' } },
        h('h3', { style: { margin: '0 0 6px', fontSize: '15px' } }, '思考悬浮窗'),
        h('p', { style: { margin: '0 0 14px', fontSize: '12px', lineHeight: 1.7, opacity: .72 } },
          '把 DSH 页面里正在产生的思考内容实时抽到一个置顶悬浮层；可拖拽、缩放、调透明度、点击穿透，也能弹出成独立小窗。'),
        row('显示', h('button', { style: btnStyle, onClick: () => { plugin.api.setCfg({ visible: !cfg.visible }); bump() } }, cfg.visible ? '隐藏' : '显示')),
        row('透明度', h('input', { type: 'range', min: '0.2', max: '1', step: '0.02', defaultValue: String(cfg.opacity), onChange: e => plugin.api.setCfg({ opacity: Number(e.target.value) }) })),
        row('字号', h('input', { type: 'range', min: '11', max: '26', step: '1', defaultValue: String(cfg.fontSize), onChange: e => plugin.api.setCfg({ fontSize: Number(e.target.value) }) })),
        row('点击穿透', h('button', { style: btnStyle, onClick: () => { plugin.api.setCfg({ clickThrough: !cfg.clickThrough }); bump() } }, cfg.clickThrough ? '关闭' : '开启')),
        row('英译中', h('button', { style: btnStyle, onClick: () => { plugin.api.setCfg({ translate: !cfg.translate }); bump() } }, cfg.translate ? '已开（点此关闭）' : '已关（点此开启）')),
        row('操作', h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { style: btnStyle, onClick: () => plugin.api.pop() }, '弹出独立小窗'),
          h('button', { style: btnStyle, onClick: () => plugin.api.clear() }, '清空内容'),
          h('button', { style: btnStyle, onClick: () => { plugin.api.reset(); bump() } }, '重置位置'))))
    }

    plugin.api = {
      getCfg: () => Object.assign({}, state.cfg),
      setCfg, clear: clearFeed, pop: openPopup, scan,
      // 调试/自检入口：翻译一段文本、判断是否需要翻译
      translateText, needsTranslate,
      reset: () => setCfg({
        w: 428, h: 380,
        x: Math.max(12, window.innerWidth - 428 - 28),
        y: Math.max(12, window.innerHeight - 380 - 28),
        opacity: 0.9, fontSize: 15,
        clickThrough: false, visible: true, paused: false, translate: true
      })
    }

    plugin.apply = function apply(ctx) {
      let done = false
      const go = () => {
        if (done) return
        done = true
        tstate.ctx = ctx || tstate.ctx
        if (tstate.ctx && tstate.ctx.remote && tstate.ctx.remote.cotTranslation) hostPrefs(tstate.ctx)
        try { mount() } catch (e) { console.warn('[think-overlay] mount:', e) }
        try {
          if (React && ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.slots.inject('settings.section', () => ctx.slots.register(
              { name: 'settings.section', id: 'think-overlay', order: 66, label: () => '思考悬浮窗' },
              SettingsPanel
            ))
          }
        } catch (e) { console.warn('[think-overlay] settings:', e) }
        if (state.cfg.translate) retranslateAll()
      }
      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => { go(); return () => unmount() }, 'dsh-think-overlay')
        } else go()
      } catch (e) { go() }
    }

    // 兜底：即便宿主因依赖/时序问题没调用 apply，悬浮层也会挂上。mount() 幂等。
    try { setTimeout(() => { try { mount() } catch (e) {} }, 0) } catch (e) {}

    return plugin
  }
})
