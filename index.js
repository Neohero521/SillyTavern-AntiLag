/**
 * AntiLag 流畅优化 —— SillyTavern 扩展
 * 目标：压低长聊天、复杂主题、移动端流式输出时的掉帧与长任务。
 * 思路：不做侵入式改写，只做「样式层的渲染减负」+「运行时体检与自动降级」。
 * 依赖：仅使用 SillyTavern.getContext() 稳定 API，不直接 import 内部模块。
 */

const MODULE_NAME = 'antilag';
const VERSION = '1.0.0';

/** 极速模式会被强制拉起的性能相关项 */
const BOOST_KEYS = ['virtualize', 'killBlur', 'killBgAnim', 'lazyImg'];

const DEFAULTS = {
    enabled: true,
    virtualize: true,
    killBlur: true,
    killShadow: false,
    killBgAnim: true,
    genLite: true,
    lazyImg: true,
    trimHistory: false,
    trimKeep: 120,
    autoDetect: true,
    fpsThreshold: 28,
    longTaskMs: 150,
    hud: true,
    hudPos: { x: null, y: null },
    notify: true,
};

const TOGGLES = [
    ['al-enabled', 'enabled'],
    ['al-genlite', 'genLite'],
    ['al-hud-on', 'hud'],
    ['al-notify', 'notify'],
    ['al-virtualize', 'virtualize'],
    ['al-killblur', 'killBlur'],
    ['al-killshadow', 'killShadow'],
    ['al-killbg', 'killBgAnim'],
    ['al-lazy', 'lazyImg'],
    ['al-trim', 'trimHistory'],
    ['al-auto', 'autoDetect'],
];

const state = {
    s: null,
    styleEl: null,
    panelEl: null,
    hudEl: null,
    mountTries: 0,
    observer: null,
    observerTarget: null,
    raf: 0,
    frames: 0,
    lastSec: 0,
    startedAt: 0,
    fps: 0,
    fpsHistory: [],
    lowStreak: 0,
    highStreak: 0,
    boost: false,
    longTasks: [],
    ltMax: 0,
    po: null,
    hudTimer: 0,
    sweepTimer: 0,
    trimExpanded: false,
    hudOpen: false,
    diagTick: 0,
    trimSig: '',
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function ctx() {
    try {
        return window.SillyTavern && typeof window.SillyTavern.getContext === 'function'
            ? window.SillyTavern.getContext()
            : null;
    } catch (err) {
        console.warn('[AntiLag] getContext 失败', err);
        return null;
    }
}

function settingsStore() {
    const c = ctx();
    if (c && c.extensionSettings) return c.extensionSettings;
    if (!window.extension_settings) window.extension_settings = {};
    return window.extension_settings;
}

function save() {
    const c = ctx();
    try {
        if (c && typeof c.saveSettingsDebounced === 'function') c.saveSettingsDebounced();
        else if (window.saveSettingsDebounced) window.saveSettingsDebounced();
    } catch (err) {
        console.warn('[AntiLag] 保存设置失败', err);
    }
}

function toast(kind, msg) {
    if (!state.s || !state.s.notify) return;
    const t = window.toastr;
    try {
        if (t && typeof t[kind] === 'function') {
            t[kind](msg, 'AntiLag');
            return;
        }
    } catch (err) { /* 忽略 toast 异常 */ }
    console.log('[AntiLag]', msg);
}

function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
}

function debounce(fn, ms) {
    let timer = 0;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

const isPerfOn = (key) => {
    const s = state.s;
    if (!s || !s.enabled) return false;
    return Boolean(s[key] || (state.boost && BOOST_KEYS.includes(key)));
};

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function loadSettings() {
    const store = settingsStore();
    const incoming = (store[MODULE_NAME] && typeof store[MODULE_NAME] === 'object') ? store[MODULE_NAME] : {};
    const s = Object.assign({}, DEFAULTS, incoming);

    s.hudPos = Object.assign({ x: null, y: null }, incoming.hudPos || {});
    s.trimKeep = clamp(parseInt(s.trimKeep, 10) || DEFAULTS.trimKeep, 10, 3000);
    s.fpsThreshold = clamp(parseInt(s.fpsThreshold, 10) || DEFAULTS.fpsThreshold, 10, 60);
    s.longTaskMs = clamp(parseInt(s.longTaskMs, 10) || DEFAULTS.longTaskMs, 50, 3000);

    store[MODULE_NAME] = s;
    state.s = s;
}

/* ------------------------------------------------------------------ */
/* 动态样式                                                            */
/* ------------------------------------------------------------------ */

function buildCss() {
    const s = state.s;
    if (!s || !s.enabled) return '';
    let css = '';

    if (isPerfOn('virtualize')) {
        css += [
            '/* AntiLag · 消息虚拟化：视口外的消息跳过布局与绘制 */',
            'body.antilag #chat .mes{content-visibility:auto;contain-intrinsic-size:auto 260px;will-change:auto;}',
            '',
        ].join('\n');
    }

    if (isPerfOn('killBlur')) {
        css += [
            '/* AntiLag · 关闭毛玻璃与滤镜（掉帧第一大户） */',
            'body.antilag #chat,body.antilag #chat *,body.antilag .drawer-content,body.antilag .drawer-content *{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
            'body.antilag #chat .mes,body.antilag #chat .mes *{filter:none !important;}',
            '',
        ].join('\n');
    }

    if (isPerfOn('killShadow')) {
        css += [
            '/* AntiLag · 关闭阴影 */',
            'body.antilag #chat .mes,body.antilag #chat .mes *{box-shadow:none !important;text-shadow:none !important;}',
            '',
        ].join('\n');
    }

    if (isPerfOn('killBgAnim')) {
        css += [
            '/* AntiLag · 停用动画背景与固定背景 */',
            'html.antilag body,body.antilag #chat,body.antilag #bg_custom,body.antilag .background{animation:none !important;background-attachment:scroll !important;}',
            '',
        ].join('\n');
    }

    if (s.genLite) {
        css += [
            '/* AntiLag · 生成中轻量渲染（只作用于最后一条消息） */',
            'body.antilag-gen #chat .last_mes,body.antilag-gen #chat .last_mes *{box-shadow:none !important;text-shadow:none !important;filter:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;transition:none !important;animation:none !important;}',
            '',
        ].join('\n');
    }

    if (s.trimHistory) {
        css += [
            '/* AntiLag · 历史消息折叠 */',
            '#chat .mes.al-trim{display:none !important;}',
            '',
        ].join('\n');
    }

    return css;
}

function ensureStyleEl() {
    if (state.styleEl && state.styleEl.isConnected) return state.styleEl;
    let el = document.getElementById('al-lite-style');
    if (!el) {
        el = document.createElement('style');
        el.id = 'al-lite-style';
        document.head.appendChild(el);
    }
    state.styleEl = el;
    return el;
}

/* ------------------------------------------------------------------ */
/* 应用与撤销                                                          */
/* ------------------------------------------------------------------ */

function applyAll() {
    if (!state.s || !document.body) return;

    const on = Boolean(state.s.enabled);
    document.documentElement.classList.toggle('antilag', on);
    document.body.classList.toggle('antilag', on);

    ensureStyleEl().textContent = on ? buildCss() : '';
    if (!on) document.body.classList.remove('antilag-gen');

    applyImages();
    applyTrim();
    if (state.hudEl) state.hudEl.style.display = state.s.hud ? '' : 'none';
    syncPanel();
    updateBadge();
    updateHud();
}

function applyImages() {
    if (!state.s || !state.s.enabled || !state.s.lazyImg) return;
    const imgs = document.querySelectorAll('#chat img:not([data-al-lazy])');
    imgs.forEach((img) => {
        img.dataset.alLazy = '1';
        if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
        if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
        img.classList.add('al-lazy');
    });
}

function applyTrim() {
    const chat = document.getElementById('chat');
    if (!chat) return;

    const s = state.s;
    const active = Boolean(s && s.enabled && s.trimHistory && !state.trimExpanded);
    const keep = clamp(parseInt(s && s.trimKeep, 10) || DEFAULTS.trimKeep, 10, 3000);
    const mes = Array.from(chat.querySelectorAll('.mes'));
    const sig = [mes.length, keep, active, state.trimExpanded].join('|');

    // 签名未变（例如流式输出期间反复触发扫描）直接跳过，避免 DOM 抖动
    if (state.trimSig === sig) return;
    state.trimSig = sig;

    chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
    chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));

    if (!active || mes.length <= keep) return;

    const cut = mes.length - keep;
    for (let i = 0; i < cut; i++) mes[i].classList.add('al-trim');

    const note = document.createElement('div');
    note.className = 'al-trim-note';
    note.innerHTML = `<span>已折叠 ${cut} 条较早消息，减轻渲染压力</span><button type="button">展开</button>`;
    const btn = note.querySelector('button');
    if (btn) {
        btn.addEventListener('click', () => {
            state.trimExpanded = true;
            chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));
            note.remove();
        });
    }
    mes[cut].before(note);
}

const scheduleSweep = debounce(() => {
    try {
        applyImages();
        applyTrim();
    } catch (err) {
        console.warn('[AntiLag] 扫描失败', err);
    }
}, 380);

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

function rowToggle(id, label, hint, key) {
    const checked = state.s[key] ? 'checked' : '';
    return `
        <div class="al-row">
            <div class="al-row-text">
                <label for="${id}">${label}</label>
                <span>${hint}</span>
            </div>
            <label class="al-switch ${checked ? 'is-on' : ''}">
                <input type="checkbox" id="${id}" ${checked}>
                <i></i>
            </label>
        </div>`;
}

function rowNumber(id, label, hint, value, unit, min, max, step) {
    return `
        <div class="al-row">
            <div class="al-row-text">
                <label for="${id}">${label}</label>
                <span>${hint}</span>
            </div>
            <div class="al-num">
                <input type="number" id="${id}" value="${value}" min="${min}" max="${max}" step="${step}">
                <span>${unit}</span>
            </div>
        </div>`;
}

function buildPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return false;

    const s = state.s;
    const el = document.createElement('div');
    el.className = 'al-panel';
    el.innerHTML = `
        <div class="al-head">
            <div class="al-logo">⚡</div>
            <div class="al-head-text">
                <b>AntiLag 流畅优化</b>
                <small>长聊天 / 复杂主题 / 移动端流式输出 · v${VERSION}</small>
            </div>
            <span class="al-badge" data-badge>待机</span>
        </div>
        <div class="al-body">
            <div class="al-group">基础</div>
            ${rowToggle('al-enabled', '启用 AntiLag', '总开关，关闭后所有注入样式立即移除', 'enabled')}
            ${rowToggle('al-genlite', '生成时轻量渲染', '流式输出时简化最后一条消息的阴影/滤镜/过渡', 'genLite')}
            ${rowToggle('al-hud-on', '显示悬浮仪表', '右下角可拖动的小球，实时看帧率', 'hud')}
            ${rowToggle('al-notify', '状态提示', '自动降级、一键优化时弹出轻提示', 'notify')}

            <div class="al-group">渲染减负</div>
            ${rowToggle('al-virtualize', '消息虚拟化', '视口外的消息跳过布局与绘制，长聊天收益最大', 'virtualize')}
            ${rowToggle('al-killblur', '关闭毛玻璃 / 滤镜', 'backdrop-filter 是掉帧第一大户，关闭后画面变朴素但明显更顺', 'killBlur')}
            ${rowToggle('al-killshadow', '关闭阴影', '去掉消息的 box-shadow / text-shadow，视效损失较小', 'killShadow')}
            ${rowToggle('al-killbg', '停用动画背景', '停掉背景动画与 fixed 背景，滚动更稳', 'killBgAnim')}
            ${rowToggle('al-lazy', '图片懒加载', '聊天内图片改为 lazy + async 解码，减少滚动解码卡顿', 'lazyImg')}

            <div class="al-group">历史管理</div>
            ${rowToggle('al-trim', '折叠较早消息', '只保留最近 N 条可见，更早的消息移出渲染树', 'trimHistory')}
            ${rowNumber('al-keep', '保留条数', '折叠时保留最近的可见消息数量', s.trimKeep, '条', 10, 3000, 10)}

            <div class="al-group">体检与自动降级</div>
            ${rowToggle('al-auto', '自动降级', '连续掉帧时临时启用极速渲染，恢复后自动退出', 'autoDetect')}
            ${rowNumber('al-fps', '掉帧阈值', '帧率连续低于该值即触发极速模式', s.fpsThreshold, 'FPS', 10, 60, 1)}
            ${rowNumber('al-long', '长任务提示线', '单次主线程阻塞超过该值即在体检中标红', s.longTaskMs, 'ms', 50, 3000, 10)}

            <div class="al-diag">
                <div class="al-diag-head">
                    <b>运行体检</b>
                    <button type="button" class="al-btn al-ghost" id="al-scan">重新检测</button>
                </div>
                <div class="al-diag-grid" data-grid></div>
                <div class="al-advice" data-advice></div>
            </div>

            <div class="al-actions">
                <button type="button" class="al-btn al-primary" id="al-optimize">立即优化</button>
                <button type="button" class="al-btn al-ghost" id="al-reset">恢复默认</button>
            </div>
            <div class="al-foot">不修改角色卡、世界书与任何扩展数据，只做渲染层减负。</div>
        </div>`;

    host.appendChild(el);
    state.panelEl = el;
    bindPanel();
    return true;
}

function bindPanel() {
    const el = state.panelEl;
    if (!el) return;

    TOGGLES.forEach(([id, key]) => {
        const input = el.querySelector('#' + id);
        if (!input) return;
        input.addEventListener('change', () => {
            state.s[key] = input.checked;
            input.closest('.al-switch')?.classList.toggle('is-on', input.checked);
            save();
            applyAll();
        });
    });

    const numbers = [
        ['al-keep', 'trimKeep', 10, 3000],
        ['al-fps', 'fpsThreshold', 10, 60],
        ['al-long', 'longTaskMs', 50, 3000],
    ];
    numbers.forEach(([id, key, min, max]) => {
        const input = el.querySelector('#' + id);
        if (!input) return;
        const commit = () => {
            const val = clamp(parseInt(input.value, 10) || DEFAULTS[key], min, max);
            state.s[key] = val;
            input.value = String(val);
            save();
            applyAll();
        };
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
    });

    el.querySelector('#al-optimize')?.addEventListener('click', optimize);
    el.querySelector('#al-reset')?.addEventListener('click', resetSettings);
    el.querySelector('#al-scan')?.addEventListener('click', () => renderDiagnostics());
}

function syncPanel() {
    const el = state.panelEl;
    if (!el || !state.s) return;
    TOGGLES.forEach(([id, key]) => {
        const input = el.querySelector('#' + id);
        if (!input) return;
        input.checked = Boolean(state.s[key]);
        input.closest('.al-switch')?.classList.toggle('is-on', input.checked);
    });
    const keep = el.querySelector('#al-keep');
    if (keep) keep.value = String(state.s.trimKeep);
    const fps = el.querySelector('#al-fps');
    if (fps) fps.value = String(state.s.fpsThreshold);
    const lt = el.querySelector('#al-long');
    if (lt) lt.value = String(state.s.longTaskMs);
    updateBadge();
}

function updateBadge() {
    const text = !state.s ? '待机' : (!state.s.enabled ? '已关闭' : (state.boost ? '极速' : '轻量'));
    if (state.panelEl) {
        const badge = state.panelEl.querySelector('[data-badge]');
        if (badge) {
            badge.textContent = text;
            badge.dataset.mode = state.boost ? 'boost' : (state.s.enabled ? 'on' : 'off');
        }
    }
}

function optimize() {
    if (!state.s) return;
    Object.assign(state.s, {
        enabled: true,
        virtualize: true,
        killBlur: true,
        genLite: true,
        lazyImg: true,
        killBgAnim: true,
        autoDetect: true,
    });
    save();
    applyAll();
    toast('success', '已应用推荐配置，画面会更朴素但更顺');
}

function resetSettings() {
    state.s = JSON.parse(JSON.stringify(DEFAULTS));
    settingsStore()[MODULE_NAME] = state.s;
    save();
    if (state.hudEl) {
        state.hudEl.style.left = '';
        state.hudEl.style.top = '';
        state.hudEl.style.right = '';
        state.hudEl.style.bottom = '';
    }
    applyAll();
    toast('info', '已恢复默认设置');
}

/* ------------------------------------------------------------------ */
/* 体检                                                                */
/* ------------------------------------------------------------------ */

function collectDiagnostics() {
    const c = ctx();
    const chatLen = c && Array.isArray(c.chat) ? c.chat.length : 0;
    const mesDom = document.querySelectorAll('#chat .mes').length;
    const nodes = document.querySelectorAll('*').length;
    const extCount = c && c.extensionSettings
        ? Object.keys(c.extensionSettings).filter((k) => k !== MODULE_NAME).length
        : 0;
    const imgCount = document.querySelectorAll('#chat img').length;

    let blurCount = 0;
    const sample = Array.from(document.querySelectorAll('#chat .mes')).slice(-40);
    for (const mes of sample) {
        const cs = getComputedStyle(mes);
        const bf = cs.backdropFilter || cs.webkitBackdropFilter;
        if ((bf && bf !== 'none') || (cs.filter && cs.filter !== 'none')) blurCount++;
    }

    let bgAnim = false;
    try {
        const cs = getComputedStyle(document.body);
        bgAnim = (cs.animationName && cs.animationName !== 'none')
            || (cs.backgroundAttachment && cs.backgroundAttachment.includes('fixed'));
    } catch (err) { /* 忽略 */ }

    return { chatLen, mesDom, nodes, extCount, imgCount, blurCount, bgAnim };
}

function renderDiagnostics() {
    const el = state.panelEl;
    if (!el) return;
    const grid = el.querySelector('[data-grid]');
    const advice = el.querySelector('[data-advice]');
    if (!grid || !advice) return;

    const d = collectDiagnostics();
    const s = state.s;
    const fps = state.fps || 0;
    const lt = recentLongTasks();

    const items = [
        ['帧率', fps ? `${fps} FPS` : '采样中', fps && fps < s.fpsThreshold ? 'bad' : (fps && fps < 48 ? 'warn' : 'ok')],
        ['消息条数', String(d.chatLen || d.mesDom), (d.chatLen || d.mesDom) > 300 ? 'warn' : 'ok'],
        ['DOM 节点', String(d.nodes), d.nodes > 4000 ? 'warn' : 'ok'],
        ['10s 长任务', `${lt.count} 次 / 最长 ${Math.round(lt.max)}ms`, lt.max > s.longTaskMs ? 'bad' : 'ok'],
        ['毛玻璃元素', String(d.blurCount), d.blurCount > 0 ? 'warn' : 'ok'],
        ['动画背景', d.bgAnim ? '存在' : '无', d.bgAnim ? 'warn' : 'ok'],
        ['聊天图片', String(d.imgCount), 'ok'],
        ['已启用扩展', String(d.extCount), d.extCount > 10 ? 'warn' : 'ok'],
    ];

    grid.innerHTML = items.map(([k, v, level]) => `
        <div class="al-kv" data-level="${level}">
            <span>${k}</span><b>${v}</b>
        </div>`).join('');

    const tips = [];
    if ((d.chatLen || d.mesDom) > 300 && !s.virtualize) tips.push('长聊天建议开启「消息虚拟化」');
    if (d.blurCount > 0 && !s.killBlur) tips.push('检测到毛玻璃/模糊，建议开启「关闭毛玻璃」');
    if (d.bgAnim && !s.killBgAnim) tips.push('检测到动画背景，建议停用动画背景');
    if (fps && fps < s.fpsThreshold) tips.push('当前帧率偏低，可直接点「立即优化」');
    if (lt.max > s.longTaskMs) tips.push(`存在 ${Math.round(lt.max)}ms 的主线程长任务，多为大聊天渲染或重扩展造成`);
    if (d.extCount > 10) tips.push(`已启用 ${d.extCount} 个扩展，建议逐个排查占用（尤其带定时器的扩展）`);
    if (!tips.length) tips.push('当前状态良好，保持现有配置即可');

    advice.innerHTML = tips.map((t) => `<div class="al-tip">· ${t}</div>`).join('');
}

/* ------------------------------------------------------------------ */
/* 悬浮仪表                                                            */
/* ------------------------------------------------------------------ */

function buildHud() {
    if (state.hudEl) return;
    const el = document.createElement('div');
    el.className = 'al-hud';
    el.dataset.open = 'false';
    el.dataset.state = 'good';
    el.innerHTML = `
        <div class="al-hud-card">
            <div class="al-hud-row"><span>帧率</span><b data-v-fps>--</b></div>
            <div class="al-hud-row"><span>长任务 10s</span><b data-v-lt>0</b></div>
            <div class="al-hud-row"><span>消息</span><b data-v-msg>0</b></div>
            <div class="al-hud-actions">
                <button type="button" class="al-btn al-primary al-boost">立即优化</button>
                <button type="button" class="al-btn al-ghost al-goto">设置</button>
            </div>
        </div>
        <div class="al-hud-pill" title="拖动可移动 / 轻点展开">
            <span class="al-hud-dot"></span>
            <span class="al-hud-fps" data-v-pill>--</span>
            <span class="al-hud-unit">FPS</span>
        </div>`;
    document.body.appendChild(el);
    state.hudEl = el;
    restoreHudPos();

    const pill = el.querySelector('.al-hud-pill');
    const card = el.querySelector('.al-hud-card');
    if (pill) makeDraggable(el, pill, card);

    el.querySelector('.al-boost')?.addEventListener('click', (e) => {
        e.stopPropagation();
        optimize();
    });
    el.querySelector('.al-goto')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettingsDrawer();
    });

    document.addEventListener('pointerdown', (e) => {
        if (!state.hudOpen) return;
        if (el.contains(e.target)) return;
        setHudOpen(false);
    }, true);
}

function setHudOpen(open) {
    state.hudOpen = Boolean(open);
    if (state.hudEl) state.hudEl.dataset.open = state.hudOpen ? 'true' : 'false';
}

function makeDraggable(el, handle, card) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        const r = el.getBoundingClientRect();
        originX = r.left;
        originY = r.top;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = originX + 'px';
        el.style.top = originY + 'px';
        el.classList.add('is-dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) moved = true;
        if (!moved) return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const nx = clamp(originX + dx, 4, window.innerWidth - w - 4);
        const ny = clamp(originY + dy, 4, window.innerHeight - h - 4);
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
        e.preventDefault();
    }, { passive: false });

    const finish = () => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('is-dragging');
        if (moved) {
            const r = el.getBoundingClientRect();
            state.s.hudPos = { x: Math.round(r.left), y: Math.round(r.top) };
            save();
        } else {
            setHudOpen(!state.hudOpen);
            if (state.hudOpen) renderHudCard();
        }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', () => {
        dragging = false;
        el.classList.remove('is-dragging');
    });
}

function restoreHudPos() {
    if (!state.hudEl) return;
    const p = state.s && state.s.hudPos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        state.hudEl.style.right = 'auto';
        state.hudEl.style.bottom = 'auto';
        state.hudEl.style.left = clamp(p.x, 4, Math.max(4, window.innerWidth - 70)) + 'px';
        state.hudEl.style.top = clamp(p.y, 4, Math.max(4, window.innerHeight - 70)) + 'px';
    }
}

function renderHudCard() {
    if (!state.hudEl) return;
    const lt = recentLongTasks();
    const c = ctx();
    const msgs = c && Array.isArray(c.chat) ? c.chat.length : document.querySelectorAll('#chat .mes').length;
    state.hudEl.querySelector('[data-v-fps]').textContent = state.fps ? `${state.fps}` : '--';
    state.hudEl.querySelector('[data-v-lt]').textContent = String(lt.count);
    state.hudEl.querySelector('[data-v-msg]').textContent = String(msgs);
}

function recentLongTasks() {
    const now = performance.now();
    state.longTasks = state.longTasks.filter((t) => now - t.t < 10000);
    const max = state.longTasks.reduce((acc, t) => Math.max(acc, t.d), 0);
    return { count: state.longTasks.length, max };
}

function updateHud() {
    const el = state.hudEl;
    if (!el || !state.s) return;
    const pill = el.querySelector('[data-v-pill]');
    if (pill) pill.textContent = state.fps ? String(state.fps) : '--';
    if (!state.s.enabled) el.dataset.state = 'off';
    else if (!state.fps) el.dataset.state = 'good';
    else if (state.fps < state.s.fpsThreshold) el.dataset.state = 'bad';
    else if (state.fps < 48) el.dataset.state = 'warn';
    else el.dataset.state = 'good';
    if (state.hudOpen) renderHudCard();
}

function openSettingsDrawer() {
    setHudOpen(false);
    const btn = document.getElementById('extensions-settings-button');
    if (btn && !document.getElementById('right-nav-panel')?.classList.contains('openDrawer')) {
        btn.click();
    }
    setTimeout(() => {
        if (state.panelEl) {
            state.panelEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            state.panelEl.classList.add('al-flash');
            setTimeout(() => state.panelEl?.classList.remove('al-flash'), 900);
        }
    }, 420);
}

/* ------------------------------------------------------------------ */
/* 监控                                                                */
/* ------------------------------------------------------------------ */

function startMonitor() {
    if (state.raf) return;
    state.startedAt = performance.now();
    state.lastSec = state.startedAt;

    const loop = (t) => {
        state.raf = requestAnimationFrame(loop);
        if (document.hidden) {
            state.frames = 0;
            state.lastSec = t;
            return;
        }
        state.frames++;
        const delta = t - state.lastSec;
        if (delta >= 1000) {
            const fps = Math.round((state.frames * 1000) / delta);
            state.frames = 0;
            state.lastSec = t;
            onFps(fps);
        }
    };
    state.raf = requestAnimationFrame(loop);

    try {
        const po = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                state.longTasks.push({ t: entry.startTime, d: entry.duration });
                if (entry.duration > state.ltMax) state.ltMax = entry.duration;
            }
            if (state.longTasks.length > 60) state.longTasks.splice(0, state.longTasks.length - 60);
        });
        po.observe({ entryTypes: ['longtask'] });
        state.po = po;
    } catch (err) {
        // 部分浏览器不支持 longtask，忽略即可
    }

    if (state.hudTimer) clearInterval(state.hudTimer);
    state.hudTimer = setInterval(() => {
        updateHud();
        // 抽屉打开时每 5 秒刷新一次体检，避免体检本身成为负担
        state.diagTick++;
        if (state.diagTick >= 5) {
            state.diagTick = 0;
            if (state.panelEl && document.getElementById('right-nav-panel')?.classList.contains('openDrawer')) {
                renderDiagnostics();
            }
        }
    }, 1000);
}

function onFps(fps) {
    state.fps = fps;
    state.fpsHistory.push(fps);
    if (state.fpsHistory.length > 30) state.fpsHistory.shift();

    const s = state.s;
    if (!s || !s.enabled || !s.autoDetect || fps <= 0) return;
    if (performance.now() - state.startedAt < 4000) return; // 冷启动抖动忽略

    if (fps < s.fpsThreshold) {
        state.lowStreak++;
        state.highStreak = 0;
        if (state.lowStreak >= 3 && !state.boost) enableBoost();
    } else if (fps >= s.fpsThreshold + 10) {
        state.highStreak++;
        state.lowStreak = 0;
        if (state.highStreak >= 12 && state.boost) disableBoost();
    } else {
        state.lowStreak = 0;
        state.highStreak = 0;
    }
}

function enableBoost() {
    if (state.boost) return;
    state.boost = true;
    applyAll();
    toast('warning', `检测到掉帧（${state.fps} FPS），已临时启用极速渲染`);
}

function disableBoost() {
    if (!state.boost) return;
    state.boost = false;
    applyAll();
    toast('info', '帧率已恢复，退出极速模式');
}

/* ------------------------------------------------------------------ */
/* 事件与挂载                                                          */
/* ------------------------------------------------------------------ */

function observeChat() {
    const chat = document.getElementById('chat');
    if (!chat) {
        setTimeout(observeChat, 800);
        return;
    }
    if (state.observer && state.observerTarget === chat) return;
    if (state.observer) state.observer.disconnect();
    state.observerTarget = chat;
    state.observer = new MutationObserver(() => {
        scheduleSweep();
    });
    state.observer.observe(chat, { childList: true, subtree: true });
    scheduleSweep();
}

function mountUi() {
    if (!document.body || !state.s) return;
    try {
        if (!state.panelEl && buildPanel()) {
            renderDiagnostics();
            syncPanel();
        }
        if (!state.hudEl) buildHud();
        if (state.s && state.s.hud && state.hudEl) state.hudEl.style.display = '';
        if (!state.panelEl && state.mountTries < 30) {
            state.mountTries++;
            setTimeout(mountUi, 600);
        }
    } catch (err) {
        console.error('[AntiLag] 挂载 UI 失败', err);
    }
}

function registerEvents() {
    const c = ctx();
    if (!c || !c.eventSource || typeof c.eventSource.on !== 'function') return;
    const et = c.eventTypes || {};
    const es = c.eventSource;
    const on = (name, fn) => {
        const type = et[name];
        if (!type) return;
        try { es.on(type, fn); } catch (err) { /* 忽略 */ }
    };

    on('APP_READY', () => { state.mountTries = 0; mountUi(); observeChat(); });
    on('APP_INITIALIZED', () => { mountUi(); });
    on('CHAT_CHANGED', () => {
        state.trimExpanded = false;
        applyAll();
        scheduleSweep();
    });
    on('MESSAGE_RECEIVED', scheduleSweep);
    on('MESSAGE_SENT', scheduleSweep);
    on('USER_MESSAGE_RENDERED', scheduleSweep);
    on('CHARACTER_MESSAGE_RENDERED', scheduleSweep);
    on('MORE_MESSAGES_LOADED', scheduleSweep);
    on('GENERATION_STARTED', () => {
        if (state.s && state.s.enabled && state.s.genLite) document.body.classList.add('antilag-gen');
        else document.body.classList.remove('antilag-gen');
    });
    on('GENERATION_ENDED', () => document.body.classList.remove('antilag-gen'));
    on('GENERATION_STOPPED', () => document.body.classList.remove('antilag-gen'));
}

function init() {
    try {
        loadSettings();
        applyAll();
        mountUi();
        observeChat();
        registerEvents();
        startMonitor();

        window.addEventListener('resize', () => {
            if (!state.hudEl) return;
            const r = state.hudEl.getBoundingClientRect();
            if (r.left + r.width > window.innerWidth || r.top + r.height > window.innerHeight) {
                state.hudEl.style.left = clamp(r.left, 4, Math.max(4, window.innerWidth - r.width - 4)) + 'px';
                state.hudEl.style.top = clamp(r.top, 4, Math.max(4, window.innerHeight - r.height - 4)) + 'px';
            }
        });

        console.log(`[AntiLag] v${VERSION} ready`);
    } catch (err) {
        console.error('[AntiLag] 初始化失败', err);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}

/** 生命周期钩子：被禁用时立即撤销所有注入 */
export function onDisable() {
    if (!state.s) return;
    state.s.enabled = false;
    applyAll();
}
