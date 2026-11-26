/**
 * AntiLag 流畅优化 v1.1 —— SillyTavern 扩展
 *
 * 设计原则：
 * 1) 默认「轻度」模式视觉零改动，只做不改变观感的减负；
 * 2) 所有结构性操作（折叠/裁剪）默认关闭，且编辑消息时暂停；
 * 3) 切换任何样式前保存 #chat 滚动位置，避免跳位；
 * 4) 自动降级只动「视觉开销」，不隐藏任何内容。
 * 依赖：仅 SillyTavern.getContext() 稳定 API。
 */

const MODULE_NAME = 'antilag';
const VERSION = '1.1.0';

/** 三档预设（只描述开关，不包含阈值） */
const PRESETS = {
    lite: {
        virtualize: true, lazyImg: true, genLite: true, willChange: true, lazyFrame: false,
        killBlur: false, killBgAnim: false, killShadow: false, killTransitions: false,
        containChat: false, trimHistory: false, clipLong: false,
    },
    standard: {
        virtualize: true, lazyImg: true, genLite: true, willChange: true, lazyFrame: true,
        killBlur: true, killBgAnim: true, killShadow: false, killTransitions: false,
        containChat: false, trimHistory: false, clipLong: false,
    },
    turbo: {
        virtualize: true, lazyImg: true, genLite: true, willChange: true, lazyFrame: true,
        killBlur: true, killBgAnim: true, killShadow: true, killTransitions: true,
        containChat: true, trimHistory: true, clipLong: false,
    },
};

const MODE_LABEL = { lite: '轻度', standard: '均衡', turbo: '极速' };

/** 极速模式（含自动降级）会额外拉起的纯视觉项 */
const BOOST_KEYS = ['virtualize', 'killBlur', 'killBgAnim', 'killShadow', 'killTransitions', 'willChange', 'containChat'];
const VISUAL_KEYS = Object.keys(PRESETS.turbo);

const DEFAULTS = {
    enabled: true,
    mode: 'lite',

    virtualize: true,
    virtualizeMin: 120,
    genLite: true,
    lazyImg: true,
    lazyFrame: false,
    willChange: true,

    killBlur: false,
    killBlurAll: false,
    killBgAnim: false,
    killShadow: false,
    killTransitions: false,
    containChat: false,

    trimHistory: false,
    trimKeep: 100,
    clipLong: false,
    clipChars: 3000,

    pauseOnEdit: true,
    preserveScroll: true,

    autoDetect: true,
    fpsThreshold: 28,
    longTaskMs: 150,

    hud: true,
    hudPos: { x: null, y: null },
    notify: true,
    pausedUntil: 0,
};

const TOGGLES = [
    ['al-enabled', 'enabled'],
    ['al-pause-on-edit', 'pauseOnEdit'],
    ['al-preserve-scroll', 'preserveScroll'],
    ['al-auto', 'autoDetect'],
    ['al-genlite', 'genLite'],
    ['al-virtualize', 'virtualize'],
    ['al-lazy', 'lazyImg'],
    ['al-lazyframe', 'lazyFrame'],
    ['al-willchange', 'willChange'],
    ['al-killblur', 'killBlur'],
    ['al-killblur-all', 'killBlurAll'],
    ['al-killbg', 'killBgAnim'],
    ['al-killshadow', 'killShadow'],
    ['al-killtrans', 'killTransitions'],
    ['al-contain', 'containChat'],
    ['al-trim', 'trimHistory'],
    ['al-clip', 'clipLong'],
    ['al-hud-on', 'hud'],
    ['al-notify', 'notify'],
];

const NUMBERS = [
    ['al-vmin', 'virtualizeMin', 30, 500],
    ['al-keep', 'trimKeep', 10, 3000],
    ['al-clipchars', 'clipChars', 500, 20000],
    ['al-fps', 'fpsThreshold', 10, 60],
    ['al-long', 'longTaskMs', 50, 3000],
];

const state = {
    s: null,
    styleEl: null,
    panelEl: null,
    hudEl: null,
    mountTries: 0,
    observer: null,
    observerTarget: null,
    observerOn: false,
    raf: 0,
    frames: 0,
    lastSec: 0,
    startedAt: 0,
    fps: 0,
    lowStreak: 0,
    highStreak: 0,
    boost: false,
    longTasks: [],
    ltMax: 0,
    po: null,
    tickTimer: 0,
    diagTick: 0,
    trimSig: '',
    trimExpanded: false,
    hudOpen: false,
    generating: false,
    genLt: 0,
    lastGenLt: 0,
    mesCount: 0,
    applyQueued: false,
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

function isPaused() {
    return Boolean(state.s && state.s.pausedUntil && Date.now() < state.s.pausedUntil);
}

function isOn() {
    return Boolean(state.s && state.s.enabled && !isPaused());
}

function isEditing() {
    const ta = document.getElementById('curEditTextarea');
    if (ta && ta.getClientRects().length > 0) return true;
    if (document.querySelector('.mes_text[contenteditable="true"]')) return true;
    return false;
}

function hasChatSelection() {
    try {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.isCollapsed || !sel.anchorNode) return false;
        const chat = chatEl();
        if (!chat) return false;
        const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
        return chat.contains(node);
    } catch (err) {
        return false;
    }
}

/** 用户正在编辑或选中聊天文本时，结构性优化让路 */
function isBusy() {
    return isEditing() || hasChatSelection();
}

function chatEl() {
    return document.getElementById('chat');
}

function countMessages() {
    const chat = chatEl();
    return chat ? chat.querySelectorAll('.mes').length : 0;
}

const eff = (key) => Boolean(state.s && (state.s[key] || (state.boost && BOOST_KEYS.includes(key))));

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function loadSettings() {
    const store = settingsStore();
    const incoming = (store[MODULE_NAME] && typeof store[MODULE_NAME] === 'object') ? store[MODULE_NAME] : {};
    const s = Object.assign({}, DEFAULTS, incoming);

    s.hudPos = Object.assign({ x: null, y: null }, incoming.hudPos || {});
    s.virtualizeMin = clamp(parseInt(s.virtualizeMin, 10) || DEFAULTS.virtualizeMin, 30, 500);
    s.trimKeep = clamp(parseInt(s.trimKeep, 10) || DEFAULTS.trimKeep, 10, 3000);
    s.clipChars = clamp(parseInt(s.clipChars, 10) || DEFAULTS.clipChars, 500, 20000);
    s.fpsThreshold = clamp(parseInt(s.fpsThreshold, 10) || DEFAULTS.fpsThreshold, 10, 60);
    s.longTaskMs = clamp(parseInt(s.longTaskMs, 10) || DEFAULTS.longTaskMs, 50, 3000);
    if (!PRESETS[s.mode] && s.mode !== 'custom') s.mode = DEFAULTS.mode;

    // 过期暂停自动清除
    if (s.pausedUntil && Date.now() >= s.pausedUntil) s.pausedUntil = 0;

    store[MODULE_NAME] = s;
    state.s = s;
}

/* ------------------------------------------------------------------ */
/* 动态样式                                                            */
/* ------------------------------------------------------------------ */

function buildCss() {
    const s = state.s;
    if (!s || !isOn()) return '';
    let css = '';

    if (document.body.classList.contains('antilag-virt')) {
        css += [
            '/* 消息虚拟化：视口外消息跳过布局与绘制（仅在超过阈值时生效） */',
            'body.antilag-virt #chat .mes{content-visibility:auto;contain-intrinsic-size:auto 240px;will-change:auto;}',
            '',
        ].join('\n');
    }

    if (eff('killBlur')) {
        if (s.killBlurAll) {
            css += [
                '/* 关闭全界面毛玻璃与滤镜 */',
                'body.antilag *,body.antilag *::before,body.antilag *::after{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
                'body.antilag #chat .mes,body.antilag #chat .mes *,body.antilag .drawer-content,body.antilag .drawer-content *{filter:none !important;}',
                '',
            ].join('\n');
        } else {
            css += [
                '/* 关闭聊天区毛玻璃与滤镜（不动其它界面） */',
                'body.antilag #chat,body.antilag #chat *,body.antilag #chat *::before,body.antilag #chat *::after,body.antilag #form_sheld{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
                'body.antilag #chat .mes,body.antilag #chat .mes *{filter:none !important;}',
                '',
            ].join('\n');
        }
    }

    if (eff('killBgAnim')) {
        css += [
            '/* 停用动画背景与 fixed 背景 */',
            'html.antilag body,body.antilag #chat,body.antilag #bg_custom,body.antilag .background{animation:none !important;background-attachment:scroll !important;}',
            '',
        ].join('\n');
    }

    if (eff('killShadow')) {
        css += [
            '/* 关闭消息阴影与发光 */',
            'body.antilag #chat .mes,body.antilag #chat .mes *{box-shadow:none !important;text-shadow:none !important;}',
            '',
        ].join('\n');
    }

    if (eff('killTransitions')) {
        css += [
            '/* 关闭消息区的过渡与关键帧动画 */',
            'body.antilag #chat .mes,body.antilag #chat .mes *{transition:none !important;animation-duration:0s !important;}',
            '',
        ].join('\n');
    }

    if (eff('willChange')) {
        css += [
            '/* 清理被滥用的 will-change，回收 GPU 图层（移动端收益明显） */',
            'body.antilag #chat *{will-change:auto !important;}',
            '',
        ].join('\n');
    }

    if (document.body.classList.contains('antilag-contain')) {
        css += [
            '/* 隔离聊天区的布局与绘制，避免抽屉/输入框重排牵连 */',
            'body.antilag-contain #chat{contain:layout style;overscroll-behavior:contain;}',
            '',
        ].join('\n');
    }

    if (s.genLite) {
        css += [
            '/* 生成中：隔离最后一条消息的重绘，并去掉其重特效 */',
            'body.antilag-gen #chat .last_mes{contain:layout paint style;}',
            'body.antilag-gen #chat .last_mes,body.antilag-gen #chat .last_mes *{box-shadow:none !important;text-shadow:none !important;filter:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;transition:none !important;animation:none !important;}',
            '',
        ].join('\n');
    }

    if (s.trimHistory) {
        css += ['/* 历史折叠 */', '#chat .mes.al-trim{display:none !important;}', ''].join('\n');
    }

    if (s.clipLong) {
        css += [
            '/* 超长单条消息裁剪显示 */',
            '.mes.al-clip .mes_text{max-height:46vh;overflow:hidden;}',
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

function swapStyle(css) {
    const style = ensureStyleEl();
    if (style.textContent === css) return;
    const chat = chatEl();
    const top = chat ? chat.scrollTop : null;
    style.textContent = css;
    if (chat && top !== null && state.s.preserveScroll) {
        // 只在发生明显位移时回填，避免无谓的同步布局
        if (Math.abs(chat.scrollTop - top) > 1) chat.scrollTop = top;
    }
}

/** 只根据当前消息数开关虚拟化闸门，供消息增长时高频调用 */
function refreshVirtGate() {
    if (!state.s || !document.body) return;
    const on = isOn();
    const mes = countMessages();
    state.mesCount = mes;
    const virt = on && eff('virtualize') && mes >= state.s.virtualizeMin;
    if (document.body.classList.contains('antilag-virt') === virt) return;
    document.body.classList.toggle('antilag-virt', virt);
    swapStyle(on ? buildCss() : '');
}

/* ------------------------------------------------------------------ */
/* 应用与撤销                                                          */
/* ------------------------------------------------------------------ */

function applyAll() {
    if (!state.s || !document.body) return;
    state.applyQueued = false;

    const on = isOn();
    const mes = countMessages();
    state.mesCount = mes;
    const virt = on && eff('virtualize') && mes >= state.s.virtualizeMin;

    document.documentElement.classList.toggle('antilag', on);
    document.body.classList.toggle('antilag', on);
    document.body.classList.toggle('antilag-virt', virt);
    document.body.classList.toggle('antilag-contain', on && eff('containChat'));
    if (!on) document.body.classList.remove('antilag-gen');

    swapStyle(on ? buildCss() : '');
    if (!on) {
        clearStructural();
    } else {
        applyImages();
        applyTrim();
        applyClip();
    }

    if (state.hudEl) state.hudEl.style.display = state.s.hud ? '' : 'none';
    syncPanel();
    updateBadge();
    updateHud();
}

function queueApply() {
    if (state.applyQueued) return;
    state.applyQueued = true;
    requestAnimationFrame(() => {
        state.applyQueued = false;
        applyAll();
    });
}

function clearStructural() {
    const chat = chatEl();
    if (!chat) return;
    chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
    chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));
    chat.querySelectorAll('.mes.al-clip').forEach((el) => el.classList.remove('al-clip'));
    chat.querySelectorAll('.al-clip-btn').forEach((el) => el.remove());
}

function applyImages() {
    if (!eff('lazyImg')) return;
    document.querySelectorAll('#chat img:not([data-al-lazy])').forEach((img) => {
        img.dataset.alLazy = '1';
        if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
        if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
        img.classList.add('al-lazy');
    });
    if (eff('lazyFrame')) {
        document.querySelectorAll('#chat iframe:not([data-al-lazy])').forEach((frame) => {
            frame.dataset.alLazy = '1';
            frame.setAttribute('loading', 'lazy');
        });
    }
}

/** 结构性改动（折叠/裁剪）前后护住滚动位置：贴底时保持贴底，否则保持视口内容 */
function withChatScroll(fn) {
    const chat = chatEl();
    if (!chat) { fn(); return; }
    const top = chat.scrollTop || 0;
    const atBottom = (chat.scrollTop || 0) + (chat.clientHeight || 0) >= (chat.scrollHeight || 0) - 8;
    fn();
    if (!state.s || !state.s.preserveScroll) return;
    if (atBottom) {
        chat.scrollTop = chat.scrollHeight || 0;
    } else if (Math.abs((chat.scrollTop || 0) - top) > 1) {
        chat.scrollTop = top;
    }
}

function applyTrim() {
    const chat = chatEl();
    if (!chat) return;

    const s = state.s;
    const active = Boolean(isOn() && s.trimHistory && !state.trimExpanded);
    const keep = s.trimKeep;
    const mes = Array.from(chat.querySelectorAll('.mes'));
    const sig = [mes.length, keep, active, state.trimExpanded].join('|');

    if (!active || mes.length <= keep) {
        if (state.trimSig === sig) return;
        state.trimSig = sig;
        withChatScroll(() => {
            chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
            chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));
        });
        return;
    }
    if (s.pauseOnEdit && isBusy()) return;
    if (state.trimSig === sig) return;
    state.trimSig = sig;

    const cut = mes.length - keep;
    withChatScroll(() => {
        chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
        chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));

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
    });
}

function applyClip() {
    const chat = chatEl();
    if (!chat) return;
    if (!isOn() || !state.s.clipLong) {
        chat.querySelectorAll('.mes.al-clip').forEach((el) => el.classList.remove('al-clip'));
        chat.querySelectorAll('.al-clip-btn').forEach((el) => el.remove());
        return;
    }
    if (state.s.pauseOnEdit && isBusy()) return;

    const limit = state.s.clipChars;
    withChatScroll(() => {
        // 内容已变短（换 swipe / 编辑）的旧折叠先还原
        chat.querySelectorAll('.mes.al-clip').forEach((mes) => {
            const text = mes.querySelector('.mes_text');
            const btn = mes.querySelector('.al-clip-btn');
            if (!text || (text.textContent || '').length < limit * 0.7) {
                mes.classList.remove('al-clip');
                if (btn) btn.remove();
            }
        });

        chat.querySelectorAll('.mes:not(.al-clip)').forEach((mes) => {
            if (mes.querySelector('.al-clip-btn')) return;
            const text = mes.querySelector('.mes_text');
            if (!text) return;
            const len = (text.textContent || '').length;
            if (len < limit) return;
            mes.classList.add('al-clip');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'al-clip-btn';
            btn.textContent = `展开全文（${len} 字）`;
            btn.addEventListener('click', () => {
                mes.classList.remove('al-clip');
                btn.remove();
            });
            mes.appendChild(btn);
        });
    });
}

const scheduleSweep = debounce(() => {
    if (document.hidden || !state.s) return;
    if (state.generating) return; // 生成中不打扰
    try {
        refreshVirtGate();
        applyImages();
        applyTrim();
        applyClip();
        updateBadge();
    } catch (err) {
        console.warn('[AntiLag] 扫描失败', err);
    }
}, 420);

/* ------------------------------------------------------------------ */
/* 预设                                                                */
/* ------------------------------------------------------------------ */

function applyPreset(mode) {
    const preset = PRESETS[mode];
    if (!preset || !state.s) return;
    VISUAL_KEYS.forEach((k) => { state.s[k] = preset[k]; });
    if (mode === 'turbo' && state.s.trimKeep > 160) state.s.trimKeep = 100;
    if (state.s.trimHistory) {
        state.trimExpanded = false;
        state.trimSig = '';
    }
    state.s.mode = mode;
    save();
    applyAll();
}

function detectMode() {
    if (!state.s) return 'custom';
    const found = Object.keys(PRESETS).find((mode) =>
        VISUAL_KEYS.every((k) => Boolean(state.s[k]) === PRESETS[mode][k]));
    if (found) return found;
    return 'custom';
}

function modeLabel() {
    if (!state.s.enabled) return '已关闭';
    if (isPaused()) return '暂停中';
    if (state.boost) return '极速·临时';
    const m = detectMode();
    return m === 'custom' ? '自定义' : MODE_LABEL[m];
}

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
                <small>渲染减负 · 体检归因 · 不隐藏内容 · v${VERSION}</small>
            </div>
            <span class="al-badge" data-badge>轻度</span>
        </div>
        <div class="al-body">
            <div class="al-modes" role="group" aria-label="性能模式">
                <button type="button" class="al-mode-btn" data-preset="lite">
                    <b>轻度</b><span>视觉无损</span>
                </button>
                <button type="button" class="al-mode-btn" data-preset="standard">
                    <b>均衡</b><span>关毛玻璃</span>
                </button>
                <button type="button" class="al-mode-btn" data-preset="turbo">
                    <b>极速</b><span>折叠历史</span>
                </button>
            </div>
            <div class="al-mode-hint" data-mode-hint>轻度只做不可见的优化，出现掉帧时自动临时升级。</div>

            <details class="al-fold">
                <summary>体验保护（建议全开）</summary>
                ${rowToggle('al-enabled', '启用 AntiLag', '总开关，关闭后所有注入立即移除', 'enabled')}
                ${rowToggle('al-pause-on-edit', '编辑消息时暂停', '正在编辑/选中文本时不做折叠与裁剪，避免打断操作', 'pauseOnEdit')}
                ${rowToggle('al-preserve-scroll', '切换时保持滚动位置', '任何开关切换都先记 #chat 位置再恢复，避免跳位', 'preserveScroll')}
                ${rowToggle('al-auto', '自动降级', '连续掉帧时临时升级到极速视觉，恢复后自动退出', 'autoDetect')}
                ${rowToggle('al-notify', '状态提示', '临时升级、暂停等动作弹出轻提示', 'notify')}
                ${rowToggle('al-hud-on', '显示悬浮仪表', '右下角可拖动小球，实时看帧率', 'hud')}
                <div class="al-row">
                    <div class="al-row-text">
                        <label>暂停优化</label>
                        <span>怀疑是本扩展导致问题时，暂停 10 分钟用于对比</span>
                    </div>
                    <button type="button" class="al-btn al-ghost al-small" data-pause>暂停 10 分钟</button>
                </div>
            </details>

            <details class="al-fold">
                <summary>渲染减负</summary>
                ${rowToggle('al-virtualize', '消息虚拟化', '视口外的消息跳过布局与绘制，只在消息数超阈值后生效', 'virtualize')}
                ${rowNumber('al-vmin', '虚拟化阈值', '消息数达到该值才启用，短聊天完全不介入', s.virtualizeMin, '条', 30, 500, 10)}
                ${rowToggle('al-genlite', '生成时轻量渲染', '流式输出时隔离并简化最后一条消息的重绘', 'genLite')}
                ${rowToggle('al-lazy', '图片懒加载', '聊天内图片改为 lazy + async 解码', 'lazyImg')}
                ${rowToggle('al-lazyframe', 'iframe 懒加载', '消息里的网页/视频卡片延迟加载', 'lazyFrame')}
                ${rowToggle('al-willchange', '清理 will-change', '回收被主题滥用的 GPU 图层，降低移动端内存压力', 'willChange')}
                ${rowToggle('al-killblur', '关闭毛玻璃 / 滤镜', 'backdrop-filter 是掉帧第一大户，关闭后画面变朴素但明显更顺', 'killBlur')}
                ${rowToggle('al-killblur-all', '毛玻璃关闭范围：全界面', '默认只关聊天区，打开后连抽屉、顶栏、弹窗一起关', 'killBlurAll')}
                ${rowToggle('al-killbg', '停用动画背景', '停掉背景动画与 fixed 背景，滚动更稳', 'killBgAnim')}
                ${rowToggle('al-killshadow', '关闭阴影', '去掉消息的 box-shadow / text-shadow', 'killShadow')}
                ${rowToggle('al-killtrans', '关闭消息过渡动画', '消息区不再做过渡/关键帧动画', 'killTransitions')}
                ${rowToggle('al-contain', '隔离聊天区布局', 'contain: layout，避免抽屉/输入框重排牵连聊天区', 'containChat')}
            </details>

            <details class="al-fold">
                <summary>历史与超长消息</summary>
                ${rowToggle('al-trim', '折叠较早消息', '更早的消息移出渲染树，顶部可一键展开', 'trimHistory')}
                ${rowNumber('al-keep', '折叠后保留', '保留最近多少条消息可见', s.trimKeep, '条', 10, 3000, 10)}
                ${rowToggle('al-clip', '超长消息折叠', '单条超过阈值的消息先显示前段，点「展开全文」看全', 'clipLong')}
                ${rowNumber('al-clipchars', '长消息阈值', '单条消息字符数超过该值才折叠', s.clipChars, '字', 500, 20000, 500)}
            </details>

            <div class="al-diag">
                <div class="al-diag-head">
                    <b>运行体检</b>
                    <button type="button" class="al-btn al-ghost al-small" id="al-scan">重新检测</button>
                </div>
                <div class="al-diag-grid" data-grid></div>
                <div class="al-advice" data-advice></div>
            </div>

            <div class="al-actions">
                <button type="button" class="al-btn al-primary" id="al-optimize">一键均衡</button>
                <button type="button" class="al-btn al-ghost" id="al-reset">恢复默认</button>
            </div>
            <div class="al-foot">不改角色卡、世界书与聊天内容；所有结构性操作都可用按钮还原。</div>
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
            if (VISUAL_KEYS.includes(key)) state.s.mode = 'custom';
            input.closest('.al-switch')?.classList.toggle('is-on', input.checked);
            save();
            applyAll();
        });
    });

    NUMBERS.forEach(([id, key, min, max]) => {
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

    el.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
            applyPreset(btn.dataset.preset);
            syncPanel();
        });
    });

    el.querySelector('#al-optimize')?.addEventListener('click', () => {
        applyPreset('standard');
        syncPanel();
        toast('success', '已切换到均衡模式：关闭毛玻璃与动画背景，其余保持原样');
    });
    el.querySelector('#al-reset')?.addEventListener('click', resetSettings);
    el.querySelector('#al-scan')?.addEventListener('click', () => renderDiagnostics());
    el.querySelector('[data-pause]')?.addEventListener('click', togglePause);
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
    NUMBERS.forEach(([id, key]) => {
        const input = el.querySelector('#' + id);
        // 用户正在输入的数字框不覆盖，避免每 5 秒刷新时吃掉按键
        if (input && document.activeElement !== input) input.value = String(state.s[key]);
    });
    const mode = detectMode();
    el.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.preset === mode);
    });
    const hint = el.querySelector('[data-mode-hint]');
    if (hint) {
        hint.textContent = state.boost
            ? '侦测到掉帧，已临时升级为极速视觉（不改动折叠与裁剪），恢复后自动退出。'
            : '轻度只做不可见的优化；均衡会关闭聊天区毛玻璃与动画背景；极速再折叠历史。';
    }
    const pauseBtn = el.querySelector('[data-pause]');
    if (pauseBtn) {
        const left = state.s.pausedUntil ? Math.max(0, Math.round((state.s.pausedUntil - Date.now()) / 1000)) : 0;
        pauseBtn.textContent = left > 0 ? `恢复（${Math.ceil(left / 60)} 分钟）` : '暂停 10 分钟';
        pauseBtn.classList.toggle('is-paused', left > 0);
    }
    updateBadge();
}

function togglePause() {
    if (isPaused()) {
        state.s.pausedUntil = 0;
        toast('info', '已恢复 AntiLag');
    } else {
        state.s.pausedUntil = Date.now() + 10 * 60 * 1000;
        toast('info', '已暂停 10 分钟，用来对比是否影响体验');
    }
    save();
    applyAll();
}

function updateBadge() {
    const text = modeLabel();
    if (state.panelEl) {
        const badge = state.panelEl.querySelector('[data-badge]');
        if (badge) {
            badge.textContent = text;
            badge.dataset.mode = state.boost ? 'boost' : (!state.s.enabled || isPaused() ? 'off' : 'on');
        }
    }
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
    syncPanel();
    toast('info', '已恢复默认（轻度）设置');
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
    let wcCount = 0;
    const sample = Array.from(document.querySelectorAll('#chat .mes')).slice(-30);
    for (const mes of sample) {
        const cs = getComputedStyle(mes);
        const bf = cs.backdropFilter || cs.webkitBackdropFilter;
        if ((bf && bf !== 'none') || (cs.filter && cs.filter !== 'none')) blurCount++;
        if (cs.willChange && cs.willChange !== 'auto') wcCount++;
        const child = mes.firstElementChild;
        if (child) {
            const ccs = getComputedStyle(child);
            if (ccs.willChange && ccs.willChange !== 'auto') wcCount++;
        }
    }

    let longest = 0;
    // 只抽最近 40 条，避免在大聊天里做全量 textContent 拼接
    Array.from(document.querySelectorAll('#chat .mes_text')).slice(-40).forEach((el) => {
        const len = (el.textContent || '').length;
        if (len > longest) longest = len;
    });

    let bgAnim = false;
    try {
        const cs = getComputedStyle(document.body);
        bgAnim = (cs.animationName && cs.animationName !== 'none')
            || (cs.backgroundAttachment && cs.backgroundAttachment.includes('fixed'));
    } catch (err) { /* 忽略 */ }

    return { chatLen, mesDom, nodes, extCount, imgCount, blurCount, wcCount, longest, bgAnim };
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
        ['生成期长任务', `${state.lastGenLt} 次`, state.lastGenLt > 3 ? 'warn' : 'ok'],
        ['毛玻璃元素', String(d.blurCount), d.blurCount > 0 ? 'warn' : 'ok'],
        ['will-change', String(d.wcCount), d.wcCount > 2 ? 'warn' : 'ok'],
        ['动画背景', d.bgAnim ? '存在' : '无', d.bgAnim ? 'warn' : 'ok'],
        ['最长消息', d.longest > 5000 ? `${Math.round(d.longest / 1000)}k 字` : `${d.longest} 字`, d.longest > 5000 ? 'warn' : 'ok'],
        ['聊天图片', String(d.imgCount), 'ok'],
        ['已启用扩展', String(d.extCount), d.extCount > 10 ? 'warn' : 'ok'],
    ];

    grid.innerHTML = items.map(([k, v, level]) => `
        <div class="al-kv" data-level="${level}">
            <span>${k}</span><b>${v}</b>
        </div>`).join('');

    const tips = [];
    if ((d.chatLen || d.mesDom) > 300 && !s.virtualize) tips.push('长聊天建议开启「消息虚拟化」');
    if (d.blurCount > 0 && !s.killBlur) tips.push('聊天区有毛玻璃/模糊，切「均衡」或单开「关闭毛玻璃」');
    if (d.bgAnim && !s.killBgAnim) tips.push('检测到动画背景，建议停用动画背景');
    if (d.wcCount > 2 && !s.willChange) tips.push('主题在滥用 will-change，建议开启「清理 will-change」');
    if (d.longest > 5000 && !s.clipLong) tips.push(`最长一条消息约 ${Math.round(d.longest / 1000)}k 字，可开「超长消息折叠」`);
    if (fps && fps < s.fpsThreshold) tips.push('当前帧率偏低，可先切「均衡」，仍卡再切「极速」');
    if (lt.max > s.longTaskMs) tips.push(`存在 ${Math.round(lt.max)}ms 主线程长任务，多为大聊天渲染或重扩展造成`);
    if (state.lastGenLt > 3) tips.push('生成期间长任务偏多：多为长消息流式重绘，可开「生成时轻量渲染」');
    if (d.extCount > 10) tips.push(`已启用 ${d.extCount} 个扩展，建议逐个停用排查（尤其自带定时器的）`);
    if (isEditing()) tips.push('正在编辑消息，结构性优化已自动暂缓');
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
            <div class="al-hud-head"><span class="al-hud-mode" data-v-mode>轻度</span><span class="al-hud-fpsbig" data-v-fps>--</span></div>
            <div class="al-hud-row"><span>长任务 10s</span><b data-v-lt>0</b></div>
            <div class="al-hud-row"><span>消息</span><b data-v-msg>0</b></div>
            <div class="al-hud-modes">
                <button type="button" data-preset="lite">轻</button>
                <button type="button" data-preset="standard">均</button>
                <button type="button" data-preset="turbo">极</button>
            </div>
            <div class="al-hud-actions">
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
    if (pill) makeDraggable(el, pill);

    el.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applyPreset(btn.dataset.preset);
            syncPanel();
            renderHudCard();
        });
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

function makeDraggable(el, handle) {
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
        el.style.left = clamp(originX + dx, 4, window.innerWidth - w - 4) + 'px';
        el.style.top = clamp(originY + dy, 4, window.innerHeight - h - 4) + 'px';
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
    if (!state.hudEl || !state.s) return;
    const lt = recentLongTasks();
    const c = ctx();
    const msgs = c && Array.isArray(c.chat) ? c.chat.length : countMessages();
    const modeEl = state.hudEl.querySelector('[data-v-mode]');
    if (modeEl) modeEl.textContent = modeLabel();
    const fpsEl = state.hudEl.querySelector('[data-v-fps]');
    if (fpsEl) fpsEl.textContent = state.fps ? `${state.fps} FPS` : '-- FPS';
    const ltEl = state.hudEl.querySelector('[data-v-lt]');
    if (ltEl) ltEl.textContent = `${lt.count} 次 / ${Math.round(lt.max)}ms`;
    const msgEl = state.hudEl.querySelector('[data-v-msg]');
    if (msgEl) msgEl.textContent = String(msgs);
    const mode = detectMode();
    state.hudEl.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('is-active', b.dataset.preset === mode));
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
    if (!state.s.enabled || isPaused()) el.dataset.state = 'off';
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
    if (!state.s) return;
    if (!state.raf) {
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
    }

    if (!state.po) {
        try {
            const po = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    state.longTasks.push({ t: entry.startTime, d: entry.duration });
                    if (entry.duration > state.ltMax) state.ltMax = entry.duration;
                    if (state.generating) state.genLt++;
                }
                if (state.longTasks.length > 60) state.longTasks.splice(0, state.longTasks.length - 60);
            });
            po.observe({ entryTypes: ['longtask'] });
            state.po = po;
        } catch (err) {
            // 浏览器不支持 longtask，静默降级
        }
    }

    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(() => {
        updateHud();
        state.diagTick++;
        if (state.diagTick >= 10) {
            state.diagTick = 0;
            if (state.panelEl && document.getElementById('right-nav-panel')?.classList.contains('openDrawer')) {
                renderDiagnostics();
            }
            syncPanel();
        }
    }, 1000);
}

function onFps(fps) {
    state.fps = fps;
    if (!state.s || !state.s.enabled) return;
    if (performance.now() - state.startedAt < 4000) return;

    if (!state.s.autoDetect || isPaused()) {
        state.lowStreak = 0;
        state.highStreak = 0;
        return;
    }
    if (fps < state.s.fpsThreshold) {
        state.lowStreak++;
        state.highStreak = 0;
        if (state.lowStreak >= 3 && !state.boost && !isBusy()) enableBoost();
    } else if (fps >= state.s.fpsThreshold + 10) {
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
    toast('warning', `检测到掉帧（${state.fps} FPS），已临时升级极速视觉（不折叠内容）`);
}

function disableBoost() {
    if (!state.boost) return;
    state.boost = false;
    applyAll();
    toast('info', '帧率已恢复，已退出临时极速模式');
}

/* ------------------------------------------------------------------ */
/* 事件与挂载                                                          */
/* ------------------------------------------------------------------ */

function observeChat() {
    const chat = chatEl();
    if (!chat) {
        setTimeout(observeChat, 800);
        return;
    }
    if (state.observer && state.observerTarget === chat) {
        if (!state.observerOn) {
            state.observer.observe(chat, { childList: true, subtree: true });
            state.observerOn = true;
        }
        return;
    }
    if (state.observer) state.observer.disconnect();
    state.observerTarget = chat;
    state.observer = new MutationObserver(() => {
        scheduleSweep();
    });
    state.observer.observe(chat, { childList: true, subtree: true });
    state.observerOn = true;
    scheduleSweep();
}

function pauseObserver() {
    if (state.observer && state.observerOn) {
        state.observer.disconnect();
        state.observerOn = false;
    }
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
        state.trimSig = '';
        applyAll();
        scheduleSweep();
    });
    on('MESSAGE_RECEIVED', scheduleSweep);
    on('MESSAGE_SENT', scheduleSweep);
    on('USER_MESSAGE_RENDERED', scheduleSweep);
    on('CHARACTER_MESSAGE_RENDERED', scheduleSweep);
    on('MORE_MESSAGES_LOADED', scheduleSweep);
    on('GENERATION_STARTED', () => {
        state.generating = true;
        state.genLt = 0;
        pauseObserver();
        if (state.s && isOn() && state.s.genLite) document.body.classList.add('antilag-gen');
        else document.body.classList.remove('antilag-gen');
    });
    const endGen = () => {
        state.generating = false;
        state.lastGenLt = state.genLt;
        document.body.classList.remove('antilag-gen');
        observeChat();
        scheduleSweep();
        if (state.panelEl) renderDiagnostics();
    };
    on('GENERATION_ENDED', endGen);
    on('GENERATION_STOPPED', endGen);
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

        console.log(`[AntiLag] v${VERSION} ready (${modeLabel()})`);
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
