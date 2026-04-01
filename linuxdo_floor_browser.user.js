// ==UserScript==
// @name         Linux.do 自动爬楼阅读器
// @namespace    http://tampermonkey.net/
// @version      3.2.2
// @description  自动滚动浏览 linux.do 帖子，列表页先模拟人工浏览再随机点帖，帖子页读完返回继续，全程拟人化随机行为
// @author       You
// @match        https://linux.do/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // 页面类型判断
    // ============================================================
    // linux.do 是 Discourse 论坛，URL 规律：
    //   列表页：https://linux.do/  |  /latest  |  /top  |  /c/xxx  |  /tag/xxx
    //   帖子页：https://linux.do/t/slug/12345[/页码]
    const isTopicPage = /^https:\/\/linux\.do\/t\//.test(location.href);
    const isListPage  = !isTopicPage && /^https:\/\/linux\.do(\/|$)/.test(location.href);

    // ============================================================
    // 默认配置
    // ============================================================
    const DEFAULTS = {
        // ── 帖子页滚动 ──────────────────────────────────
        scrollStep:       280,    // 每次滚动基准像素（实际会叠加随机抖动）
        scrollInterval:   900,    // 滚动间隔基准 ms
        jitter:           350,    // 时间随机抖动 ±ms
        pauseChance:      0.06,   // 每次滚动后触发"阅读停顿"的概率
        pauseDuration:    3500,   // 停顿时长基准 ms（实际 ±50%）
        backScrollChance: 0.04,   // 每次滚动后触发"回翻"的概率
        // ── 点赞 ────────────────────────────────────────
        likeEnabled:      false,  // 是否自动点赞
        likeChance:       0.12,   // 点赞概率
        likeInterval:     9000,   // 两次点赞最短间隔 ms
        // ── 巡游节奏 ────────────────────────────────────
        backDelay:        1800,   // 帖子读完后等待多少 ms 再返回列表
        maxTopics:        20,     // 巡游模式最多读几个帖子（0 = 不限）
        // ── 列表页模拟浏览 ──────────────────────────────
        listBrowseMin:    4000,   // 在列表页最少滚动浏览多少 ms 再点帖子
        listBrowseMax:    10000,  // 在列表页最多滚动浏览多少 ms 再点帖子
        listScrollStep:   180,    // 列表页每次滚动基准像素
        listScrollInterval: 700,  // 列表页滚动间隔基准 ms
    };

    const SK = 'ld_v2_';  // storage key 前缀

    // ============================================================
    // Tab Session ID —— 每个 tab 独立，防止新开的 tab 误执行
    // ============================================================
    // 用 sessionStorage 保持同一 tab 跨页面跳转时 ID 不变；
    // 新开的 tab 会得到一个全新的 sessionStorage，因此 ID 不同。
    const _TAB_KEY = 'ld_tabId';
    if (!sessionStorage.getItem(_TAB_KEY)) {
        sessionStorage.setItem(_TAB_KEY, Math.random().toString(36).slice(2));
    }
    const _tabId = sessionStorage.getItem(_TAB_KEY);

    /** 当前 tab 是否是"主控 tab"（即启动脚本的那个 tab） */
    function isMyTab() {
        return getState('tabId', '') === _tabId;
    }

    // ============================================================
    // Storage 工具
    // ============================================================
    const getCfg  = (k)    => GM_getValue(SK + 'cfg_' + k, DEFAULTS[k]);
    const setCfg  = (k, v) => GM_setValue(SK + 'cfg_' + k, v);
    const getState = (k, d) => GM_getValue(SK + 'st_' + k, d);
    const setState = (k, v) => GM_setValue(SK + 'st_' + k, v);

    // ============================================================
    // 工具
    // ============================================================
    const log     = (...a) => console.log('[LD]', ...a);
    const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // ── 排除列表：支持 topic id 数字 或 完整 URL ──────────────────
    const SK_EXCLUDE = SK + 'exclude';

    /** 从原始输入文本解析出规范化的 topic id 集合 */
    function parseExcludeInput(text) {
        const ids = new Set();
        text.split(/[\n,，;；\s]+/).forEach(raw => {
            const s = raw.trim();
            if (!s) return;
            // 完整URL：https://linux.do/t/xxx/847468 或 /t/xxx/847468
            const mUrl = s.match(/\/t\/[^/]+\/(\d+)/);
            if (mUrl) { ids.add(mUrl[1]); return; }
            // 纯数字
            if (/^\d+$/.test(s)) { ids.add(s); return; }
        });
        return ids;
    }

    /** 将 Set<id> 序列化存储 */
    function saveExcludeIds(idSet) {
        GM_setValue(SK_EXCLUDE, JSON.stringify([...idSet]));
    }

    /** 读取排除 id 集合 */
    function loadExcludeIds() {
        try { return new Set(JSON.parse(GM_getValue(SK_EXCLUDE, '[]'))); }
        catch (_) { return new Set(); }
    }

    /** 判断某个帖子 URL 是否在排除列表内 */
    function isExcluded(url, excludeIds) {
        const m = url.match(/\/t\/[^/]+\/(\d+)/);
        return m ? excludeIds.has(m[1]) : false;
    }

    // ============================================================
    // 样式
    // ============================================================
    GM_addStyle(`
        @keyframes ld-fi { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes ld-fo { from{opacity:1} to{opacity:0} }

        #ld-toast {
            position:fixed; bottom:82px; right:20px; z-index:2147483647;
            padding:10px 16px; border-radius:8px; color:#fff; font-size:13px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            box-shadow:0 4px 16px rgba(0,0,0,.25); max-width:280px; line-height:1.5;
            animation:ld-fi .2s ease; pointer-events:none;
        }
        #ld-toast.out { animation:ld-fo .3s ease forwards; }

        #ld-fab {
            position:fixed; bottom:24px; right:20px; z-index:2147483645;
            width:46px; height:46px; border-radius:50%;
            background:#2563eb; color:#fff; font-size:20px;
            line-height:46px; text-align:center; cursor:pointer;
            box-shadow:0 4px 14px rgba(37,99,235,.45);
            user-select:none; transition:transform .15s, background .15s;
        }
        #ld-fab:hover { transform:scale(1.12); }
        #ld-fab.running { background:#dc2626; box-shadow:0 4px 14px rgba(220,38,38,.45); }

        /* 状态条 */
        #ld-status-bar {
            position:fixed; top:0; left:0; right:0; z-index:2147483644;
            background:linear-gradient(90deg,#1e40af,#2563eb);
            color:#fff; font-size:12px; padding:5px 16px;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            display:flex; align-items:center; justify-content:space-between;
            box-shadow:0 2px 8px rgba(0,0,0,.2);
            animation:ld-fi .2s ease;
        }
        #ld-status-bar .ld-sb-left { display:flex; align-items:center; gap:10px; }
        #ld-status-bar .ld-sb-stop {
            background:rgba(255,255,255,.2); border:none; color:#fff;
            padding:3px 12px; border-radius:12px; cursor:pointer; font-size:12px;
        }
        #ld-status-bar .ld-sb-stop:hover { background:rgba(255,255,255,.35); }

        /* 配置面板 */
        #ld-panel-overlay {
            position:fixed; inset:0; z-index:2147483646;
            background:rgba(0,0,0,.45);
            display:flex; align-items:center; justify-content:center;
        }
        #ld-panel {
            background:#fff; border-radius:14px;
            box-shadow:0 12px 40px rgba(0,0,0,.2);
            padding:30px 34px; width:420px; max-width:95vw; max-height:90vh; overflow-y:auto;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#1a1a1a;
        }
        #ld-panel h2 { margin:0 0 18px; font-size:17px; font-weight:700; }
        #ld-panel .ld-seg {
            display:flex; border:1px solid #d5d5d5; border-radius:8px;
            overflow:hidden; margin-bottom:18px;
        }
        #ld-panel .ld-seg button {
            flex:1; padding:8px; border:none; background:#f9f9f9;
            font-size:13px; cursor:pointer; transition:background .15s;
        }
        #ld-panel .ld-seg button.active { background:#2563eb; color:#fff; font-weight:700; }
        #ld-panel .ld-row { margin-bottom:13px; }
        #ld-panel .ld-row label { display:block; font-size:12px; color:#555; margin-bottom:4px; }
        #ld-panel .ld-row input[type=number] {
            width:100%; box-sizing:border-box; padding:8px 10px;
            border:1px solid #d5d5d5; border-radius:7px; font-size:14px; outline:none;
        }
        #ld-panel .ld-row input[type=range] { width:100%; }
        #ld-panel .ld-hint { font-size:11px; color:#999; margin-top:3px; }
        #ld-panel .ld-check {
            display:flex; align-items:center; gap:8px;
            font-size:13px; color:#444; cursor:pointer; margin-bottom:10px;
        }
        #ld-panel .ld-check input { width:15px; height:15px; accent-color:#2563eb; }
        #ld-panel .ld-sec {
            font-size:11px; font-weight:700; color:#9ca3af;
            letter-spacing:.05em; text-transform:uppercase;
            border-top:1px solid #f0f0f0; padding-top:12px; margin:16px 0 10px;
        }
        #ld-panel .ld-speed-lbl {
            display:flex; justify-content:space-between; font-size:11px; color:#999; margin-top:2px;
        }
        #ld-panel .ld-btns {
            display:flex; gap:10px; justify-content:flex-end; margin-top:20px;
        }
        #ld-panel .ld-btns button {
            padding:8px 22px; border-radius:7px; font-size:13px; font-weight:600; cursor:pointer;
        }
        #ld-panel #ld-btn-cancel { background:#f3f4f6; color:#444; border:1px solid #d5d5d5; }
        #ld-panel #ld-btn-start  { background:#2563eb; color:#fff; border:none; }
        #ld-panel #ld-btn-start:hover { background:#1d4ed8; }
        #ld-panel .ld-mode-tour  { }
        #ld-panel .ld-mode-single{ }
    `);

    // ============================================================
    // Toast
    // ============================================================
    let _toastEl = null;
    function showToast(msg, type = 'info', duration = 2500) {
        if (_toastEl) { _toastEl.remove(); _toastEl = null; }
        const bg = { info:'#2563eb', success:'#16a34a', error:'#dc2626', warn:'#d97706' }[type] || '#2563eb';
        const el = document.createElement('div');
        el.id = 'ld-toast';
        el.style.background = bg;
        el.textContent = msg;
        document.body.appendChild(el);
        _toastEl = el;
        if (duration > 0) setTimeout(() => {
            el.classList.add('out');
            setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
        }, duration);
        return el;
    }

    // ============================================================
    // 状态条（巡游进行中时显示在顶部）
    // ============================================================
    function showStatusBar(text) {
        let bar = document.getElementById('ld-status-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'ld-status-bar';
            bar.innerHTML = `
                <div class="ld-sb-left">
                    <span>📖</span>
                    <span id="ld-sb-text"></span>
                </div>
                <button class="ld-sb-stop" id="ld-sb-stop">停止</button>
            `;
            document.body.appendChild(bar);
            bar.querySelector('#ld-sb-stop').onclick = () => stopTour(true);
        }
        bar.querySelector('#ld-sb-text').textContent = text;
    }
    function removeStatusBar() {
        const bar = document.getElementById('ld-status-bar');
        if (bar) bar.remove();
    }

    // ============================================================
    // 悬浮按钮
    // ============================================================

    /** 强制清除所有运行状态（用于残留状态恢复） */
    function forceReset() {
        setState('running', false);
        setState('mode',    '');
        setState('tabId',   '');
        clearListScrollTimer();
        clearScrollTimer();
        updateFab(false);
        removeStatusBar();
        showToast('🔄 已强制重置，可重新启动', 'success', 3000);
        log('强制重置完成');
    }

    function injectFab() {
        if (document.getElementById('ld-fab')) return;
        const fab = document.createElement('div');
        fab.id = 'ld-fab';
        fab.textContent = '📖';
        fab.title = '启动爬楼阅读器（长按强制重置）';

        // 长按计时器
        let _pressTimer = null;
        let _longPressed = false;
        fab.addEventListener('mousedown', () => {
            _longPressed = false;
            _pressTimer = setTimeout(() => {
                _pressTimer = null;
                _longPressed = true;
                forceReset();
            }, 800);
        });
        fab.addEventListener('mouseup',   () => { if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; } });
        fab.addEventListener('mouseleave',() => { if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; } });

        fab.onclick = () => {
            if (_longPressed) { _longPressed = false; return; } // 长按已触发，忽略 click
            const running = getState('running', false);
            if (running && isMyTab()) { stopTour(true); }
            else if (running && !isMyTab()) {
                showToast('⚠️ 状态被占用，如需重置请长按按钮', 'warn', 4000);
            }
            else { showConfigPanel(); }
        };
        document.body.appendChild(fab);
    }
    function updateFab(isRunning) {
        const f = document.getElementById('ld-fab');
        if (!f) return;
        const show = isRunning && isMyTab();
        if (show) {
            f.classList.add('running'); f.textContent = '⏹'; f.title = '停止爬楼';
        } else {
            f.classList.remove('running'); f.textContent = '📖'; f.title = '启动爬楼阅读器';
        }
    }

    // ============================================================
    // 配置面板
    // ============================================================
    function showConfigPanel() {
        if (document.getElementById('ld-panel-overlay')) return;

        // 当前保存的配置
        const cfg = {};
        Object.keys(DEFAULTS).forEach(k => { cfg[k] = getCfg(k); });

        const speedVal = Math.round(10 - ((cfg.scrollInterval - 200) / 1800) * 9);
        const savedMode = GM_getValue(SK + 'mode', 'tour'); // 'tour' | 'single'

        const overlay = document.createElement('div');
        overlay.id = 'ld-panel-overlay';
        overlay.innerHTML = `
        <div id="ld-panel">
            <h2>📖 Linux.do 爬楼阅读器</h2>

            <!-- 模式切换 -->
            <div class="ld-seg" id="ld-mode-seg">
                <button data-mode="tour"   class="${savedMode==='tour'?'active':''}">🗺️ 列表巡游</button>
                <button data-mode="single" class="${savedMode==='single'?'active':''}">📄 单帖浏览</button>
            </div>

            <!-- 列表巡游说明 -->
            <div id="ld-tour-hint" style="${savedMode!=='tour'?'display:none':''}">
                <div style="background:#eff6ff;border-radius:8px;padding:10px 12px;font-size:12px;color:#1d4ed8;margin-bottom:14px;line-height:1.6;">
                    在<b>列表页</b>启动后，脚本会先<b>自动滚动列表</b>模拟浏览，然后随机点入一个帖子阅读，读完返回列表再继续，全程拟人化操作。
                </div>
                <div class="ld-row">
                    <label>最多巡游帖子数（0 = 不限）</label>
                    <input id="ld-max-topics" type="number" min="0" value="${cfg.maxTopics}" />
                </div>
                <div class="ld-sec">列表页浏览行为</div>
                <div class="ld-row">
                    <label>列表页最短浏览时长（ms）</label>
                    <input id="ld-list-browse-min" type="number" min="1000" value="${cfg.listBrowseMin}" />
                    <div class="ld-hint">至少在列表上滚动浏览这么久再点帖子，建议 3000~6000</div>
                </div>
                <div class="ld-row">
                    <label>列表页最长浏览时长（ms）</label>
                    <input id="ld-list-browse-max" type="number" min="2000" value="${cfg.listBrowseMax}" />
                    <div class="ld-hint">随机在最短~最长之间决定何时点帖子，建议 8000~15000</div>
                </div>
                <div class="ld-row">
                    <label>帖子读完后等待返回列表（ms，实际 ±30%）</label>
                    <input id="ld-back-delay" type="number" min="500" value="${cfg.backDelay}" />
                    <div class="ld-hint">建议 1500~3000</div>
                </div>
            </div>

            <div class="ld-sec">滚动行为</div>
            <div class="ld-row">
                <label>阅读速度（1 慢 ～ 10 快）</label>
                <input id="ld-speed" type="range" min="1" max="10" value="${speedVal}" />
                <div class="ld-speed-lbl"><span>慢速（深读）</span><span>快速（浏览）</span></div>
                <div class="ld-hint">滚动距离会在设定值基础上随机浮动 ±50%，模拟真人滚轮</div>
            </div>
            <div class="ld-row">
                <label>单次滚动基准距离（px）</label>
                <input id="ld-step" type="number" min="50" max="1000" value="${cfg.scrollStep}" />
                <div class="ld-hint">建议 200~400，实际每次会随机偏移</div>
            </div>
            <div class="ld-row">
                <label>阅读停顿概率 %（建议 4~10）</label>
                <input id="ld-pause-chance" type="number" min="0" max="30" value="${Math.round(cfg.pauseChance*100)}" />
                <div class="ld-hint">偶发停顿模拟真人盯着某段文字细读</div>
            </div>
            <div class="ld-row">
                <label>回翻概率 %（建议 2~6）</label>
                <input id="ld-back-scroll-chance" type="number" min="0" max="20" value="${Math.round(cfg.backScrollChance*100)}" />
                <div class="ld-hint">偶发向上回滚一小段，模拟真人重看内容</div>
            </div>

            <div class="ld-sec">点赞行为</div>
            <label class="ld-check">
                <input id="ld-like-on" type="checkbox" ${cfg.likeEnabled?'checked':''} />
                启用随机点赞（低概率，模拟真人）
            </label>
            <div id="ld-like-opts" style="${cfg.likeEnabled?'':'display:none'}; padding-left:20px;">
                <div class="ld-row">
                    <label>点赞概率 %（建议 5~15）</label>
                    <input id="ld-like-chance" type="number" min="1" max="50" value="${Math.round(cfg.likeChance*100)}" />
                </div>
                <div class="ld-row">
                    <label>两次点赞最短间隔（ms，建议 ≥ 8000）</label>
                    <input id="ld-like-interval" type="number" min="2000" value="${cfg.likeInterval}" />
                </div>
            </div>

            <div class="ld-sec">排除帖子</div>
            <div class="ld-row">
                <label>不进入的帖子（每行一个，支持 topic id 或完整 URL）</label>
                <textarea id="ld-exclude" rows="4" placeholder="847468&#10;https://linux.do/t/topic/847468&#10;支持多种格式，逗号/换行/空格均可分隔"
                    style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5d5d5;border-radius:7px;font-size:13px;resize:vertical;outline:none;font-family:inherit;"
                >${Array.from(loadExcludeIds()).join('\n')}</textarea>
                <div class="ld-hint">填入后巡游时会自动跳过这些帖子</div>
            </div>

            <div class="ld-btns">
                <button id="ld-btn-cancel">取消</button>
                <button id="ld-btn-start">开始</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);

        // 模式切换
        overlay.querySelectorAll('#ld-mode-seg button').forEach(btn => {
            btn.onclick = () => {
                overlay.querySelectorAll('#ld-mode-seg button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                overlay.querySelector('#ld-tour-hint').style.display = btn.dataset.mode === 'tour' ? '' : 'none';
            };
        });

        // 点赞联动
        overlay.querySelector('#ld-like-on').onchange = function () {
            overlay.querySelector('#ld-like-opts').style.display = this.checked ? '' : 'none';
        };

        overlay.querySelector('#ld-btn-cancel').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        overlay.querySelector('#ld-btn-start').onclick = () => {
            const mode           = overlay.querySelector('#ld-mode-seg .active').dataset.mode;
            const speed          = parseInt(overlay.querySelector('#ld-speed').value);
            const step           = parseInt(overlay.querySelector('#ld-step').value) || 280;
            const pauseChPct     = parseInt(overlay.querySelector('#ld-pause-chance').value) || 6;
            const backScrollPct  = parseInt(overlay.querySelector('#ld-back-scroll-chance').value) || 4;
            const likeEn         = overlay.querySelector('#ld-like-on').checked;
            const likeChPct      = parseInt(overlay.querySelector('#ld-like-chance').value) || 12;
            const likeInt        = parseInt(overlay.querySelector('#ld-like-interval').value) || 9000;
            const maxTopics      = parseInt(overlay.querySelector('#ld-max-topics').value) || 0;
            const backDelay      = parseInt(overlay.querySelector('#ld-back-delay').value) || 1800;
            const listBrowseMin  = parseInt(overlay.querySelector('#ld-list-browse-min').value) || 4000;
            const listBrowseMax  = parseInt(overlay.querySelector('#ld-list-browse-max').value) || 10000;

            const excludeText    = overlay.querySelector('#ld-exclude').value;

            const interval = Math.round(2000 - ((speed - 1) / 9) * 1800);
            const jitter   = Math.round(interval * 0.4);

            setCfg('scrollInterval',    interval);
            setCfg('jitter',            jitter);
            setCfg('scrollStep',        Math.max(50, step));
            setCfg('pauseChance',       pauseChPct / 100);
            setCfg('backScrollChance',  backScrollPct / 100);
            setCfg('likeEnabled',       likeEn);
            setCfg('likeChance',        likeChPct / 100);
            setCfg('likeInterval',      Math.max(2000, likeInt));
            setCfg('maxTopics',         maxTopics);
            setCfg('backDelay',         Math.max(500, backDelay));
            setCfg('listBrowseMin',     Math.max(1000, listBrowseMin));
            setCfg('listBrowseMax',     Math.max(listBrowseMin + 1000, listBrowseMax));
            saveExcludeIds(parseExcludeInput(excludeText));
            GM_setValue(SK + 'mode', mode);

            overlay.remove();

            if (mode === 'tour') {
                startTourFromList();
            } else {
                startSingleBrowse();
            }
        };
    }

    // ============================================================
    // ★ 列表巡游模式
    // ============================================================

    /**
     * 从列表页当前 DOM 收集可见的真实帖子链接
     * Discourse 帖子链接格式：/t/{slug}/{数字id}
     */
    function collectTopicLinks() {
        const seen  = new Set();
        const links = [];
        const selectors = [
            'a.raw-topic-link[href]',
            'a.title.raw-link[href]',
            'a[data-topic-id][href]',
        ];
        for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(a => {
                const href  = a.getAttribute('href') || '';
                const match = href.match(/^(\/t\/[^/]+\/(\d+))(\/\d+)?$/);
                if (!match || !match[2]) return;
                const full = 'https://linux.do' + match[1];
                if (!seen.has(full)) { seen.add(full); links.push(full); }
            });
            if (links.length > 0) break;
        }
        log(`收集到 ${links.length} 个帖子链接`);
        return links;
    }

    // ── 列表页滚动浏览状态 ──────────────────────────────────────
    let _listScrollTimer  = null;
    let _listScrollRunning = false;
    let _listBrowseEnd    = 0;   // 该时间点后可以点帖子

    function clearListScrollTimer() {
        if (_listScrollTimer) { clearTimeout(_listScrollTimer); _listScrollTimer = null; }
        _listScrollRunning = false;
    }

    /**
     * 列表页滚动 tick：与帖子页类似，也有随机距离、停顿、回翻
     * 当达到预定浏览时长后，从当前可见帖子里随机挑一个点进去
     */
    function listScrollTick() {
        if (!_listScrollRunning) return;
        if (!getState('running', false) || !isMyTab()) { clearListScrollTimer(); return; }

        // 达到浏览时长 → 随机挑帖进入
        if (Date.now() >= _listBrowseEnd) {
            _listScrollRunning = false;
            pickAndEnterTopic();
            return;
        }

        // 偶发回翻
        if (Math.random() < getCfg('backScrollChance')) {
            const backPx = randInt(50, 180);
            window.scrollBy({ top: -backPx, behavior: 'smooth' });
            log(`[列表] ↑ 回翻 ${backPx}px`);
            _listScrollTimer = setTimeout(listScrollTick, randInt(500, 1200));
            return;
        }

        // 随机滚动距离
        const base    = getCfg('listScrollStep');
        const jitter  = Math.round(base * 0.5);
        const step    = Math.max(30, base + randInt(-jitter, jitter));
        window.scrollBy({ top: step, behavior: 'smooth' });

        // 偶发停顿（列表页停顿比帖子页短）
        if (Math.random() < getCfg('pauseChance')) {
            const pause = randInt(800, 2500);
            log(`[列表] ⏸ 停顿 ${pause}ms`);
            _listScrollTimer = setTimeout(listScrollTick, pause);
            return;
        }

        const interval = getCfg('listScrollInterval');
        const delay    = Math.max(interval + randInt(-Math.round(interval * 0.4), Math.round(interval * 0.4)), 80);
        _listScrollTimer = setTimeout(listScrollTick, delay);
    }

    /**
     * 开始列表页拟人浏览，browseDuration ms 后随机点帖
     */
    function startListBrowse(browseDuration) {
        clearListScrollTimer();
        _listScrollRunning = true;
        _listBrowseEnd = Date.now() + browseDuration;
        log(`[列表] 开始浏览列表，${(browseDuration/1000).toFixed(1)}s 后随机点帖`);
        showStatusBar(`浏览列表中，约 ${(browseDuration/1000).toFixed(0)}s 后随机进入帖子…`);
        listScrollTick();
    }

    /**
     * 从当前可见帖子中随机选一个未访问过的进入
     */
    function pickAndEnterTopic() {
        if (!getState('running', false) || !isMyTab()) return;

        const visited    = new Set(JSON.parse(getState('visited', '[]')));
        const excludeIds = loadExcludeIds();
        const all        = collectTopicLinks();
        const fresh      = all.filter(u => !visited.has(u) && !isExcluded(u, excludeIds));

        const total   = getState('total', 0);
        const max     = getCfg('maxTopics');

        // 达到上限
        if (max > 0 && total >= max) {
            finishTour();
            return;
        }

        if (fresh.length === 0) {
            // 当前列表没有未读帖子了
            showToast('✅ 当前列表帖子已全部阅读完毕', 'success', 0);
            finishTour();
            return;
        }

        // 随机挑一个
        const url = fresh[randInt(0, fresh.length - 1)];

        // 标记为已访问
        visited.add(url);
        setState('visited', JSON.stringify([...visited]));
        setState('total',   total + 1);
        setState('listUrl', location.href);

        log(`[列表] 随机选中第 ${total + 1} 帖：${url}`);
        showStatusBar(`即将进入第 ${total + 1} 帖…`);
        showToast(`🖱️ 随机选中帖子，即将进入…`, 'info', 1500);

        // 模拟思考后点击：随机延迟 300~900ms
        setTimeout(() => {
            if (!getState('running', false)) return;
            location.href = url;
        }, randInt(300, 900));
    }

    /** 在列表页启动巡游 */
    function startTourFromList() {
        if (!isListPage) {
            showToast('⚠️ 请在列表页（首页/latest/分类页）启动巡游模式', 'error', 4000);
            return;
        }

        // 初始化状态
        setState('running', true);
        setState('tabId',   _tabId);   // 绑定当前 tab
        setState('mode',    'tour');
        setState('total',   0);
        setState('visited', '[]');
        setState('listUrl', location.href);

        updateFab(true);
        showToast('🗺️ 开始列表巡游，先浏览列表…', 'info', 2500);
        log('巡游启动，开始列表浏览');

        // 随机决定本次浏览列表的时长
        const dur = randInt(getCfg('listBrowseMin'), getCfg('listBrowseMax'));
        startListBrowse(dur);
    }

    /** 全部巡游完成 */
    function finishTour() {
        setState('running', false);
        setState('mode',    '');
        clearListScrollTimer();
        updateFab(false);
        removeStatusBar();
        showToast(`✅ 巡游完成！共浏览 ${getState('total', 0)} 个帖子`, 'success', 0);
        log('巡游全部完成');
    }

    /** 停止巡游（用户手动） */
    function stopTour(showMsg = true) {
        setState('running', false);
        setState('mode',    '');
        clearListScrollTimer();
        updateFab(false);
        removeStatusBar();
        clearScrollTimer();
        if (showMsg) showToast('⏹ 已停止爬楼', 'warn', 2500);
        log('用户停止巡游');
    }

    // ============================================================
    // ★ 帖子页：自动滚动核心
    // ============================================================
    let _scrollTimer = null;
    let _lastLike    = 0;
    let _scrollRunning = false;

    function clearScrollTimer() {
        if (_scrollTimer) { clearTimeout(_scrollTimer); _scrollTimer = null; }
        _scrollRunning = false;
    }

    function isAtBottom() {
        return (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
    }

    async function tryLike() {
        if (!getCfg('likeEnabled')) return;
        if (Date.now() - _lastLike < getCfg('likeInterval')) return;
        if (Math.random() > getCfg('likeChance')) return;

        const btns = Array.from(document.querySelectorAll(
            '.topic-post .like-button:not(.has-like):not(.loading)'
        )).filter(btn => {
            const r = btn.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
        });

        if (!btns.length) return;
        btns[randInt(0, btns.length - 1)].click();
        _lastLike = Date.now();
        showToast('❤️ 点了个赞~', 'success', 1500);
        log('点赞 ✓');
    }

    async function scrollTick() {
        if (!_scrollRunning) return;

        // 到底了
        if (isAtBottom()) {
            _scrollRunning = false;
            const mode = getState('mode', '');

            if (mode === 'tour') {
                // 巡游模式：等待后返回列表（延迟也加随机抖动）
                const total      = getState('total', 0);
                const baseBack   = getCfg('backDelay');
                const actualBack = baseBack + randInt(-Math.round(baseBack * 0.3), Math.round(baseBack * 0.3));
                showToast(`✅ 第 ${total} 帖已读完，即将返回列表…`, 'success', actualBack);
                showStatusBar(`第 ${total} 帖读完，${(actualBack/1000).toFixed(1)}s 后返回列表…`);
                log(`帖子读完，${actualBack}ms 后返回`);

                setTimeout(() => {
                    if (!getState('running', false) || !isMyTab()) return;
                    const listUrl = getState('listUrl', '');
                    if (listUrl) { location.href = listUrl; } else { history.back(); }
                }, actualBack);
            } else {
                // 单帖模式：直接停
                showToast('✅ 已到达底部，爬楼完成！', 'success', 0);
                updateFab(false);
                setState('running', false);
            }
            return;
        }

        // ── 拟人化行为决策 ──────────────────────────────────────────

        // 1. 偶发"回翻"：低概率向上滚动一小段，模拟重新看上面的内容
        if (Math.random() < getCfg('backScrollChance')) {
            const backPx = randInt(60, 220);
            window.scrollBy({ top: -backPx, behavior: 'smooth' });
            log(`↑ 回翻 ${backPx}px`);
            // 回翻后停顿一下再继续向下
            const backPause = randInt(600, 1600);
            _scrollTimer = setTimeout(scrollTick, backPause);
            return;
        }

        // 2. 随机滚动距离：基准 ± 50%，模拟鼠标滚轮/触摸板不匀速
        const baseStep   = getCfg('scrollStep');
        const stepJitter = Math.round(baseStep * 0.5);
        const actualStep = Math.max(40, baseStep + randInt(-stepJitter, stepJitter));
        window.scrollBy({ top: actualStep, behavior: 'smooth' });

        // 3. 尝试点赞
        await tryLike();

        // 4. 偶发"阅读停顿"：模拟真人盯着某段内容读，停较长时间
        if (Math.random() < getCfg('pauseChance')) {
            const basePause   = getCfg('pauseDuration');
            const actualPause = basePause + randInt(-Math.round(basePause * 0.5), Math.round(basePause * 0.5));
            log(`⏸ 阅读停顿 ${actualPause}ms`);
            _scrollTimer = setTimeout(scrollTick, Math.max(actualPause, 500));
            return;
        }

        // 5. 正常间隔（时间也随机）
        const base   = getCfg('scrollInterval');
        const jitter = getCfg('jitter');
        const delay  = Math.max(base + randInt(-jitter, jitter), 80);
        _scrollTimer = setTimeout(scrollTick, delay);
    }

    function startScrolling(label) {
        if (_scrollRunning) return;
        _scrollRunning = true;
        _lastLike = 0;
        updateFab(true);
        showToast(label || '📖 滚动阅读中…', 'info', 2000);
        scrollTick();
    }

    // ============================================================
    // ★ 单帖模式（从帖子页直接启动）
    // ============================================================
    function startSingleBrowse() {
        if (!isTopicPage) {
            showToast('⚠️ 请在帖子页面使用单帖模式', 'error', 3000);
            return;
        }
        setState('running', true);
        setState('tabId',   _tabId);   // 绑定当前 tab
        setState('mode',    'single');
        startScrolling('📖 单帖模式，滚动中…');
    }

    // ============================================================
    // ★ 帖子页：检测巡游状态并自动开始
    // ============================================================
    let _topicStarted = false;  // 防止同一帖子页多次触发 startScrolling

    function handleTopicPageOnLoad() {
        if (!getState('running', false)) return;
        if (!isMyTab()) { log('[guard] 非主控tab，跳过帖子页自动执行'); return; }
        if (getState('mode', '') !== 'tour') return;
        if (_topicStarted) { log('[guard] handleTopicPageOnLoad 已执行，跳过重复调用'); return; }
        _topicStarted = true;

        const total = getState('total', 0);  // 已完成帖数（含本帖）
        const max   = getCfg('maxTopics');
        const label = max > 0 ? `第 ${total}/${max} 帖` : `第 ${total} 帖`;

        // 验证当前 URL 在已访问集合里，避免误触发
        const visited = new Set(JSON.parse(getState('visited', '[]')));
        const curBase = location.href.split('?')[0].replace(/\/+$/, '').replace(/\/\d+$/, '');
        const matched = [...visited].some(u => {
            const vBase = u.split('?')[0].replace(/\/+$/, '');
            return curBase === vBase || location.href.startsWith(vBase);
        });
        if (!matched) {
            log(`[guard] 当前URL不在已访问集合中，跳过`);
            _topicStarted = false;
            return;
        }

        showStatusBar(`${label}，阅读中…`);
        updateFab(true);

        waitForTopicContent().then(() => {
            if (!getState('running', false)) return;
            window.scrollTo(0, 0);
            startScrolling(`📖 ${label}，阅读中…`);
        });
    }

    /**
     * 等待帖子内容出现
     * Discourse 帖子里的楼层 DOM：.topic-post 或 article.post-article
     */
    function waitForTopicContent(timeout = 12000) {
        return new Promise(resolve => {
            const check = () => document.querySelector('.topic-post, article.post-article');
            if (check()) { resolve(); return; }
            const deadline = Date.now() + timeout;
            const t = setInterval(() => {
                if (check() || Date.now() > deadline) { clearInterval(t); resolve(); }
            }, 300);
        });
    }

    // ============================================================
    // ★ 列表页：检测巡游状态并继续（从帖子页返回后）
    // ============================================================
    function handleListPageOnLoad() {
        if (!getState('running', false)) return;
        if (!isMyTab()) { log('[guard] 非主控tab，跳过列表页自动执行'); return; }
        if (getState('mode', '') !== 'tour') return;

        const total = getState('total', 0);
        const max   = getCfg('maxTopics');

        if (max > 0 && total >= max) {
            finishTour();
            return;
        }

        updateFab(true);
        showToast(`⏭ 返回列表（已读 ${total} 帖），继续浏览…`, 'info', 2000);

        // 返回后先停一下，然后继续滚动列表再挑下一帖
        const pauseBeforeBrowse = randInt(800, 2000);
        setTimeout(() => {
            if (!getState('running', false)) return;
            const dur = randInt(getCfg('listBrowseMin'), getCfg('listBrowseMax'));
            startListBrowse(dur);
        }, pauseBeforeBrowse);
    }

    // ============================================================
    // 键盘快捷键 Alt+L
    // ============================================================
    document.addEventListener('keydown', e => {
        if (e.altKey && e.key.toLowerCase() === 'l') {
            if (getState('running', false) || _scrollRunning) {
                stopTour(true);
            } else {
                showConfigPanel();
            }
        }
    });

    // ============================================================
    // 入口
    // ============================================================

    // 防重入锁：记录当前正在处理的 URL，避免 SPA 同一 URL 多次触发
    let _handledTopicUrl = '';
    let _handledListUrl  = '';

    function init() {
        injectFab();

        const href = location.href;
        if (isTopicPage) {
            _handledTopicUrl = href;
            handleTopicPageOnLoad();
        } else if (isListPage) {
            _handledListUrl = href;
            handleListPageOnLoad();
        }

        log(`脚本已加载 [${isTopicPage ? '帖子页' : isListPage ? '列表页' : '其他页'}]`);
    }

    /**
     * 从 URL 中提取帖子 topic id
     * /t/slug/482293  或  /t/topic/482293/16  → '482293'
     * 返回 null 表示不是帖子页
     */
    function extractTopicId(url) {
        const m = url.match(/\/t\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // Discourse 是 SPA，需要监听路由变化
    let _lastHref = location.href;
    const _observer = new MutationObserver(() => {
        const curHref = location.href;
        if (curHref === _lastHref) return;   // URL 没有实际变化，忽略

        const prevHref = _lastHref;
        _lastHref = curHref;

        // ★ 关键：如果只是同一帖子内楼层号变化（/t/slug/id → /t/slug/id/16），完全忽略
        const prevId = extractTopicId(prevHref);
        const curId  = extractTopicId(curHref);
        if (prevId && curId && prevId === curId) {
            log(`[SPA] 帖子内楼层URL变化 (${prevHref} → ${curHref})，忽略`);
            return;
        }

        // 真正的页面跳转：清除当前滚动
        clearScrollTimer();

        setTimeout(() => {
            const nowHref  = location.href;  // 再取一次，防止 setTimeout 期间又跳
            const nowTopic = /^https:\/\/linux\.do\/t\//.test(nowHref);
            const nowList  = !nowTopic && /^https:\/\/linux\.do(\/|$)/.test(nowHref);

            if (nowTopic) {
                // 同一帖子 URL 已经处理过，跳过（防止 Discourse 内部 DOM 刷新重复触发）
                if (_handledTopicUrl === nowHref) {
                    log(`[SPA] 帖子URL未变 (${nowHref})，跳过重复触发`);
                    return;
                }
                _handledTopicUrl = nowHref;
                _handledListUrl  = '';      // 清除列表锁
                _topicStarted    = false;   // 新帖子，重置启动锁
                handleTopicPageOnLoad();
            } else if (nowList) {
                if (_handledListUrl === nowHref) {
                    log(`[SPA] 列表URL未变 (${nowHref})，跳过重复触发`);
                    return;
                }
                _handledListUrl  = nowHref;
                _handledTopicUrl = '';      // 清除帖子锁
                handleListPageOnLoad();
            }
        }, 800);
    });
    _observer.observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
