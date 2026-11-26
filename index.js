/**
 * AntiLag 流畅优化 v1.4 —— SillyTavern 扩展
 *
 * 设计原则：
 * 1) 默认「轻度」模式视觉零改动，只做不改变观感的减负；
 * 2) 所有结构性操作（折叠/裁剪）默认关闭，且编辑消息时暂停；
 * 3) 切换任何样式前保存 #chat 滚动位置，避免跳位；
 * 4) 自动降级只动「视觉开销」，不隐藏任何内容。
 * 依赖：仅 SillyTavern.getContext() 稳定 API。
 */

const MODULE_NAME = 'antilag';
const VERSION = '1.4.0';

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
    nativeLimit: 0,
    truncApplied: false,
    truncOrig: 0,
    clipLong: false,
    clipChars: 3000,

    pauseOnEdit: true,
    preserveScroll: true,
    scrollIdle: true,
    streamFps: 0,
    streamFpsOrig: 0,
    streamFadeSkip: false,
    fadeApplied: false,

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
    ['al-fadeskip', 'streamFadeSkip'],
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

const SELECTS = [
    ['al-streamfps', 'streamFps'],
    ['al-nativelimit', 'nativeLimit'],
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
    nativeTrunc: 0,
    cvSize: 0,
    chatLoadT0: 0,
    chatLoadMs: 0,
    chatLoadCount: 0,
    inputEvents: [],
    eventPo: null,
    scrollTimer: 0,
    tokens: 0,
    genT0: 0,
    tps: 0,
    lastTps: 0,
    eventsBound: false,
    lastRenderMs: 0,
    renderT0: 0,
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
    // 推理块编辑（ST 用 .reasoning_edit_textarea）
    const rta = document.querySelector('.reasoning_edit_textarea');
    if (rta && rta.getClientRects().length > 0) return true;
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

/** SillyTavern 的 power_user 设置对象（getContext().powerUserSettings 即 power_user） */
function powerUser() {
    const c = ctx();
    return c && c.powerUserSettings ? c.powerUserSettings : null;
}

/** ST 原生「聊天截断」：>0 时只渲染最近 N 条 + Show more messages，0/undefined 为不限 */
function nativeTruncation() {
    const pu = powerUser();
    const v = Number(pu && pu.chat_truncation);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 当前是否处在 ST 原生分页状态（有「Show more messages」按钮） */
function nativePagingActive() {
    return Boolean(document.getElementById('show_more_messages'));
}

/**
 * 可选：直接把 ST 的 chat_truncation 设成固定条数。
 * 这是 ST 原生机制（只影响渲染，不影响 prompt 上下文），比本扩展自己折叠更稳，
 * 也不会有两套历史机制打架的问题。记录原值，停用/恢复默认时还原。
 */
function applyNativeLimit() {
    const pu = powerUser();
    if (!pu || typeof pu.chat_truncation !== 'number') return 0;
    const want = Number(state.s && state.s.nativeLimit) || 0;
    if (!isOn() || !want) {
        restoreNativeLimit();
        return 0;
    }
    if (!state.s.truncApplied) {
        state.s.truncOrig = pu.chat_truncation;
        state.s.truncApplied = true;
        save();
    }
    if (pu.chat_truncation !== want) pu.chat_truncation = want;
    return want;
}

/**
 * ST 的「流式淡入」(power_user.stream_fade_in) 每个 tick 都会：clone 整条消息 →
 * 用 Intl.Segmenter 把每个词包成 <span class="text_segment"> → morphdom 全树 diff。
 * 长消息 + 30 FPS 下非常贵。这里只在生成期间临时关掉，结束后还原（记录状态防止崩溃后丢失）。
 */
function applyStreamFadeSkip() {
    const pu = powerUser();
    if (!pu) return;
    const want = Boolean(isOn() && state.generating && state.s && state.s.streamFadeSkip);
    if (!want) { restoreStreamFadeSkip(); return; }
    if (pu.stream_fade_in) {
        state.s.fadeApplied = true;
        save();
        pu.stream_fade_in = false;
    }
}

function restoreStreamFadeSkip() {
    const pu = powerUser();
    if (!pu || !state.s || !state.s.fadeApplied) return;
    if (pu.stream_fade_in !== true) pu.stream_fade_in = true;
    state.s.fadeApplied = false;
    save();
}

/** 生成期间新消息可能落在热区之外：补一次热区标记（消息是直接子节点，成本极低） */
function hotZoneTick() {
    if (!isOn() || !document.body.classList.contains('antilag-virt')) return;
    applyHotZone();
}

function restoreNativeLimit() {
    const pu = powerUser();
    if (!pu || !state.s || !state.s.truncApplied) return;
    const applied = Number(state.s.nativeLimit) || 0;
    // 只在「当前值仍是我们改的那个」时才还原，用户在 ST 里自己改过就尊重用户
    if (applied && Number(pu.chat_truncation) === applied) {
        pu.chat_truncation = Number(state.s.truncOrig) || 0;
    }
    state.s.truncApplied = false;
    save();
}

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
    s.streamFps = [0, 10, 15, 20].includes(Number(s.streamFps)) ? Number(s.streamFps) : 0;
    s.streamFpsOrig = clamp(parseInt(s.streamFpsOrig, 10) || 0, 0, 240);
    s.fadeApplied = Boolean(s.fadeApplied);
    s.nativeLimit = [0, 100, 150, 300].includes(Number(s.nativeLimit)) ? Number(s.nativeLimit) : 0;
    s.truncOrig = clamp(parseInt(s.truncOrig, 10) || 0, 0, 5000);
    s.truncApplied = Boolean(s.truncApplied);
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
            '/* 消息虚拟化：只对「热区之外」的消息跳过布局与绘制，热区（最近 30 条）永不跳过 */',
            'body.antilag-virt #chat .mes:not(.al-hot){content-visibility:auto;contain-intrinsic-size:auto var(--al-cv-size, 240px);will-change:auto;}',
            '/* contain-intrinsic-size 的 auto 会记住上次真实高度，未渲染过的用实测中位数兜底，避免滚动条抖动 */',
            '',
        ].join('\n');
    }

    if (state.s && state.s.scrollIdle) {
        css += [
            '/* 滚动中：暂时屏蔽消息按钮的命中测试与过渡，减少 hover/transition 触发的重复绘制（停止滚动即恢复） */',
            'body.antilag-scrolling #chat .mes .mes_buttons,body.antilag-scrolling #chat .mes .mes_edit_buttons,body.antilag-scrolling #chat .mes .swipe_left,body.antilag-scrolling #chat .mes .swipe_right{pointer-events:none !important;}',
            'body.antilag-scrolling #chat .mes,body.antilag-scrolling #chat .mes *{transition:none !important;}',
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
                'body.antilag #chat,body.antilag #chat *,body.antilag #chat *::before,body.antilag #chat *::after,body.antilag #form_sheld,body.antilag #form_sheld *,body.antilag #send_form{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
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
            '/* 关闭消息阴影与发光（#chat 自身在核心 CSS 里也带 text-shadow） */',
            'body.antilag #chat,body.antilag #chat .mes,body.antilag #chat .mes *{box-shadow:none !important;text-shadow:none !important;}',
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
            '/* 正在流式的最后一条绝不跳过布局，避免 content-visibility 与逐字重绘打架 */',
            'body.antilag-gen #chat .mes:last-child{content-visibility:visible !important;}',
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
    state.nativeTrunc = nativeTruncation();
    // 原生分页开着时不做虚拟化：ST 每次「Show more」都会前插并补偿滚动，content-visibility 会把高度估歪
    const virt = on && eff('virtualize') && !nativePagingActive() && mes >= state.s.virtualizeMin;
    if (document.body.classList.contains('antilag-virt') === virt) {
        applyHotZone();
        return;
    }
    document.body.classList.toggle('antilag-virt', virt);
    swapStyle(on ? buildCss() : '');
    applyHotZone();
    if (virt) scheduleMeasureCvSize();
}

/**
 * 划定「热区」：最近 30 条消息永远不虚拟化。
 * 流式输出、贴底滚动、编辑最后一条都发生在热区，避免 content-visibility 干扰这些路径。
 */
function applyHotZone() {
    const chat = chatEl();
    if (!chat) return;
    const on = document.body.classList.contains('antilag-virt');
    const mes = chat.querySelectorAll('.mes');
    if (!on) {
        if (chat.querySelector('.mes.al-hot')) {
            chat.querySelectorAll('.mes.al-hot').forEach((el) => el.classList.remove('al-hot'));
        }
        return;
    }
    const hot = Math.min(30, mes.length);
    for (let i = 0; i < mes.length; i++) {
        const want = i >= mes.length - hot;
        if (mes[i].classList.contains('al-hot') !== want) mes[i].classList.toggle('al-hot', want);
    }
}

/**
 * 用实测中位高度作为 contain-intrinsic-size 的兜底值。
 * content-visibility 的元素未渲染时用估高，估高偏差会表现为滚动条跳动，所以取真实样本。
 */
function measureCvSize() {
    const chat = chatEl();
    if (!chat) return;
    const sample = Array.from(chat.querySelectorAll('.mes:not(.al-hot)')).slice(-40);
    if (!sample.length) return;
    const heights = sample
        .map((el) => el.getBoundingClientRect().height)
        .filter((h) => h > 24)
        .sort((a, b) => a - b);
    if (!heights.length) return;
    const median = heights[Math.floor(heights.length / 2)];
    state.cvSize = Math.round(median);
    setCvSize(`${state.cvSize}px`);
}

/** 写入 contain-intrinsic-size 的实测兜底值；样式表写入失败时退回独立 style 标签 */
function setCvSize(value) {
    const root = document.documentElement;
    try {
        if (root && root.style && typeof root.style.setProperty === 'function') {
            root.style.setProperty('--al-cv-size', value);
            return;
        }
    } catch (err) { /* 落到下面的兜底 */ }
    let el = document.getElementById('al-cv-style');
    if (!el) {
        el = document.createElement('style');
        el.id = 'al-cv-style';
        document.head.appendChild(el);
    }
    el.textContent = `:root{--al-cv-size:${value}}`;
}

function scheduleMeasureCvSize() {
    if (!state.s || !isOn()) return;
    requestAnimationFrame(() => {
        measureCvSize();
        if (!state.cvSize) setTimeout(measureCvSize, 300);
    });
}

/** 滚动期降载：滚动中屏蔽按钮命中测试与过渡，停止 160ms 后自动恢复 */
function hookScrollIdle() {
    const chat = chatEl();
    if (!chat || chat.dataset.alScrolled === '1') return;
    chat.dataset.alScrolled = '1';
    chat.addEventListener('scroll', () => {
        if (!state.s || !isOn() || !state.s.scrollIdle) return;
        if (!document.body.classList.contains('antilag-scrolling')) {
            document.body.classList.add('antilag-scrolling');
        }
        clearTimeout(state.scrollTimer);
        state.scrollTimer = setTimeout(() => {
            document.body.classList.remove('antilag-scrolling');
        }, 160);
    }, { passive: true });
}

/**
 * 流式降频：ST 每个 tick 都会对整条消息重跑 正则 + DOMPurify + Markdown，
 * 帧率由 power_user.streaming_fps 决定（默认 30）。这里提供一个「上限」开关。
 * 只在下限生效时改 ST 设置，并记录原值；停用扩展/恢复默认/下次启动都会还原。
 */
function targetStreamFps() {
    const pu = powerUser();
    if (!pu || typeof pu.streaming_fps !== 'number') return 0;
    const cap = Number(state.s && state.s.streamFps) || 0;
    if (!isOn() || !cap) {
        // 选回「不改」时也要立刻还原，不能把 ST 的流式 FPS 留在被限流的数值上
        restoreStreamFps();
        return 0;
    }
    if (!state.s.streamFpsOrig) {
        state.s.streamFpsOrig = pu.streaming_fps;
        save();
    }
    const target = Math.min(state.s.streamFpsOrig, cap);
    if (pu.streaming_fps !== target) pu.streaming_fps = target;
    return target;
}

function restoreStreamFps() {
    const pu = powerUser();
    const orig = Number(state.s && state.s.streamFpsOrig) || 0;
    if (!pu || !orig) return;
    if (Number(pu.streaming_fps) !== orig) pu.streaming_fps = orig;
    state.s.streamFpsOrig = 0;
    save();
}

/** 输入延迟（Chrome 的 event timing）：>100ms 说明按键被主线程计算挡住，而不是输入框本身的问题 */
function startInputTiming() {
    if (state.eventPo) return;
    try {
        const po = new PerformanceObserver((list) => {
            const now = performance.now();
            for (const entry of list.getEntries()) {
                if (!['keydown', 'keypress', 'input', 'pointerdown'].includes(entry.name)) continue;
                state.inputEvents.push({ t: now, d: entry.duration });
            }
            if (state.inputEvents.length > 40) state.inputEvents.splice(0, state.inputEvents.length - 40);
        });
        po.observe({ type: 'event', durationThreshold: 104, buffered: true });
        state.eventPo = po;
    } catch (err) {
        // 浏览器不支持 event timing，静默降级
    }
}

function recentInput() {
    const now = performance.now();
    state.inputEvents = state.inputEvents.filter((e) => now - e.t < 10000);
    const max = state.inputEvents.reduce((acc, e) => Math.max(acc, e.d), 0);
    return { count: state.inputEvents.length, max };
}

/** 量一条消息从「消息落地事件」到「稳定一帧」的耗时（含其它扩展的收尾处理） */
function measureRender() {
    if (state.renderT0) return;
    state.renderT0 = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!state.renderT0) return;
        state.lastRenderMs = performance.now() - state.renderT0;
        state.renderT0 = 0;
    }));
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
    state.nativeTrunc = nativeTruncation();
    // 原生分页开着时不做虚拟化：ST 每次「Show more」都会前插并补偿滚动，content-visibility 会把高度估歪
    const virt = on && eff('virtualize') && !nativePagingActive() && mes >= state.s.virtualizeMin;
    const wasVirt = document.body.classList.contains('antilag-virt');

    document.documentElement.classList.toggle('antilag', on);
    document.body.classList.toggle('antilag', on);
    document.body.classList.toggle('antilag-virt', virt);
    document.body.classList.toggle('antilag-contain', on && eff('containChat'));
    if (!on) {
        document.body.classList.remove('antilag-gen');
        document.body.classList.remove('antilag-scrolling');
    }

    swapStyle(on ? buildCss() : '');
    applyHotZone();
    if (virt && (!wasVirt || !state.cvSize)) scheduleMeasureCvSize();
    if (on) {
        targetStreamFps();
        applyNativeLimit();
        applyStreamFadeSkip();
    } else {
        restoreStreamFps();
        restoreNativeLimit();
        restoreStreamFadeSkip();
    }
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
    // 只处理消息正文里的图（含媒体块）：头像同 URL 且尺寸小，懒加载反而会在滚动时闪加载
    document.querySelectorAll('#chat .mes_block img:not([data-al-lazy])').forEach((img) => {
        img.dataset.alLazy = '1';
        if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
        if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
        img.classList.add('al-lazy');
    });
    if (eff('lazyFrame')) {
        document.querySelectorAll('#chat .mes_block iframe:not([data-al-lazy])').forEach((frame) => {
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
    // ST 原生已有分页（chat_truncation + Show more messages）时不再叠一层折叠，避免两套历史机制互相打架
    const nativePaging = Boolean(document.getElementById('show_more_messages'));
    const active = Boolean(isOn() && s.trimHistory && !state.trimExpanded && !nativePaging);
    const keep = s.trimKeep;
    const mes = Array.from(chat.querySelectorAll('.mes'));
    const sig = [mes.length, keep, active, state.trimExpanded, nativePaging].join('|');

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

const scheduleSweep = (() => {
    let timer = 0;
    const run = () => {
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
    };
    return () => {
        clearTimeout(timer);
        // 先攒一拍，再交给浏览器空闲时段：避免和流式渲染/滚动抢主线程
        timer = setTimeout(() => {
            timer = 0;
            if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(run, { timeout: 600 });
            } else {
                run();
            }
        }, 300);
    };
})();

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

function rowSelect(id, label, hint, value, options) {
    const opts = options.map(([v, text]) => {
        const sel = Number(v) === Number(value) ? ' selected' : '';
        return `<option value="${v}"${sel}>${text}</option>`;
    }).join('');
    return `
        <div class="al-row">
            <div class="al-row-text">
                <label for="${id}">${label}</label>
                <span>${hint}</span>
            </div>
            <div class="al-num">
                <select id="${id}">${opts}</select>
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
                ${rowToggle('al-preserve-scroll', '切换时保持滚动位置', '任何开关切换都先记 #chat 位置再恢复，避免跳位', 'preserveScroll')}
                ${rowToggle('al-scrollidle', '滚动期降载', '滚动时暂时屏蔽消息按钮的 hover 与过渡，停止滚动立即恢复', 'scrollIdle')}
                ${rowToggle('al-pause-on-edit', '编辑消息时暂停', '正在编辑/选中文本时不做折叠与裁剪，避免打断操作', 'pauseOnEdit')}
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
                ${rowSelect('al-streamfps', '流式降频', 'ST 每个 tick 都重跑正则+净化+Markdown；设上限可明显减负（会临时改 ST 的流式 FPS，停用即还原）', s.streamFps, [
                    [0, '不改（跟随 ST 设置）'],
                    [20, '上限 20 FPS'],
                    [15, '上限 15 FPS'],
                    [10, '上限 10 FPS（更省，文本更跳）'],
                ])}
                ${rowToggle('al-fadeskip', '生成时临时关闭流式淡入', 'ST 的淡入每个 tick 都要整条消息重新分词 + morphdom；长消息时关掉可明显减负（生成结束自动还原）', 'streamFadeSkip')}
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
                ${rowSelect('al-nativelimit', '借用 ST 原生分页', '把 ST 的「聊天截断」设为固定条数：只渲染最近 N 条，顶部「Show more」可翻回；只影响显示、不影响上下文', s.nativeLimit, [
                    [0, '不改（用 ST 当前设置）'],
                    [100, '最近 100 条'],
                    [150, '最近 150 条'],
                    [300, '最近 300 条'],
                ])}
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

    SELECTS.forEach(([id, key]) => {
        const input = el.querySelector('#' + id);
        if (!input) return;
        input.addEventListener('change', () => {
            state.s[key] = Number(input.value) || 0;
            save();
            applyAll();
        });
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
    SELECTS.forEach(([id, key]) => {
        const input = el.querySelector('#' + id);
        if (input && document.activeElement !== input) input.value = String(state.s[key] || 0);
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
    restoreStreamFps();
    restoreNativeLimit();
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

    const pu = powerUser() || {};
    const nativeTrunc = Number(pu.chat_truncation) || 0;
    const stStreamFps = Number(pu.streaming_fps) || 0;
    const input = recentInput();

    return {
        chatLen, mesDom, nodes, extCount, imgCount, blurCount, wcCount, longest, bgAnim,
        nativeTrunc, stStreamFps, input,
        loadMs: state.chatLoadMs, loadCount: state.chatLoadCount, tps: state.tps,
        virtOn: document.body.classList.contains('antilag-virt'),
        cvSize: state.cvSize,
        paging: nativePagingActive(),
        tokenCounter: Boolean(pu.message_token_count_enabled),
        fadeIn: Boolean(pu.stream_fade_in),
        fastUi: Boolean(pu.fast_ui_mode),
        regexCount: Array.isArray(c && c.extensionSettings && c.extensionSettings.regex)
            ? c.extensionSettings.regex.length : 0,
        renderMs: state.lastRenderMs,
    };
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
        ['渲染条数', `${d.mesDom} / 虚拟化${d.virtOn ? '开' : '关'}`, (d.mesDom > 400 && !d.virtOn) ? 'warn' : 'ok'],
        ['原生截断', d.nativeTrunc ? `最近 ${d.nativeTrunc} 条${d.paging ? '（分页中）' : ''}` : '不限（全量渲染）', d.nativeTrunc ? 'ok' : ((d.chatLen > 300) ? 'warn' : 'ok')],
        ['上次加载', d.loadMs ? `${d.loadCount} 条 / ${Math.round(d.loadMs)}ms` : '—', d.loadMs > 1200 ? 'warn' : 'ok'],
        ['消息落地', d.renderMs ? `${Math.round(d.renderMs)}ms` : '—', d.renderMs > 120 ? 'bad' : (d.renderMs > 70 ? 'warn' : 'ok')],
        ['ST 逐条 token 计数', d.tokenCounter ? '开（生成/滑动时分词）' : '关', (d.tokenCounter && (d.chatLen || 0) > 200) ? 'warn' : 'ok'],
        ['输入延迟 10s', d.input.max ? `最大 ${Math.round(d.input.max)}ms` : '无慢事件', d.input.max > 200 ? 'bad' : (d.input.max > 100 ? 'warn' : 'ok')],
        ['DOM 节点', String(d.nodes), d.nodes > 4000 ? 'warn' : 'ok'],
        ['10s 长任务', `${lt.count} 次 / 最长 ${Math.round(lt.max)}ms`, lt.max > s.longTaskMs ? 'bad' : 'ok'],
        ['生成期长任务', `${state.lastGenLt} 次${d.tps ? ` / ${d.tps} TPS` : ''}`, state.lastGenLt > 3 ? 'warn' : 'ok'],
        ['流式帧率', d.stStreamFps ? `${d.stStreamFps} FPS` : '未知', (d.stStreamFps >= 30 && state.lastGenLt > 3) ? 'warn' : 'ok'],
        ['流式淡入', d.fadeIn ? '开（每 tick 重建分段）' : '关', d.fadeIn ? 'warn' : 'ok'],
        ['ST 快速 UI', d.fastUi ? '开（全界面无模糊）' : '关', (!d.fastUi && d.blurCount > 0) ? 'warn' : 'ok'],
        ['正则脚本', String(d.regexCount), d.regexCount > 5 ? 'warn' : 'ok'],
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
    if (state.lastGenLt > 3 && d.stStreamFps >= 25 && !s.streamFps) {
        tips.push(`ST 流式刷新是 ${d.stStreamFps} FPS，每个 tick 都要重跑正则+净化+Markdown；可把「流式降频」设到 15–20`);
    }
    if (d.nativeTrunc) tips.push(`ST 原生「聊天截断」为 ${d.nativeTrunc} 条，更早的消息本来就不渲染，无需再开「折叠较早消息」`);
    if (d.nativeTrunc && (d.chatLen || 0) > 300) tips.push('想让长聊天彻底顺滑：可在 ST「用户设置→聊天截断」设为 0 后交给虚拟化，或反向保持在 100 条更省');
    if (!d.nativeTrunc && (d.chatLen || 0) > 300 && !s.virtualize) tips.push('聊天截断为「不限」且消息很多，建议开启虚拟化或把 ST 聊天截断设成 100–200');
    if (d.input.max > 100) tips.push(`输入延迟最大 ${Math.round(d.input.max)}ms：按键被主线程计算挡住（世界书扫描/正则/向量检索/tokenizer），不是输入框本身问题`);
    if (d.fadeIn && !s.streamFadeSkip) tips.push('「流式淡入」每个 tick 都要把整条消息按词重切 span 再 morphdom，长消息会明显卡；可开「生成时临时关闭流式淡入」或在 ST 里关掉');
    if (!d.fastUi && d.blurCount > 0) tips.push('ST 自带「快速 UI 模式」能一键去掉全界面毛玻璃（比逐项关更彻底），在 ST 用户设置里开启即可');
    if (d.regexCount > 5) tips.push(`已启用 ${d.regexCount} 条正则脚本，每条消息渲染都要全跑一遍；不常用的先在「正则」扩展里停用`);
    if (d.tokenCounter) tips.push('ST「显示每条消息 token」：消息落地和滑动时会分词一次，长聊天批量生成/大量滑动会加慢；不需要可在 ST 用户设置里关掉');
    if (d.renderMs > 120) tips.push(`消息落地约 ${Math.round(d.renderMs)}ms（事件到稳定一帧，含其它扩展的收尾处理），先查是否开了逐条 token 计数/TTS/总结类扩展`);
    if (!d.nativeTrunc && (d.chatLen || 0) > 500) tips.push('消息超过 500 条且聊天截断为「不限」：最有效的是「借用 ST 原生分页」设成 150–300，比折叠更原生');
    if (d.loadMs > 800) tips.push(`上次打开聊天耗时 ${Math.round(d.loadMs)}ms（${d.loadCount} 条），可调低聊天截断或开虚拟化改善后续滚动`);
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

function clampHudToViewport() {
    const el = state.hudEl;
    if (!el) return;
    const vv = window.visualViewport;
    const vw = (vv && vv.width) || window.innerWidth || 0;
    const vh = (vv && vv.height) || window.innerHeight || 0;
    if (!vw || !vh) return;
    const r = el.getBoundingClientRect();
    if (r.left < 0 || r.top < 0 || r.left + r.width > vw || r.top + r.height > vh) {
        el.style.left = clamp(r.left, 4, Math.max(4, vw - r.width - 4)) + 'px';
        el.style.top = clamp(r.top, 4, Math.max(4, vh - r.height - 4)) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }
}

function restoreHudPos() {    if (!state.hudEl) return;
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
        if (document.hidden) return;
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
            state.observer.observe(chat, { childList: true });
            state.observerOn = true;
        }
        return;
    }
    if (state.observer) state.observer.disconnect();
    state.observerTarget = chat;
    state.observer = new MutationObserver(() => {
        scheduleSweep();
    });
    // 消息节点都是 #chat 的直接子节点，只观察 childList 即可；
    // 消息体内容变化走 MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_EDITED 事件，不做全子树观察。
    state.observer.observe(chat, { childList: true });
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
    if (state.eventsBound) return;
    const c = ctx();
    if (!c || !c.eventSource || typeof c.eventSource.on !== 'function') return;
    state.eventsBound = true;
    const et = c.eventTypes || {};
    const es = c.eventSource;
    const on = (name, fn) => {
        const type = et[name];
        if (!type) return;
        try { es.on(type, fn); } catch (err) { /* 忽略 */ }
    };

    on('APP_READY', () => { state.mountTries = 0; mountUi(); observeChat(); hookScrollIdle(); startInputTiming(); });
    on('APP_INITIALIZED', () => { mountUi(); });
    on('CHAT_CHANGED', () => {
        state.trimExpanded = false;
        state.trimSig = '';
        state.chatLoadT0 = performance.now();
        state.chatLoadMs = 0;
        applyAll();
        hookScrollIdle();
        scheduleSweep();
    });
    on('CHAT_LOADED', () => {
        // 等到两帧之后计时，才包含真正的渲染与绘制，而不是只算消息解析
        const t0 = state.chatLoadT0 || performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const c = ctx();
            state.chatLoadMs = performance.now() - t0;
            state.chatLoadCount = c && Array.isArray(c.chat) ? c.chat.length : countMessages();
            state.chatLoadT0 = 0;
            if (isOn()) scheduleMeasureCvSize();
            scheduleSweep();
        }));
    });
    on('MESSAGE_RECEIVED', () => { measureRender(); hotZoneTick(); scheduleSweep(); });
    on('MESSAGE_SENT', () => { measureRender(); hotZoneTick(); scheduleSweep(); });
    on('MESSAGE_EDITED', scheduleSweep);
    on('MESSAGE_UPDATED', scheduleSweep);
    on('MESSAGE_SWIPED', scheduleSweep);
    on('MESSAGE_DELETED', scheduleSweep);
    on('USER_MESSAGE_RENDERED', () => { measureRender(); scheduleSweep(); });
    on('CHARACTER_MESSAGE_RENDERED', () => { measureRender(); hotZoneTick(); scheduleSweep(); });
    on('MORE_MESSAGES_LOADED', () => { scheduleSweep(); scheduleMeasureCvSize(); });
    on('STREAM_TOKEN_RECEIVED', () => { state.tokens++; });
    on('GENERATION_STARTED', () => {
        state.generating = true;
        state.genLt = 0;
        state.genT0 = performance.now();
        state.tokens = 0;
        pauseObserver();
        if (state.s && isOn() && state.s.genLite) document.body.classList.add('antilag-gen');
        else document.body.classList.remove('antilag-gen');
        applyStreamFadeSkip();
        applyHotZone();
    });
    const endGen = () => {
        state.generating = false;
        state.lastGenLt = state.genLt;
        if (state.genT0 && state.tokens) {
            const sec = (performance.now() - state.genT0) / 1000;
            state.tps = sec > 0.2 ? Math.round((state.tokens / sec) * 10) / 10 : 0;
        }
        state.genT0 = 0;
        document.body.classList.remove('antilag-gen');
        restoreStreamFadeSkip();
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
        // 上次会话留下过流式降频 / 原生分页记录：先还原 ST 原值，再按当前开关决定是否重新套用
        if (state.s.streamFpsOrig) restoreStreamFps();
        if (state.s.truncApplied) restoreNativeLimit();
        if (state.s.fadeApplied) restoreStreamFadeSkip();
        applyAll();
        mountUi();
        observeChat();
        hookScrollIdle();
        registerEvents();
        startMonitor();
        startInputTiming();

        window.addEventListener('resize', () => {
            clampHudToViewport();
        });
        // 手机键盘弹出/收起走 visualViewport，普通的 resize 不一定触发
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', clampHudToViewport);
        }

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

/** 生命周期钩子：被禁用时立即撤销所有注入（在 manifest.hooks.disable 里声明） */
export function onDisable() {
    if (!state.s) return Promise.resolve();
    restoreStreamFps();
    restoreNativeLimit();
    restoreStreamFadeSkip();
    state.s.enabled = false;
    applyAll();
    return Promise.resolve();
}

/** 生命周期钩子：重新启用时恢复注入（manifest.hooks.enable） */
export function onEnable() {
    if (!state.s) {
        init();
        return Promise.resolve();
    }
    state.s.enabled = true;
    save();
    applyAll();
    mountUi();
    observeChat();
    hookScrollIdle();
    registerEvents();
    startMonitor();
    startInputTiming();
    return Promise.resolve();
}

/** 生命周期钩子：更新/删除前清理残留（manifest.hooks.clean） */
export function onCleanUp() {
    try { restoreStreamFps(); } catch (err) { /* 忽略 */ }
    try { restoreNativeLimit(); } catch (err) { /* 忽略 */ }
    try { restoreStreamFadeSkip(); } catch (err) { /* 忽略 */ }
    ['antilag', 'antilag-virt', 'antilag-contain', 'antilag-gen', 'antilag-scrolling']
        .forEach((cls) => document.body && document.body.classList.remove(cls));
    if (document.documentElement) document.documentElement.classList.remove('antilag');
    if (state.styleEl) state.styleEl.remove();
    state.styleEl = null;
    document.getElementById('al-cv-style')?.remove();
    if (state.hudEl) state.hudEl.remove();
    state.hudEl = null;
    if (state.panelEl) state.panelEl.remove();
    state.panelEl = null;
    return Promise.resolve();
}
