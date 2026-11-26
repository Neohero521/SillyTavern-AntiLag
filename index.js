/**
 * AntiLag 流畅优化 v1.9.0 —— SillyTavern 扩展
 *
 * 设计原则：
 * 1) 默认「轻度」模式视觉零改动，只做不改变观感的减负；
 * 2) 所有结构性操作（折叠/裁剪）默认关闭，且编辑消息时暂停；
 * 3) 切换任何样式前保存 #chat 滚动位置，避免跳位；
 * 4) 自动降级只动「视觉开销」，不隐藏任何内容。
 * 依赖：仅 SillyTavern.getContext() 稳定 API。
 */

const MODULE_NAME = 'antilag';
const VERSION = '1.9.0';

/** 三档预设（只描述开关，不包含阈值） */
const PRESETS = {
    lite: {
        virtualize: true, lazyImg: true, genLite: true, willChange: true, lazyFrame: false,
        killBlur: false, killBgAnim: false, killShadow: false, killTransitions: false,
        containChat: false, trimHistory: false, clipLong: false, smoothStreamSkip: false,
    },
    standard: {
        virtualize: true, lazyImg: true, genLite: true, willChange: true, lazyFrame: true,
        killBlur: true, killBgAnim: true, killShadow: false, killTransitions: false,
        containChat: false, trimHistory: false, clipLong: false, smoothStreamSkip: true,
    },
    turbo: {
        virtualize: true, lazyImg: true, genLite: true, willChange: true, lazyFrame: true,
        killBlur: true, killBgAnim: true, killShadow: true, killTransitions: true,
        containChat: true, trimHistory: true, clipLong: false, smoothStreamSkip: true,
    },
};

const MODE_LABEL = { lite: '轻度', standard: '均衡', turbo: '极速' };

/** 极速模式（含自动降级）会额外拉起的纯视觉项 */
const BOOST_KEYS = ['virtualize', 'killBlur', 'killBgAnim', 'killShadow', 'killTransitions', 'willChange', 'containChat', 'smoothStreamSkip'];
const VISUAL_KEYS = Object.keys(PRESETS.turbo);

/** 会随每条消息/每次生成触发额外工作的内置扩展（extension_settings 的键名） */
const HEAVY_EXTS = ['expressions', 'vectors', 'caption', 'translate', 'tts', 'memory', 'quickReply', 'sd', 'regex'];

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
    truncAppliedValue: 0,
    clipLong: false,
    clipChars: 3000,
    codeDefer: true,
    codeDeferChars: 8000,
    codeDeferTotalChars: 30000,
    charTokenSkip: true,
    charTokenSkipChars: 20000,

    pauseOnEdit: true,
    preserveScroll: true,
    scrollIdle: true,
    scrollBlur: false,
    streamFps: 0,
    streamFpsOrig: 0,
    streamFpsApplied: 0,
    streamFadeSkip: false,
    fadeApplied: false,
    smoothStreamSkip: false,
    smoothApplied: false,

    autoDetect: true,
    fpsThreshold: 28,
    longTaskMs: 150,

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
    ['al-smoothskip', 'smoothStreamSkip'],
    ['al-willchange', 'willChange'],
    ['al-killblur', 'killBlur'],
    ['al-killblur-all', 'killBlurAll'],
    ['al-killbg', 'killBgAnim'],
    ['al-killshadow', 'killShadow'],
    ['al-killtrans', 'killTransitions'],
    ['al-contain', 'containChat'],
    ['al-trim', 'trimHistory'],
    ['al-codedefer', 'codeDefer'],
    ['al-chartokenskip', 'charTokenSkip'],
    ['al-clip', 'clipLong'],
    ['al-scrollidle', 'scrollIdle'],
    ['al-scrollblur', 'scrollBlur'],
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
    ['al-codethreshold', 'codeDeferChars', 1000, 200000],
    ['al-codetotal', 'codeDeferTotalChars', 0, 500000],
    ['al-chartokenthreshold', 'charTokenSkipChars', 5000, 200000],
    ['al-fps', 'fpsThreshold', 10, 60],
    ['al-long', 'longTaskMs', 50, 3000],
];

const state = {
    s: null,
    styleEl: null,
    panelEl: null,
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
    chatLoading: false,
    hotTotal: 0,
    generating: false,
    genLt: 0,
    lastGenLt: 0,
    mesCount: 0,
    applyQueued: false,
    nativeTrunc: 0,
    nativeChanged: false,
    cvSize: 0,
    chatLoadT0: 0,
    chatLoadTimer: 0,
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
    eventBindings: [],
    eventSource: null,
    scrollHandler: null,
    scrollTarget: null,
    disposed: false,
    lastRenderMs: 0,
    renderT0: 0,
    clipSig: '',
    clipDirty: true,
    codeBlocks: new Map(),
    codeMesKeys: new Map(),
    codeSeq: 0,
    codePending: null,
    codeViewHandlers: new Map(),
    codeHydrateRaf: 0,
    codeHydrateTimer: 0,
    codeSweepTimer: 0,
    codeIO: null,
    codeInsertObserver: null,
    codeInsertTarget: null,
    codeFormatterHooked: false,
    codeRerenderPending: false,
    codeScanDone: false,
    smoothApplied: false,
    charGuardTarget: null,
    charGuardObserver: null,
    charGuardInput: null,
    charGuardTimer: 0,
    codeClickTarget: null,
    codeClickHandler: null,
    codeKeyHandler: null,
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
    if (!chat) return 0;
    // 直接子节点就是消息；用 live collection，避免每次扫描都分配一份 NodeList 数组
    try {
        return chat.getElementsByClassName('mes').length;
    } catch (err) {
        return chat.querySelectorAll('.mes').length;
    }
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
        state.s.truncAppliedValue = want;
        save();
    } else if (state.s.truncAppliedValue !== want) {
        state.s.truncAppliedValue = want;
        save();
    }
    if (pu.chat_truncation !== want) {
        pu.chat_truncation = want;
        state.nativeChanged = true;
    }
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
    // 只有仍是我们关掉的状态才还原；用户在手期间自己重新打开/关闭都尊重用户
    if (pu.stream_fade_in === false) pu.stream_fade_in = true;
    state.s.fadeApplied = false;
    save();
}

/**
 * ST 1.19 的「平滑流式」会在每个流式分片之间 await 一个人工延迟（标点更久），
 * 生成越长越像挤牙膏；它不会减少主线程解析，但会拖长整体等待。生成期间临时关掉，
 * 结束立即还原。只改 power_user.smooth_streaming，不动 ST 的 FPS 设置。
 */
function applySmoothStreamSkip() {
    const pu = powerUser();
    if (!pu || !state.s) return;
    const want = Boolean(isOn() && state.generating && state.s.smoothStreamSkip);
    if (!want) { restoreSmoothStreamSkip(); return; }
    if (pu.smooth_streaming) {
        state.s.smoothApplied = true;
        state.smoothApplied = true;
        save();
        pu.smooth_streaming = false;
    }
}

function restoreSmoothStreamSkip() {
    const pu = powerUser();
    if (!pu || !state.s || !state.s.smoothApplied) return;
    if (pu.smooth_streaming === false) pu.smooth_streaming = true;
    state.s.smoothApplied = false;
    state.smoothApplied = false;
    save();
}

/** 生成期间新消息可能落在热区之外：补一次热区标记（消息是直接子节点，成本极低） */
function hotZoneTick() {
    if (!isOn() || !document.body.classList.contains('antilag-virt')) return;
    applyHotZone();
}

let rerenderTimer = 0;
/** 原生分页改动后重新渲染当前聊天（ST 的 printMessages 是公开 API） */
function rerenderChatSoon() {
    if (rerenderTimer) return;
    rerenderTimer = setTimeout(() => {
        rerenderTimer = 0;
        if (state.disposed || !isOn() || state.generating || state.chatLoading) return;
        // 马上要整体重渲染：让折叠/裁剪在渲染后重新判定
        state.trimSig = '';
        state.clipDirty = true;
        const c = ctx();
        if (!c || typeof c.printMessages !== 'function') return;
        if (!Array.isArray(c.chat) || !c.chat.length) return;
        Promise.resolve().then(() => c.printMessages()).then(() => {
            // printMessages 是 async，渲染完成后重算一次虚拟化门控/折叠条件
            if (!state.disposed) applyAll();
        }).catch((err) => console.warn('[AntiLag] 重新渲染失败', err));
    }, 400);
}

/** 代码块设置变化后的重渲染：生成中先记着，结束再补，避免流式时抢渲染 */
function queueCodeRerender() {
    if (state.generating || state.chatLoading) {
        state.codeRerenderPending = true;
        return;
    }
    state.codeRerenderPending = false;
    rerenderChatSoon();
}

function restoreNativeLimit() {
    const pu = powerUser();
    if (!pu || !state.s || !state.s.truncApplied) return;
    // 必须用「实际写进 ST 的值」判断，不能用当前选择值：用户把下拉改回「不改(0)」时，
    // nativeLimit 已经是 0，若拿 0 去比对就永远不会还原。
    const applied = Number(state.s.truncAppliedValue) || Number(state.s.nativeLimit) || 0;
    // 只在「当前值仍是我们改的那个」时才还原，用户在 ST 里自己改过就尊重用户
    if (applied && Number(pu.chat_truncation) === applied) {
        const orig = Number(state.s.truncOrig) || 0;
        if (pu.chat_truncation !== orig) {
            pu.chat_truncation = orig;
            state.nativeChanged = true;
        }
    }
    state.s.truncApplied = false;
    state.s.truncAppliedValue = 0;
    save();
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function loadSettings() {
    const store = settingsStore();
    const incoming = (store[MODULE_NAME] && typeof store[MODULE_NAME] === 'object') ? store[MODULE_NAME] : {};
    const s = Object.assign({}, DEFAULTS, incoming);

    s.virtualizeMin = clamp(parseInt(s.virtualizeMin, 10) || DEFAULTS.virtualizeMin, 30, 500);
    s.trimKeep = clamp(parseInt(s.trimKeep, 10) || DEFAULTS.trimKeep, 10, 3000);
    s.clipChars = clamp(parseInt(s.clipChars, 10) || DEFAULTS.clipChars, 500, 20000);
    s.codeDeferChars = clamp(parseInt(s.codeDeferChars, 10) || DEFAULTS.codeDeferChars, 1000, 200000);
    s.codeDefer = s.codeDefer === undefined ? DEFAULTS.codeDefer : Boolean(s.codeDefer);
    s.codeDeferTotalChars = s.codeDeferTotalChars === undefined ? DEFAULTS.codeDeferTotalChars : clamp(parseInt(s.codeDeferTotalChars, 10) || 0, 0, 500000);
    s.charTokenSkipChars = clamp(parseInt(s.charTokenSkipChars, 10) || DEFAULTS.charTokenSkipChars, 5000, 200000);
    s.charTokenSkip = s.charTokenSkip === undefined ? DEFAULTS.charTokenSkip : Boolean(s.charTokenSkip);
    s.fpsThreshold = clamp(parseInt(s.fpsThreshold, 10) || DEFAULTS.fpsThreshold, 10, 60);
    s.longTaskMs = clamp(parseInt(s.longTaskMs, 10) || DEFAULTS.longTaskMs, 50, 3000);
    s.streamFps = [0, 10, 15, 20].includes(Number(s.streamFps)) ? Number(s.streamFps) : 0;
    s.streamFpsOrig = clamp(parseInt(s.streamFpsOrig, 10) || 0, 0, 240);
    s.streamFpsApplied = clamp(parseInt(s.streamFpsApplied, 10) || 0, 0, 240);
    s.fadeApplied = Boolean(s.fadeApplied);
    // v1.7.9 新设置：老用户如果已经是均衡/极速档，默认继承该档的「生成期关平滑流式」；
    // 轻度档仍保持关闭，避免安装后悄悄改变原有的逐字节奏。
    if (incoming.smoothStreamSkip === undefined && (s.mode === 'standard' || s.mode === 'turbo')) {
        s.smoothStreamSkip = true;
    }
    s.smoothStreamSkip = s.smoothStreamSkip === undefined ? DEFAULTS.smoothStreamSkip : Boolean(s.smoothStreamSkip);
    s.smoothApplied = Boolean(s.smoothApplied);
    s.nativeLimit = [0, 50, 80, 100, 150, 300].includes(Number(s.nativeLimit)) ? Number(s.nativeLimit) : 0;
    s.truncOrig = clamp(parseInt(s.truncOrig, 10) || 0, 0, 5000);
    s.truncApplied = Boolean(s.truncApplied);
    // 兼容 v1.6.0 旧数据：没有记录「我们写进去的值」时回落到 nativeLimit
    s.truncAppliedValue = clamp(parseInt(s.truncAppliedValue, 10) || (s.truncApplied ? s.nativeLimit : 0), 0, 5000);
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
            'body.antilag-virt #chat .mes:not(.al-hot){content-visibility:auto;contain-intrinsic-size:var(--al-cv-size, 240px);contain-intrinsic-size:auto var(--al-cv-size, 240px);will-change:auto;}',
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
            '/* 停用动画背景与 fixed 背景：ST 真正的 fixed 背景是 #bg1（backgrounds.css），不是 body/#chat */',
            'html.antilag body,body.antilag #chat,body.antilag .background{animation:none !important;}',
            'body.antilag #bg1,body.antilag #bg_custom,body.antilag #bg_custom_content{background-attachment:scroll !important;transition:none !important;}',
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
            '/* 清理被滥用的 will-change，回收 GPU 图层；但保留 ST 滑动动画 .slide 自己的合成提示 */',
            'body.antilag #chat *:not(.slide){will-change:auto !important;}',
            '',
        ].join('\n');
    }

    if (document.body.classList.contains('antilag-contain')) {
        css += [
            '/* 隔离聊天区的布局与绘制，避免抽屉/输入框重排牵连 */',
            'body.antilag-contain #chat{contain:layout;overscroll-behavior:contain;}',
            '',
        ].join('\n');
    }

    if (s.genLite) {
        css += [
            '/* 生成中：隔离最后一条消息的重绘，并去掉其重特效 */',
            '/* 只隔离布局与样式：不加 paint，避免流式期间裁掉消息内的阴影/悬浮元素 */',
            'body.antilag-gen #chat .last_mes{contain:layout;}',
            '/* 正在流式的最后一条绝不跳过布局，避免 content-visibility 与逐字重绘打架 */',
            'body.antilag-gen #chat .mes:last-child{content-visibility:visible !important;}',
            'body.antilag-gen #chat .last_mes,body.antilag-gen #chat .last_mes *{box-shadow:none !important;text-shadow:none !important;filter:none !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;transition:none !important;animation:none !important;}',
            '',
        ].join('\n');
    }

    if (s.scrollBlur) {
        css += [
            '/* 滚动期间临时关掉聊天区模糊：滚动时每帧都要重新采样背景，低配机收益最大；停手 160ms 自动恢复 */',
            'body.antilag-scrolling #chat,body.antilag-scrolling #chat *,body.antilag-scrolling #send_form,body.antilag-scrolling #form_sheld{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
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
    const atBottom = chat ? (top + (chat.clientHeight || 0) >= (chat.scrollHeight || 0) - 8) : false;
    style.textContent = css;
    if (chat && top !== null && state.s.preserveScroll) {
        // 贴底时保持贴底（虚拟化/contain 会改变 scrollHeight），否则只回填明显位移
        if (atBottom) chat.scrollTop = chat.scrollHeight || 0;
        else if (Math.abs(chat.scrollTop - top) > 1) chat.scrollTop = top;
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
    const virt = on && eff('virtualize') && !nativePagingActive() && !state.chatLoading && mes >= state.s.virtualizeMin;
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
    const mes = chat.getElementsByClassName('mes');
    if (!on) {
        if (state.hotTotal) {
            const hots = chat.getElementsByClassName('al-hot');
            while (hots.length) hots[0].classList.remove('al-hot');
            state.hotTotal = 0;
        }
        return;
    }
    const total = mes.length;
    const hot = Math.min(30, total);
    // 只动尾部热区；消息总数变化（前插/删除）时才清理一次旧热区，避免每次扫描全部消息
    for (let i = total - hot; i < total; i++) {
        if (!mes[i].classList.contains('al-hot')) mes[i].classList.add('al-hot');
    }
    if (state.hotTotal !== total) {
        for (let i = 0; i < total - hot; i++) {
            if (mes[i].classList.contains('al-hot')) mes[i].classList.remove('al-hot');
        }
        state.hotTotal = total;
    }
}

/**
 * 用实测中位高度作为 contain-intrinsic-size 的兜底值。
 * content-visibility 的元素未渲染时用估高，估高偏差会表现为滚动条跳动，所以取真实样本。
 */
function measureCvSize() {
    if (state.disposed) return;
    const chat = chatEl();
    if (!chat) return;
    // 只量热区（永不虚拟化）的真实高度：虚拟化元素返回的是估高，用它算中位数会自我循环
    const sample = Array.from(chat.querySelectorAll('.mes.al-hot')).slice(-30);
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
    if (state.disposed || !state.s || !isOn()) return;
    requestAnimationFrame(() => {
        if (state.disposed) return;
        measureCvSize();
        if (!state.cvSize) setTimeout(() => { if (!state.disposed) measureCvSize(); }, 300);
    });
}

/** 滚动期降载：滚动中屏蔽按钮命中测试与过渡，停止 160ms 后自动恢复 */
function hookScrollIdle() {
    const chat = chatEl();
    if (!chat) return;
    if (state.scrollHandler && state.scrollTarget === chat) return;
    if (state.scrollHandler && state.scrollTarget) {
        state.scrollTarget.removeEventListener('scroll', state.scrollHandler);
    }
    const handler = () => {
        if (!state.s || !isOn() || (!state.s.scrollIdle && !state.s.scrollBlur)) return;
        if (!document.body.classList.contains('antilag-scrolling')) {
            document.body.classList.add('antilag-scrolling');
        }
        clearTimeout(state.scrollTimer);
        state.scrollTimer = setTimeout(() => {
            document.body.classList.remove('antilag-scrolling');
        }, 160);
    };
    state.scrollHandler = handler;
    state.scrollTarget = chat;
    chat.addEventListener('scroll', handler, { passive: true });
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
    // 必须持久化「我们写进去的值」：否则页面刷新/崩溃后无法判断当前值是不是我们改的，原值会丢
    if (state.s.streamFpsApplied !== target) {
        state.s.streamFpsApplied = target;
        save();
    }
    if (pu.streaming_fps !== target) pu.streaming_fps = target;
    return target;
}

function restoreStreamFps() {
    const pu = powerUser();
    if (!pu || !state.s) return;
    const orig = Number(state.s.streamFpsOrig) || 0;
    const applied = Number(state.s.streamFpsApplied) || 0;
    // 只在当前值仍是我们写进去的那个时才还原，用户在 ST 设置里改过就尊重用户
    if (orig && applied && Number(pu.streaming_fps) === applied) pu.streaming_fps = orig;
    if (state.s.streamFpsOrig || state.s.streamFpsApplied) {
        state.s.streamFpsOrig = 0;
        state.s.streamFpsApplied = 0;
        save();
    }
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
    if (state.disposed || !state.s || !document.body) return;
    state.applyQueued = false;

    const on = isOn();
    const mes = countMessages();
    state.mesCount = mes;
    state.nativeTrunc = nativeTruncation();
    // 原生分页开着时不做虚拟化：ST 每次「Show more」都会前插并补偿滚动，content-visibility 会把高度估歪
    const virt = on && eff('virtualize') && !nativePagingActive() && !state.chatLoading && mes >= state.s.virtualizeMin;
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
        applySmoothStreamSkip();
    } else {
        restoreStreamFps();
        restoreNativeLimit();
        restoreStreamFadeSkip();
        restoreSmoothStreamSkip();
    }
    if (on && state.nativeChanged && !state.generating && !state.chatLoading) {
        // 生成中/加载中先留着标记，结束后再统一重渲染
        state.nativeChanged = false;
        rerenderChatSoon();
    }
    if (!on) {
        clearStructural();
    } else {
        applyImages();
        applyTrim();
        applyClip();
    }

    syncCodeDefer();
    if (isOn() && state.s.charTokenSkip) {
        bindCharacterTokenGuard();
        syncCharacterTokenGuard();
    } else {
        unbindCharacterTokenGuard();
    }
    syncPanel();
    updateBadge();
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
    clearImages();
    const chat = chatEl();
    if (!chat) return;
    chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
    chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));
    chat.querySelectorAll('.mes.al-clip').forEach((el) => el.classList.remove('al-clip'));
    chat.querySelectorAll('.al-clip-btn').forEach((el) => el.remove());
    chat.querySelectorAll('.mes[data-al-expanded]').forEach((el) => { delete el.dataset.alExpanded; });
    chat.querySelectorAll('.mes.al-hot').forEach((el) => el.classList.remove('al-hot'));
    state.hotTotal = 0;
    // 关闭/卸载后不留签名，重新启用时要重新做一次全量判定
    state.trimSig = 'off';
    state.trimExpanded = false;
    state.clipSig = '';
    state.clipDirty = true;
}

/** 撤销我们自己加在媒体上的懒加载属性；原本就有 loading/decoding 的不动 */
function cleanupMedia(el) {
    if (el.dataset.alLoading === '1') el.removeAttribute('loading');
    if (el.dataset.alDecoding === '1') el.removeAttribute('decoding');
    el.classList.remove('al-lazy');
    delete el.dataset.alLazy;
    delete el.dataset.alLoading;
    delete el.dataset.alDecoding;
}

function clearLazy(selector) {
    document.querySelectorAll(selector).forEach(cleanupMedia);
}

function clearImages() {
    clearLazy('#chat [data-al-lazy]');
}

function applyImages() {
    // 暂停/禁用时扫描仍可能被其它事件触发，这里必须一起收掉，避免「暂停了还在加属性」
    if (!isOn()) { clearImages(); return; }
    const wantImg = eff('lazyImg');
    const wantFrame = eff('lazyFrame');
    // 两个开关独立：关图片不能顺手把 iframe 的懒加载也撤掉（v1.6.1 修正）
    if (!wantImg) clearLazy('#chat .mes_block img[data-al-lazy]');
    if (!wantFrame) clearLazy('#chat .mes_block iframe[data-al-lazy]');
    // 只处理消息正文里的图（含媒体块）：头像同 URL 且尺寸小，懒加载反而会在滚动时闪加载
    if (wantImg) {
        document.querySelectorAll('#chat .mes_block img:not([data-al-lazy])').forEach((img) => {
            img.dataset.alLazy = '1';
            img.classList.add('al-lazy');
            if (!img.hasAttribute('loading')) {
                img.setAttribute('loading', 'lazy');
                img.dataset.alLoading = '1';
            }
            if (!img.hasAttribute('decoding')) {
                img.setAttribute('decoding', 'async');
                img.dataset.alDecoding = '1';
            }
        });
    }
    if (wantFrame) {
        document.querySelectorAll('#chat .mes_block iframe:not([data-al-lazy])').forEach((frame) => {
            frame.dataset.alLazy = '1';
            if (!frame.hasAttribute('loading')) {
                frame.setAttribute('loading', 'lazy');
                frame.dataset.alLoading = '1';
            }
        });
    }
}

/* ------------------------------------------------------------------ */
/* 超大代码完整直出（角色卡/消息里的巨大代码是 ST 最贵的一类渲染）    */
/* ------------------------------------------------------------------ */

// 只处理闭合的围栏代码块：```lang\n...\n``` 或 ~~~lang\n...\n~~~
// 在 AFTER_REGEX（Showdown 之前）就把超大代码换成短 token，避免每次流式 tick
// 都让 Showdown + DOMPurify + highlight.js 重新啃一遍几十万字符。
const FENCE_RE = /(^|\n)([ \t]{0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function escapeCodeHtml(text) {
    // 一次扫描转义，避免对几十万字符做五遍 replace
    return String(text).replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);
}

function formatCount(n) {
    try { return Number(n || 0).toLocaleString('zh-CN'); } catch (err) { return String(n || 0); }
}

/* ------------------------------------------------------------------ */
/* 可视行虚拟渲染：2M+ 字符也只让浏览器画几十行                        */
/* ------------------------------------------------------------------ */
// 完整代码保存在 state.codeBlocks 里，DOM 只保留“当前滚动窗口内的行”。
// 关键：不再把一个 2.69M 字符的文本节点塞进 pre，避免浏览器在超长文本
// 节点上布局/绘制失败；同时只给这些行生成 span，节点数不随总代码增长。

const CODE_KEYWORDS = new Set([
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for',
    'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
    'new', 'of', 'package', 'private', 'protected', 'public', 'return', 'set', 'static', 'super',
    'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'def', 'elif', 'except', 'exec', 'global', 'lambda', 'nonlocal', 'pass', 'raise', 'print',
    'and', 'or', 'not', 'is', 'assert', 'del', 'None', 'True', 'False',
    'fn', 'impl', 'mut', 'pub', 'trait', 'use', 'where', 'match', 'loop', 'struct', 'crate',
    'select', 'insert', 'update', 'create', 'table', 'drop', 'alter', 'join', 'group',
    'order', 'limit', 'values', 'into', 'primary', 'key', 'foreign', 'references', 'index',
]);
const CODE_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity']);
const CODE_TOKEN_RE = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
const CODE_LINE_MAX = 2000;
const CODE_LINE_HEIGHT = 20;

function codeTokenType(token, index, source) {
    if (!token) return '';
    if (token[0] === '"' || token[0] === '\'' || token[0] === '`') return 'string';
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (/^\d/.test(token)) return 'number';
    if (!/^[A-Za-z_$]/.test(token)) return '';
    if (CODE_LITERALS.has(token)) return 'literal';
    if (CODE_KEYWORDS.has(token)) return 'keyword';
    const prev = source[index - 1] || '';
    if (prev === '.') return 'property';
    const after = source.slice(index + token.length).match(/^\s*(.)/);
    if (after && after[1] === '(') return 'title';
    return '';
}

function codeVisualLines(code) {
    // 超长单行（压缩后的前端代码常见）按 2000 字切段，避免“一行 2.69M”
    // 又把浏览器顶回超长文本节点的问题；复制时仍用 rec.code，原文不变。
    const rows = [];
    String(code == null ? '' : code).replace(/\r\n?/g, '\n').split('\n').forEach((line) => {
        if (line.length <= CODE_LINE_MAX) {
            rows.push(line);
            return;
        }
        for (let at = 0; at < line.length; at += CODE_LINE_MAX) {
            rows.push(line.slice(at, at + CODE_LINE_MAX));
        }
    });
    return rows;
}

function highlightCodeLine(line) {
    if (!line) return '';
    let out = '';
    let last = 0;
    CODE_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = CODE_TOKEN_RE.exec(line)) !== null) {
        if (m.index > last) out += escapeCodeHtml(line.slice(last, m.index));
        const type = codeTokenType(m[0], m.index, line);
        if (type) {
            out += `<span class="al-code-token al-code-token-${type}">${escapeCodeHtml(m[0])}</span>`;
        } else {
            out += escapeCodeHtml(m[0]);
        }
        last = m.index + m[0].length;
        if (CODE_TOKEN_RE.lastIndex === m.index) CODE_TOKEN_RE.lastIndex++;
    }
    out += escapeCodeHtml(line.slice(last));
    return out;
}

function renderCodeWindow(pre) {
    const st = pre && pre.__alCodeState;
    if (!st || !pre.isConnected) return;
    const viewH = pre.clientHeight || 300;
    const top = pre.scrollTop || 0;
    const first = Math.max(0, Math.floor(top / CODE_LINE_HEIGHT) - 10);
    const last = Math.min(st.lines.length, first + Math.ceil(viewH / CODE_LINE_HEIGHT) + 24);
    st.top.style.height = `${first * CODE_LINE_HEIGHT}px`;
    st.bottom.style.height = `${(st.lines.length - last) * CODE_LINE_HEIGHT}px`;
    let html = '';
    for (let i = first; i < last; i++) {
        html += `<div class="al-code-line">${highlightCodeLine(st.lines[i])}</div>`;
    }
    st.body.innerHTML = html;
}

function hydrateCodeView(pre) {
    if (!pre) return;
    // 之前补水到一半失败，dataset 可能已经是 1，但 __alCodeState 没建立；允许重试
    if (pre.dataset.alCodeHydrated === '1' && pre.__alCodeState) return;
    pre.dataset.alCodeHydrated = '1';
    const block = pre.closest && pre.closest('.al-code-full');
    const rec = block && state.codeBlocks.get(block.dataset.alCode);
    if (!rec) {
        pre.textContent = '代码数据已释放，请刷新聊天';
        return;
    }
    const lines = codeVisualLines(rec.code);
    if (!lines.length) return;
    const top = document.createElement('div');
    const body = document.createElement('div');
    const bottom = document.createElement('div');
    top.className = 'al-code-top';
    body.className = 'al-code-lines';
    bottom.className = 'al-code-bottom';
    pre.textContent = '';
    pre.appendChild(top);
    pre.appendChild(body);
    pre.appendChild(bottom);
    pre.__alCodeState = { lines, top, body, bottom };
    let frame = 0;
    const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            renderCodeWindow(pre);
        });
    };
    pre.addEventListener('scroll', onScroll, { passive: true });
    state.codeViewHandlers.set(pre, onScroll);
    // 先同步画一帧，再下一帧校正；某些主题/浏览器会延迟 rAF，不能只等 rAF
    renderCodeWindow(pre);
    requestAnimationFrame(() => renderCodeWindow(pre));
}

function cleanupCodeView(pre) {
    if (!pre) return;
    const handler = state.codeViewHandlers.get(pre);
    if (handler) pre.removeEventListener('scroll', handler);
    state.codeViewHandlers.delete(pre);
    if (pre.__alCodeState) pre.__alCodeState = null;
}

function hydrateCodeViews() {
    const chat = chatEl();
    if (chat) ensureCodeInsertObserver(chat);
    const io = ensureCodeObserver();
    // 不只扫 #chat：角色卡预览/弹窗里也可能被 MessageFormatter 生成同样的空壳
    document.querySelectorAll('.al-code-full').forEach((block) => {
        if (io && !block.__alIoObserved) {
            block.__alIoObserved = true;
            try { io.observe(block); } catch (err) { /* 忽略 */ }
        }
        if (block.dataset.alCodeReady === '1') return;
        const pre = block.querySelector('.al-code-view');
        if (!pre) return;
        block.dataset.alCodeReady = '1';
        hydrateCodeView(pre);
    });
}

/** 监听 .mes_text 内容写入：不依赖 ST 事件的先后顺序，空壳一落地就补水 */
function ensureCodeInsertObserver(chat) {
    if (!chat || state.disposed || typeof MutationObserver !== 'function') return;
    if (state.codeInsertObserver && state.codeInsertTarget && state.codeInsertTarget.isConnected) return;
    if (state.codeInsertObserver) {
        try { state.codeInsertObserver.disconnect(); } catch (err) { /* 忽略 */ }
    }
    state.codeInsertTarget = chat;
    state.codeInsertObserver = new MutationObserver((records) => {
        if (!state.s || !isOn() || !state.s.codeDefer) return;
        for (const record of records) {
            // 只关心消息体里新插入/替换出来的代码块；代码行重建不触发补水
            if (record.target && record.target.closest && record.target.closest('.al-code-full')) continue;
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                const hit = (node.matches && node.matches('.al-code-full'))
                    || (node.querySelector && node.querySelector('.al-code-full'));
                if (hit) {
                    hydrateCodeViews();
                    scheduleCodeHydration();
                    return;
                }
            }
        }
    });
    try {
        state.codeInsertObserver.observe(chat, { childList: true, subtree: true });
    } catch (err) {
        state.codeInsertObserver = null;
    }
}

function ensureCodeObserver() {
    if (state.codeIO || typeof IntersectionObserver !== 'function') return state.codeIO;
    state.codeIO = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const block = entry.target;
            const pre = block.querySelector && block.querySelector('.al-code-view');
            if (!pre) return;
            if (pre.dataset.alCodeHydrated === '1') {
                requestAnimationFrame(() => renderCodeWindow(pre));
            } else if (block.dataset.alCodeReady !== '1') {
                block.dataset.alCodeReady = '1';
                hydrateCodeView(pre);
            }
        });
    }, { rootMargin: '200px 0px' });
    return state.codeIO;
}

function scheduleCodeHydration() {
    if (state.codeHydrateRaf) return;
    state.codeHydrateRaf = requestAnimationFrame(() => {
        state.codeHydrateRaf = 0;
        hydrateCodeViews();
    });
}

/** 极少数主题会把 .mes_text 的写入拖到 rAF 之后；给一个迟到兜底，避免永远停在“代码加载中” */
function scheduleCodeHydrationFallback() {
    if (state.codeHydrateTimer) return;
    state.codeHydrateTimer = setTimeout(() => {
        state.codeHydrateTimer = 0;
        hydrateCodeViews();
    }, 150);
}

/** 最后一道保险：每秒扫一次仍停在“代码加载中”的块，直接强制补水；不依赖任何 ST 事件 */
function retryStuckCodeBlocks() {
    if (!state.s || !isOn() || !state.s.codeDefer) return;
    document.querySelectorAll('.al-code-full').forEach((block) => {
        const pre = block.querySelector && block.querySelector('.al-code-view');
        if (!pre) return;
        if (pre.__alCodeState && pre.querySelector('.al-code-line')) return;
        if (!pre.textContent.includes('代码加载中')) return;
        delete block.dataset.alCodeReady;
        delete pre.dataset.alCodeHydrated;
        try {
            hydrateCodeView(pre);
        } catch (err) {
            console.error('[AntiLag] 代码块补水失败', err);
            pre.textContent = '代码渲染失败，请刷新聊天';
        }
    });
}

function startCodeSweep() {
    if (state.codeSweepTimer || !state.s || !isOn() || !state.s.codeDefer) return;
    state.codeSweepTimer = setInterval(retryStuckCodeBlocks, 1000);
}

function stopCodeSweep() {
    if (!state.codeSweepTimer) return;
    try { clearInterval(state.codeSweepTimer); } catch (err) { /* 忽略 */ }
    state.codeSweepTimer = 0;
}

function cleanupCodeViews() {
    for (const pre of state.codeViewHandlers.keys()) cleanupCodeView(pre);
    state.codeViewHandlers.clear();
    document.querySelectorAll('.al-code-full').forEach((block) => {
        delete block.dataset.alCodeReady;
        block.__alIoObserved = false;
        const pre = block.querySelector('.al-code-view');
        if (pre) {
            delete pre.dataset.alCodeHydrated;
            pre.__alCodeState = null;
        }
    });
    if (state.codeIO) {
        try { state.codeIO.disconnect(); } catch (err) { /* 忽略 */ }
        state.codeIO = null;
    }
    if (state.codeInsertObserver) {
        try { state.codeInsertObserver.disconnect(); } catch (err) { /* 忽略 */ }
        state.codeInsertObserver = null;
        state.codeInsertTarget = null;
    }
    if (state.codeHydrateRaf) {
        try { cancelAnimationFrame(state.codeHydrateRaf); } catch (err) { /* 忽略 */ }
        state.codeHydrateRaf = 0;
    }
    if (state.codeHydrateTimer) {
        try { clearTimeout(state.codeHydrateTimer); } catch (err) { /* 忽略 */ }
        state.codeHydrateTimer = 0;
    }
    stopCodeSweep();
}

function codeLang(info) {
    const first = String(info || '').trim().split(/\s+/)[0] || 'code';
    return first.replace(/[^\w+#.-]/g, '').slice(0, 24) || 'code';
}

/** 酒馆助手(JS-Slash-Runner)会把包含 <html>/<head>/<body> 的前端代码块接管成 iframe。
 *  v1.7.8 先 token 化绕过 Showdown，afterMarkdown 再还原成原生 <pre><code>；不能留成虚拟空壳。
 */
function isFrontendCode(code) {
    const text = String(code == null ? '' : code);
    return text.includes('html>') || text.includes('<head>') || text.includes('<body');
}

function pruneCodeMessage(mesId) {
    const id = String(mesId);
    const keys = state.codeMesKeys.get(id);
    if (!keys) return;
    keys.forEach((key) => state.codeBlocks.delete(key));
    state.codeMesKeys.delete(id);
}

function buildFullCodeBlock(rec) {
    // 代码正文不放进 HTML 字符串：避免 2M+ 字符的文本先被 DOMPurify 扫一遍，
    // 也避免浏览器在超长文本节点上布局失败。渲染后由 hydrateCodeView()
    // 从 state.codeBlocks 取出完整代码，只填充可视窗口的行。
    return `<div class="al-code-full" data-al-code="${rec.key}" data-al-code-len="${rec.chars}">`
        + '<div class="al-code-head"><span class="al-code-title">代码块</span>'
        + `<span class="al-code-meta">${escapeCodeHtml(rec.lang)} · ${formatCount(rec.chars)} 字符 · v${VERSION}</span>`
        + '<span class="al-code-copy" role="button" tabindex="0" data-al-code-action="copy">复制</span></div>'
        + '<pre class="al-code-view" data-al-code-view tabindex="0"><span class="al-code-loading">代码加载中… v' + VERSION + '</span></pre>'
        + '</div>';
}

/** 前端代码快通道：不在 AntiLag 里画虚拟行，而是直接生成原生 <pre><code>。
 *  这样绕过 Showdown/encode_tags 对 2M+ HTML 的解析，又让酒馆助手能照常接管 iframe。
 */
function buildFrontendCodeBlock(rec) {
    // no-highlight 让 ST 的 hljs 直接跳过 2M+ 前端代码；酒馆助手会从 code.text() 读走原文
    return `<pre class="al-fe-native"><code class="no-highlight">${escapeCodeHtml(rec.code)}</code></pre>`;
}

function fullCodeElement(rec) {
    const holder = document.createElement('div');
    holder.innerHTML = buildFullCodeBlock(rec);
    return holder.firstElementChild;
}

/** 把一段消息 markdown 里的超大围栏代码换成 token；token 在 AFTER_MARKDOWN 再换成完整直出块 */
function encodeHugeCodeFences(mes, context) {
    state.codePending = null;
    if (state.disposed || !state.s || !state.s.enabled || !state.s.codeDefer || !isOn()) return mes;
    const threshold = Number(state.s.codeDeferChars) || 8000;
    const totalThreshold = Number(state.s.codeDeferTotalChars) || 0;
    const mesId = context && Number.isFinite(Number(context.messageId)) ? Number(context.messageId) : 'x';

    // 同一消息重新渲染时，旧代码记录已经没有 DOM 引用了，及时释放
    pruneCodeMessage(mesId);
    const keys = [];
    state.codeMesKeys.set(String(mesId), keys);

    const matches = [...mes.matchAll(FENCE_RE)];
    let total = 0;
    let max = 0;
    for (const m of matches) {
        const chars = m[5].length;
        total += chars;
        if (chars > max) max = chars;
    }
    // 整条消息代码总量过大时，即使每一块都不大，也全部走快速直出；否则只处理单块超阈值的
    const deferAll = totalThreshold > 0 && total >= totalThreshold;
    if (!deferAll && max < threshold) return mes;

    const nonce = Math.random().toString(36).slice(2, 8);
    let index = 0;
    let last = 0;
    let output = '';
    const tokens = new Map();
    for (const m of matches) {
        const body = m[5];
        const chars = body.length;
        if (!deferAll && chars < threshold) continue;
        index++;
        state.codeSeq++;
        const key = `alc${state.codeSeq}`;
        const token = `ALCD${nonce}${index}END`;
        const rec = { key, code: body, lang: codeLang(m[4]), chars, frontend: isFrontendCode(body) };
        state.codeBlocks.set(key, rec);
        keys.push(key);
        tokens.set(token, rec);
        output += mes.slice(last, m.index) + `${m[1]}${m[2]}\n${token}\n\n`;
        last = m.index + m[0].length;
    }
    output += mes.slice(last);

    if (tokens.size) state.codePending = { tokens };
    return output;
}

/** AFTER_MARKDOWN：把 token 替换为完整代码块（不省略任何字符，不交给 hljs） */
function replaceCodeTokens(html) {
    const pending = state.codePending;
    state.codePending = null;
    if (!pending || !pending.tokens.size) return html;
    let out = html;
    for (const [token, rec] of pending.tokens) {
        const block = rec.frontend ? buildFrontendCodeBlock(rec) : buildFullCodeBlock(rec);
        if (rec.frontend) state.codeBlocks.delete(rec.key); // 前端已还原成原生代码，不再需要内存记录
        // Showdown 通常把独立 token 包成 <p>token</p>；用函数替换避免代码里的 $& 被当成替换模式
        out = out.replace(new RegExp(`<p>\\s*${token}\\s*</p>`, 'g'), () => block);
        out = out.split(token).join(block);
    }
    // 这一钩子返回后 ST 才把 HTML 写进 .mes_text；下一帧再补水，确保空壳已经在 DOM 里
    scheduleCodeHydration();
    scheduleCodeHydrationFallback();
    return out;
}

function writeClipboardText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (err) { /* 落到 execCommand */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return Promise.resolve();
    } catch (err) {
        return Promise.reject(err);
    }
}

function bindCodeDeferEvents() {
    const chat = chatEl();
    if (!chat) return;
    if (state.codeClickHandler && state.codeClickTarget === chat) return;
    if (state.codeClickHandler && state.codeClickTarget) {
        state.codeClickTarget.removeEventListener('click', state.codeClickHandler);
        state.codeClickTarget.removeEventListener('keydown', state.codeKeyHandler);
    }
    const copyBlock = (action) => {
        if (!action) return;
        const block = action.closest('.al-code-full');
        if (!block || !chat.contains(block)) return;
        const rec = state.codeBlocks.get(block.dataset.alCode);
        const body = block.querySelector('.al-code-view');
        const text = rec ? rec.code : (body ? body.textContent || '' : '');
        writeClipboardText(text).then(() => {
            action.textContent = '已复制';
            setTimeout(() => { action.textContent = '复制'; }, 1200);
        }).catch(() => { action.textContent = '复制失败'; });
    };
    const click = (event) => {
        const action = event.target.closest && event.target.closest('[data-al-code-action="copy"]');
        if (!action) return;
        event.preventDefault();
        copyBlock(action);
    };
    const keydown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const action = event.target.closest && event.target.closest('[data-al-code-action="copy"]');
        if (!action) return;
        event.preventDefault();
        copyBlock(action);
    };
    state.codeClickHandler = click;
    state.codeKeyHandler = keydown;
    state.codeClickTarget = chat;
    chat.addEventListener('click', click);
    chat.addEventListener('keydown', keydown);
}

/** 兜底：把已经渲染出来的超长代码块换成完整直出块（兼容刚装的当前聊天） */
function convertRenderedHugeCode() {
    if (!state.s || !isOn() || !state.s.codeDefer) return;
    const threshold = Number(state.s.codeDeferChars) || 8000;
    const totalThreshold = Number(state.s.codeDeferTotalChars) || 0;
    const mesTexts = document.querySelectorAll('#chat .mes_text');
    mesTexts.forEach((mesText) => {
        const pres = Array.from(mesText.querySelectorAll('pre')).filter((pre) => {
            if (pre.closest('.al-code-full') || pre.closest('.al-code-defer') || pre.classList.contains('al-code-restored')) return false;
            return Boolean(pre.querySelector('code'));
        });
        if (!pres.length) return;
        let total = 0;
        for (const pre of pres) {
            const raw = pre.querySelector('code')?.textContent || '';
            if (!isFrontendCode(raw)) total += raw.length;
        }
        const convertAll = totalThreshold > 0 && total >= totalThreshold;
        const mes = mesText.closest('.mes');
        const mesId = mes && mes.dataset.mesid ? mes.dataset.mesid : 'x';
        let keys = null;
        for (const pre of pres) {
            const code = pre.querySelector('code');
            const raw = code.textContent || '';
            if (isFrontendCode(raw)) continue;
            if (!convertAll && raw.length < threshold) continue;
            state.codeSeq++;
            const key = `alc${state.codeSeq}`;
            const langMatch = String(code.className || '').match(/language-([\w+#.-]+)/);
            const rec = { key, code: raw, lang: codeLang(langMatch ? langMatch[1] : 'code'), chars: raw.length };
            state.codeBlocks.set(key, rec);
            if (!keys) {
                keys = state.codeMesKeys.get(String(mesId));
                if (!keys) {
                    keys = [];
                    state.codeMesKeys.set(String(mesId), keys);
                }
            }
            keys.push(key);
            pre.replaceWith(fullCodeElement(rec));
        }
    });
    hydrateCodeViews();
}

function restoreDeferredCode() {
    const boxes = document.querySelectorAll('#chat .al-code-full, #chat .al-code-defer');
    if (boxes.length) {
        boxes.forEach((box) => {
            const rec = state.codeBlocks.get(box.dataset.alCode);
            if (!rec) return;
            const oldPre = box.querySelector('.al-code-view');
            cleanupCodeView(oldPre);
            const pre = document.createElement('pre');
            pre.className = 'al-code-restored';
            const code = document.createElement('code');
            code.textContent = rec.code;
            pre.appendChild(code);
            box.replaceWith(pre);
        });
    }
    state.codeBlocks.clear();
    state.codeMesKeys.clear();
    state.codePending = null;
    cleanupCodeViews();
}

/* ------------------------------------------------------------------ */
/* 角色卡字段 Token 统计降载                                           */
/* ------------------------------------------------------------------ */

const CHAR_TOKEN_FIELDS = new Set([
    'character_name_pole', 'description_textarea', 'firstmessage_textarea',
    'mes_example_textarea', 'personality_textarea', 'scenario_pole',
    'system_prompt_textarea', 'post_history_instructions_textarea', 'depth_prompt_prompt',
]);

// ST 的 RA_CountCharTokens 会逐个 await getTokenCountAsync() 统计角色编辑器所有字段；
// 简介/示例对话里塞几十万字符代码时，打开角色卡就会被分词拖住。这里只对超大字段跳过计数。
function restoreCharTokenCounter(counter) {
    if (!counter || counter.dataset.alTokenSkip !== '1') return;
    const id = counter.dataset.alTokenCounter;
    if (!id) return;
    try {
        if (window.jQuery) window.jQuery(counter).removeData('token-counter');
    } catch (err) { /* 忽略 */ }
    counter.dataset.tokenCounter = id;
    delete counter.dataset.alTokenCounter;
    delete counter.dataset.alTokenSkip;
    counter.textContent = 'counting...';
    counter.title = '';
}

function restoreCharTokenCounters() {
    document.querySelectorAll('[data-al-token-skip="1"]').forEach(restoreCharTokenCounter);
}

function syncCharacterTokenGuard() {
    const active = Boolean(state.s && isOn() && state.s.charTokenSkip);
    const threshold = Number(state.s && state.s.charTokenSkipChars) || 20000;
    document.querySelectorAll('[data-token-counter], [data-al-token-skip="1"]').forEach((counter) => {
        if (!counter) return;
        if (!active) { restoreCharTokenCounter(counter); return; }
        const id = counter.dataset.tokenCounter || counter.dataset.alTokenCounter;
        if (!id) return;
        const input = document.getElementById(id);
        if (!input || typeof input.value !== 'string') { restoreCharTokenCounter(counter); return; }
        const len = input.value.length;
        if (len < threshold) { restoreCharTokenCounter(counter); return; }
        if (counter.dataset.tokenCounter) {
            counter.dataset.alTokenCounter = counter.dataset.tokenCounter;
            try {
                if (window.jQuery) window.jQuery(counter).removeData('token-counter');
            } catch (err) { /* 忽略 */ }
            delete counter.dataset.tokenCounter;
        }
        counter.dataset.alTokenSkip = '1';
        counter.textContent = `跳过 · ${formatCount(len)} 字`;
        counter.title = 'AntiLag：超大字段跳过 token 统计，避免打开角色卡时被分词卡住';
    });
}

function bindCharacterTokenGuard() {
    if (state.charGuardInput) return;
    const handler = (event) => {
        const id = event && event.target && event.target.id;
        if (!id || !CHAR_TOKEN_FIELDS.has(id)) return;
        clearTimeout(state.charGuardTimer);
        state.charGuardTimer = setTimeout(() => { syncCharacterTokenGuard(); }, 120);
    };
    state.charGuardInput = handler;
    document.addEventListener('input', handler, true);
    const tab = document.getElementById('rm_button_selected_ch');
    if (tab && !state.charGuardObserver) {
        state.charGuardObserver = new MutationObserver(() => {
            // 选中角色变化会先改这个标题，ST 的 token 统计有 500ms 防抖，这里要抢在它前面
            syncCharacterTokenGuard();
        });
        state.charGuardObserver.observe(tab, { childList: true, subtree: true });
    }
}

function unbindCharacterTokenGuard() {
    if (state.charGuardInput) document.removeEventListener('input', state.charGuardInput, true);
    state.charGuardInput = null;
    if (state.charGuardTimer) { clearTimeout(state.charGuardTimer); state.charGuardTimer = 0; }
    try { state.charGuardObserver?.disconnect(); } catch (err) { /* 忽略 */ }
    state.charGuardObserver = null;
    restoreCharTokenCounters();
}

function syncCodeDefer() {
    if (state.s && isOn() && state.s.codeDefer) {
        bindCodeDeferEvents();
        startCodeSweep();
        if (!state.codeScanDone && !isEditing()) {
            state.codeScanDone = true;
            withChatScroll(() => convertRenderedHugeCode());
        }
    } else {
        stopCodeSweep();
        withChatScroll(() => restoreDeferredCode());
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
    // 只要 ST 的「聊天截断」>0，或页面上有 Show more，就不再叠折叠：
    // 原生分页已经只渲染最近 N 条，再折叠会把用户刚点「Show more」加载出来的历史又藏回去
    const nativePaging = Boolean(document.getElementById('show_more_messages')) || nativeTruncation() > 0;
    const active = Boolean(isOn() && s.trimHistory && !state.trimExpanded && !nativePaging);
    const keep = s.trimKeep;

    if (!active) {
        // 未启用时不做全量扫描：只有真的存在折叠残留时才清理
        const dirty = chat.querySelector('.mes.al-trim, .al-trim-note');
        if (!dirty) { state.trimSig = 'off'; return; }
        state.trimSig = 'off';
        withChatScroll(() => {
            chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
            chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));
        });
        return;
    }
    if (s.pauseOnEdit && isBusy()) return;

    const mes = chat.getElementsByClassName('mes');
    const total = mes.length;
    const sig = `${total}|${keep}|on`;
    if (state.trimSig === sig) return;
    if (total <= keep) {
        state.trimSig = sig;
        withChatScroll(() => {
            chat.querySelectorAll('.al-trim-note').forEach((el) => el.remove());
            chat.querySelectorAll('.mes.al-trim').forEach((el) => el.classList.remove('al-trim'));
        });
        return;
    }
    state.trimSig = sig;

    const cut = total - keep;
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
        // 关掉时只在确实有残留折叠时才清理，避免每次扫描都全量 query
        if (chat.querySelector('.mes.al-clip, .al-clip-btn, .mes[data-al-expanded]')) {
            chat.querySelectorAll('.mes.al-clip').forEach((el) => el.classList.remove('al-clip'));
            chat.querySelectorAll('.al-clip-btn').forEach((el) => el.remove());
            chat.querySelectorAll('.mes[data-al-expanded]').forEach((el) => { delete el.dataset.alExpanded; });
        }
        state.clipSig = '';
        state.clipDirty = true;
        return;
    }
    if (state.s.pauseOnEdit && isBusy()) return;

    const limit = state.s.clipChars;
    const mesList = chat.querySelectorAll('.mes');
    const lastId = mesList.length ? (mesList[mesList.length - 1].dataset.mesid || '') : '';
    const sig = `${mesList.length}|${lastId}|${limit}`;
    // 未折叠消息的全量文本扫描是 O(总字数)：只在消息增减/阈值变化/编辑滑动后重扫，
    // 其余时候只复核已有的折叠项（很小的一批）
    const fullScan = state.clipDirty || state.clipSig !== sig;

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

        if (!fullScan) return;

        chat.querySelectorAll('.mes:not(.al-clip)').forEach((mes) => {
            // 用户点过「展开全文」的消息不再自动折叠（新消息追加/整体重扫时也尊重这次展开）
            if (mes.dataset.alExpanded === '1' || mes.querySelector('.al-clip-btn')) return;
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
                mes.dataset.alExpanded = '1';
                mes.classList.remove('al-clip');
                btn.remove();
            });
            // 放进 .mes_block（flex 列）而不是 .mes（flex 行），否则按钮会挤在消息右侧、压缩正文宽度
            (mes.querySelector('.mes_block') || mes).appendChild(btn);
        });
    });

    state.clipSig = sig;
    state.clipDirty = false;
}

const scheduleSweep = (() => {
    let timer = 0;
    const run = () => {
        if (state.disposed || document.hidden || !state.s) return;
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
    state.boost = false;
    state.lowStreak = 0;
    state.highStreak = 0;
    VISUAL_KEYS.forEach((k) => { state.s[k] = preset[k]; });
    if (!preset.killBlur) state.s.killBlurAll = false;
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
                ${rowNumber('al-fps', '掉帧阈值', '连续 3 秒低于该帧率才触发自动降级', s.fpsThreshold, 'FPS', 10, 60, 5)}
                ${rowNumber('al-long', '长任务阈值', '体检里超过该时长的主线程任务标红', s.longTaskMs, 'ms', 50, 3000, 50)}
                ${rowToggle('al-notify', '状态提示', '临时升级、暂停等动作弹出轻提示', 'notify')}
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
                ${rowToggle('al-smoothskip', '生成时临时关闭平滑流式', 'ST 1.19 的平滑流式会在每个流式分片之间 await 人工延迟，标点更久；关掉只影响生成时的吐字节奏，结束自动还原', 'smoothStreamSkip')}
                ${rowToggle('al-lazy', '图片懒加载', '聊天内图片改为 lazy + async 解码', 'lazyImg')}
                ${rowToggle('al-lazyframe', 'iframe 懒加载', '消息里的网页/视频卡片延迟加载', 'lazyFrame')}
                ${rowToggle('al-willchange', '清理 will-change', '回收被主题滥用的 GPU 图层，降低移动端内存压力', 'willChange')}
                ${rowToggle('al-scrollblur', '滚动时临时关模糊', '滚动时每帧都要重新采样背景，低配机收益最大；停手 160ms 自动恢复（会有一瞬视觉跳变）', 'scrollBlur')}
                ${rowToggle('al-killblur', '关闭毛玻璃 / 滤镜', 'backdrop-filter 是掉帧第一大户；ST「快速 UI」开着时 Chrome 系已全局去掉，Safari 的 -webkit- 前缀仍可能需要本项', 'killBlur')}
                ${rowToggle('al-killblur-all', '毛玻璃关闭范围：全界面', '默认只关聊天区，打开后连抽屉、顶栏、弹窗一起关', 'killBlurAll')}
                ${rowToggle('al-killbg', '停用动画背景', '停掉背景动画与 fixed 背景，滚动更稳', 'killBgAnim')}
                ${rowToggle('al-killshadow', '关闭阴影', '去掉消息的 box-shadow / text-shadow', 'killShadow')}
                ${rowToggle('al-killtrans', '关闭消息过渡动画', '消息区不再做过渡/关键帧动画', 'killTransitions')}
                ${rowToggle('al-contain', '隔离聊天区布局', 'contain: layout，避免抽屉/输入框重排牵连聊天区', 'containChat')}
            </details>

            <details class="al-fold">
                <summary>历史与超长消息</summary>
                ${rowToggle('al-trim', '折叠较早消息', '更早的消息移出渲染树，顶部可一键展开', 'trimHistory')}
                ${rowToggle('al-codedefer', '超大代码可视行直出', '代码一个字都不少；块内只渲染当前滚动窗口的行，绕过 Showdown 与 hljs；滚动查看、复制全文', 'codeDefer')}
                ${rowNumber('al-codethreshold', '单块直出阈值', '单个代码块超过该字符数就走可视行直出；低于阈值仍由 ST 原生解析并高亮', s.codeDeferChars, '字', 1000, 200000)}
                ${rowNumber('al-codetotal', '单条消息代码总量阈值', '一条消息里所有代码加起来超过该值，即使单块不大也全部走可视行直出；0 表示只看单块阈值', s.codeDeferTotalChars, '字', 0, 500000)}
                ${rowToggle('al-chartokenskip', '跳过超大角色字段 Token 统计', '角色卡简介/示例/首条消息含巨量代码时，ST 会逐个字段 await 分词；跳过超大字段可显著加快打开角色卡', 'charTokenSkip')}
                ${rowNumber('al-chartokenthreshold', '角色字段阈值', '字段超过该字符数才跳过 Token 统计；只影响统计显示，不改角色卡内容', s.charTokenSkipChars, '字', 5000, 200000)}
                ${rowNumber('al-keep', '折叠后保留', '保留最近多少条消息可见', s.trimKeep, '条', 10, 3000, 10)}
                ${rowSelect('al-nativelimit', '借用 ST 原生分页', '把 ST 的「聊天截断」设为固定条数，改完立即重渲染；只影响显示、不影响上下文', s.nativeLimit, [
                    [0, '不改（用 ST 当前设置）'],
                    [50, '最近 50 条（手机推荐）'],
                    [80, '最近 80 条'],
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
                    <div class="al-diag-head-actions">
                        <button type="button" class="al-btn al-ghost al-small" id="al-scan">重新检测</button>
                        <button type="button" class="al-btn al-ghost al-small" id="al-copy">复制报告</button>
                    </div>
                </div>
                <div class="al-diag-grid" data-grid></div>
                <div class="al-advice" data-advice></div>
            </div>

            <div class="al-actions">
                <button type="button" class="al-btn al-primary" id="al-recommend">智能推荐</button>
                <button type="button" class="al-btn al-ghost" id="al-optimize">一键均衡</button>
                <button type="button" class="al-btn al-ghost al-small" id="al-reset">恢复默认</button>
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
            // 全界面关闭依赖总开关；否则只开「全界面」不会有任何效果
            if (key === 'killBlurAll' && input.checked) state.s.killBlur = true;
            if (key === 'killBlur' && !input.checked) state.s.killBlurAll = false;
            if (key === 'trimHistory' && input.checked) {
                // 之前点过「展开」的话，重新打开折叠要重新折
                state.trimExpanded = false;
                state.trimSig = '';
            }
            if (VISUAL_KEYS.includes(key)) state.s.mode = 'custom';
            // 用户手动改视觉项时退出临时极速，否则 boost 会把它改回去，看起来像开关失灵
            if (state.boost && (BOOST_KEYS.includes(key) || key === 'autoDetect' || (key === 'enabled' && !input.checked))) {
                state.boost = false;
                state.lowStreak = 0;
                state.highStreak = 0;
            }
            input.closest('.al-switch')?.classList.toggle('is-on', input.checked);
            save();
            applyAll();
            if (key === 'codeDefer') {
                state.codeScanDone = false;
                if (input.checked) queueCodeRerender();
            }
        });
    });

    NUMBERS.forEach(([id, key, min, max]) => {
        const input = el.querySelector('#' + id);
        if (!input) return;
        const commit = () => {
            const raw = parseInt(input.value, 10);
            const val = key === 'codeDeferTotalChars'
                ? clamp(Number.isFinite(raw) ? raw : DEFAULTS[key], min, max)
                : clamp(raw || DEFAULTS[key], min, max);
            state.s[key] = val;
            input.value = String(val);
            save();
            applyAll();
            if (key === 'codeDeferChars' || key === 'codeDeferTotalChars') queueCodeRerender();
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
            // 原生分页是渲染期设置，改完必须重新渲染当前聊天才会生效
            if (key === 'nativeLimit') rerenderChatSoon();
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
    el.querySelector('#al-recommend')?.addEventListener('click', applyRecommended);
    el.querySelector('#al-copy')?.addEventListener('click', copyDiagnosticReport);
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
    // 暂停/恢复都不应该把「临时极速」带过去
    state.boost = false;
    state.lowStreak = 0;
    state.highStreak = 0;
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
    state.boost = false;
    state.lowStreak = 0;
    state.highStreak = 0;
    restoreStreamFps();
    restoreNativeLimit();
    restoreStreamFadeSkip();
    restoreSmoothStreamSkip();
    state.s = JSON.parse(JSON.stringify(DEFAULTS));
    settingsStore()[MODULE_NAME] = state.s;
    save();
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
    // 全文档节点数用 live collection，避免在超大 DOM 上分配一个包含所有节点的数组
    let nodes = 0;
    try {
        nodes = document.getElementsByTagName('*').length;
    } catch (err) {
        nodes = document.querySelectorAll('*').length;
    }
    const disabledExts = Array.isArray(c && c.extensionSettings && c.extensionSettings.disabledExtensions)
        ? c.extensionSettings.disabledExtensions : [];
    const heavy = HEAVY_EXTS.filter((k) => c && c.extensionSettings
        && Boolean(c.extensionSettings[k]) && !disabledExts.includes(k));
    // extension_settings 里混着 apiUrl/note 等非扩展键，直接数键名会虚高；排除元数据并跳过已禁用的
    const META_KEYS = ['apiUrl', 'apiKey', 'autoConnect', 'notifyUpdates', 'disabledExtensions', 'expressionOverrides', MODULE_NAME];
    const extCount = c && c.extensionSettings
        ? Object.keys(c.extensionSettings)
            .filter((k) => !META_KEYS.includes(k) && !disabledExts.includes(k)).length
        : 0;
    const imgCount = document.querySelectorAll('#chat img').length;

    let blurCount = 0;
    let wcCount = 0;
    let codeCount = 0;
    let codeChars = 0;
    const hasBlur = (cs) => {
        const bf = cs.backdropFilter || cs.webkitBackdropFilter;
        if (bf && bf !== 'none') return true;
        const f = cs.filter || '';
        return f.includes('blur(') || f.includes('drop-shadow(');
    };
    // 真正的模糊在容器上：只扫消息会漏掉 #chat / #send_form 这两个大头
    ['#chat', '#send_form', '#form_sheld', '#top-bar'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (el && hasBlur(getComputedStyle(el))) blurCount++;
    });
    const sample = Array.from(document.querySelectorAll('#chat .mes')).slice(-30);
    for (const mes of sample) {
        const cs = getComputedStyle(mes);
        if (hasBlur(cs)) blurCount++;
        if (cs.willChange && cs.willChange !== 'auto') wcCount++;
        const child = mes.firstElementChild;
        if (child) {
            const ccs = getComputedStyle(child);
            if (ccs.willChange && ccs.willChange !== 'auto') wcCount++;
        }
        mes.querySelectorAll('.mes_text pre').forEach((pre) => {
            codeCount++;
            const deferred = pre.closest('.al-code-full') || pre.closest('.al-code-defer');
            if (deferred) {
                codeChars += Number(deferred.dataset.alCodeLen) || 0;
            } else {
                const code = pre.querySelector('code') || pre;
                codeChars += (code.textContent || '').length;
            }
        });
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
        bgAnim = Boolean(cs.animationName && cs.animationName !== 'none');
        // ST 真正的 fixed 背景在 #bg1（backgrounds.css），不是 body
        const bg1 = document.getElementById('bg1');
        if (bg1) {
            const cs1 = getComputedStyle(bg1);
            if (cs1.backgroundAttachment && cs1.backgroundAttachment.includes('fixed')) bgAnim = true;
            if (cs1.animationName && cs1.animationName !== 'none') bgAnim = true;
        }
    } catch (err) { /* 忽略 */ }

    const pu = powerUser() || {};
    const nativeTrunc = Number(pu.chat_truncation) || 0;
    const stStreamFps = Number(pu.streaming_fps) || 0;
    const smoothStreaming = Boolean(pu.smooth_streaming);
    const reducedMotion = Boolean(pu.reduced_motion);
    const autoFix = Boolean(pu.auto_fix_generated_markdown);
    const input = recentInput();

    return {
        chatLen, mesDom, nodes, extCount, imgCount, blurCount, wcCount, longest, bgAnim,
        codeCount, codeChars,
        nativeTrunc, stStreamFps, smoothStreaming, reducedMotion, autoFix, input,
        loadMs: state.chatLoadMs, loadCount: state.chatLoadCount, tps: state.tps,
        virtOn: document.body.classList.contains('antilag-virt'),
        cvSize: state.cvSize,
        paging: nativePagingActive(),
        tokenCounter: Boolean(pu.message_token_count_enabled),
        fadeIn: Boolean(pu.stream_fade_in),
        fastUi: Boolean(pu.fast_ui_mode),
        regexCount: (!disabledExts.includes('regex') && Array.isArray(c && c.extensionSettings && c.extensionSettings.regex))
            ? c.extensionSettings.regex.filter((r) => r && !r.disabled).length : 0,
        heavy,
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
        ['原生截断', d.nativeTrunc ? `最近 ${d.nativeTrunc} 条${d.paging ? '（分页中）' : ''}${s.truncApplied ? '（AntiLag 设置）' : ''}` : '不限（全量渲染）', d.nativeTrunc ? 'ok' : ((d.chatLen > 300) ? 'warn' : 'ok')],
        ['上次加载', d.loadMs ? `${d.loadCount} 条 / ${Math.round(d.loadMs)}ms` : '—', d.loadMs > 1200 ? 'warn' : 'ok'],
        ['消息落地', d.renderMs ? `${Math.round(d.renderMs)}ms` : '—', d.renderMs > 120 ? 'bad' : (d.renderMs > 70 ? 'warn' : 'ok')],
        ['ST 逐条 token 计数', d.tokenCounter ? '开（生成/滑动时分词）' : '关', (d.tokenCounter && (d.chatLen || 0) > 200) ? 'warn' : 'ok'],
        ['输入延迟 10s', d.input.max ? `最大 ${Math.round(d.input.max)}ms` : '无慢事件', d.input.max > 200 ? 'bad' : (d.input.max > 100 ? 'warn' : 'ok')],
        ['DOM 节点', String(d.nodes), d.nodes > 4000 ? 'warn' : 'ok'],
        ['10s 长任务', `${lt.count} 次 / 最长 ${Math.round(lt.max)}ms`, lt.max > s.longTaskMs ? 'bad' : 'ok'],
        ['生成期长任务', `${state.lastGenLt} 次${d.tps ? ` / ${d.tps} TPS` : ''}`, state.lastGenLt > 3 ? 'warn' : 'ok'],
        ['流式帧率', d.stStreamFps ? `${d.stStreamFps} FPS` : '未知', (d.stStreamFps >= 30 && state.lastGenLt > 3) ? 'warn' : 'ok'],
        ['流式淡入', d.fadeIn ? '开（每 tick 重建分段）' : '关', d.fadeIn ? 'warn' : 'ok'],
        ['平滑流式', d.smoothStreaming ? '开（逐字延时）' : '关', d.smoothStreaming ? 'warn' : 'ok'],
        ['自动修 Markdown', d.autoFix ? '开（每次渲染跑 fixMarkdown）' : '关', d.autoFix ? 'warn' : 'ok'],
        ['减少动画', d.reducedMotion ? '开' : '关', d.reducedMotion ? 'ok' : 'ok'],
        ['ST 快速 UI', d.fastUi ? '开（全界面无模糊）' : '关', (!d.fastUi && d.blurCount > 0) ? 'warn' : 'ok'],
        ['正则脚本', String(d.regexCount), d.regexCount > 5 ? 'warn' : 'ok'],
        ['毛玻璃元素', String(d.blurCount), d.blurCount > 0 ? 'warn' : 'ok'],
        ['will-change', String(d.wcCount), d.wcCount > 2 ? 'warn' : 'ok'],
        ['动画背景', d.bgAnim ? '存在' : '无', d.bgAnim ? 'warn' : 'ok'],
        ['近期最长消息', d.longest > 5000 ? `${Math.round(d.longest / 1000)}k 字` : `${d.longest} 字`, d.longest > 5000 ? 'warn' : 'ok'],
        ['代码块（近30条）', `${d.codeCount} 个 / ${d.codeChars > 1000 ? `${Math.round(d.codeChars / 1000)}k` : d.codeChars} 字${s.codeDefer ? '（按需）' : ''}`, d.codeChars > 30000 && !s.codeDefer ? 'warn' : 'ok'],
        ['聊天图片', String(d.imgCount), 'ok'],
        ['已启用扩展', String(d.extCount), d.extCount > 10 ? 'warn' : 'ok'],
        ['重型扩展', d.heavy.length ? d.heavy.join(' / ') : '无', d.heavy.length >= 3 ? 'warn' : 'ok'],
    ];

    grid.innerHTML = items.map(([k, v, level]) => `
        <div class="al-kv" data-level="${level}">
            <span>${k}</span><b>${v}</b>
        </div>`).join('');

    const tips = [];
    if ((d.chatLen || d.mesDom) > 300 && !s.virtualize) tips.push('长聊天建议开启「消息虚拟化」');
    if (d.blurCount > 0 && !s.killBlur) tips.push('界面仍有毛玻璃/模糊：切「均衡」只关聊天区，要连顶栏/抽屉一起关再开「全界面」');
    if (d.bgAnim && !s.killBgAnim) tips.push('检测到动画背景，建议停用动画背景');
    if (d.wcCount > 2 && !s.willChange) tips.push('主题在滥用 will-change，建议开启「清理 will-change」');
    if (d.longest > 5000 && !s.clipLong) tips.push(`最长一条消息约 ${Math.round(d.longest / 1000)}k 字，可开「超长消息折叠」`);
    if (d.codeChars > 20000 && !s.codeDefer) tips.push(`近 30 条里代码约 ${Math.round(d.codeChars / 1000)}k 字，建议开「超大代码完整直出」，避免一次性 Markdown+高亮`);
    if (d.codeChars > 20000 && s.codeDefer && s.codeDeferChars > 8000) tips.push('代码量很大：可把「单块直出阈值」降到 3000–5000，让更多代码走完整直出');
    if (fps && fps < s.fpsThreshold) tips.push('当前帧率偏低，可先切「均衡」，仍卡再切「极速」');
    if (lt.max > s.longTaskMs) tips.push(`存在 ${Math.round(lt.max)}ms 主线程长任务，多为大聊天渲染或重扩展造成`);
    if (state.lastGenLt > 3) tips.push('生成期间长任务偏多：多为长消息流式重绘，可开「生成时轻量渲染」');
    if (state.lastGenLt > 3 && d.stStreamFps >= 25 && !s.streamFps) {
        tips.push(`ST 流式刷新是 ${d.stStreamFps} FPS，每个 tick 都要重跑正则+净化+Markdown；可把「流式降频」设到 15–20`);
    }
    try {
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches && !d.nativeTrunc && d.mesDom > 80) {
            tips.push('当前像移动端且没有原生截断：可在「借用 ST 原生分页」选最近 50–80 条，显著减少要布局的 DOM');
        }
    } catch (err) { /* 忽略 */ }
    if (d.nativeTrunc) {
        tips.push(`ST 原生「聊天截断」为 ${d.nativeTrunc} 条：更早消息本来就不渲染，无需再开「折叠较早消息」`);
        if (d.nativeTrunc > 200 && (d.chatLen || 0) > 300) tips.push('若仍卡，可把原生截断降到 100–150 更省，只影响显示、不改变上下文');
    } else if ((d.chatLen || 0) > 300) {
        tips.push('ST 聊天截断为「不限」且消息很多：优先用「借用 ST 原生分页」设 100–200，比折叠更稳；或开启虚拟化');
    }
    if (d.input.max > 100) tips.push(`输入延迟最大 ${Math.round(d.input.max)}ms：按键被主线程计算挡住（世界书扫描/正则/向量检索/tokenizer），不是输入框本身问题`);
    if (d.fadeIn && !s.streamFadeSkip) tips.push('「流式淡入」每个 tick 都要把整条消息按词重切 span 再 morphdom，长消息会明显卡；可开「生成时临时关闭流式淡入」或在 ST 里关掉');
    if (d.smoothStreaming && !s.smoothStreamSkip) tips.push('ST「平滑流式」会在每个流式分片之间插入人工延迟，长回复会更慢；可开「生成时临时关闭平滑流式」');
    if (d.autoFix) tips.push('ST「自动修复生成的 Markdown」默认开，每次渲染整条消息都会跑 fixMarkdown；长消息多时可在用户设置里关掉，代价是畸形 Markdown 可能不再自动修复');
    if (!d.reducedMotion && !s.killTransitions) tips.push('ST 官方建议开启「减少动画」：用户设置 → 界面主题里勾选 Reduced motion，可去掉装饰性过渡与动画');
    if (!d.fastUi && d.blurCount > 0) tips.push('ST 自带「快速 UI 模式」能一键去掉全界面毛玻璃（比逐项关更彻底），在 ST 用户设置里开启即可');
    if (d.regexCount > 5) tips.push(`已启用 ${d.regexCount} 条正则脚本，每条消息渲染都要全跑一遍；不常用的先在「正则」扩展里停用`);
    if (d.tokenCounter) tips.push('ST「显示每条消息 token」：消息落地和滑动时会分词一次，长聊天批量生成/大量滑动会加慢；不需要可在 ST 用户设置里关掉');
    if (d.renderMs > 120) tips.push(`消息落地约 ${Math.round(d.renderMs)}ms（事件到稳定一帧，含其它扩展的收尾处理），先查是否开了逐条 token 计数/TTS/总结类扩展`);
    if (d.loadMs > 800) tips.push(`上次打开聊天耗时 ${Math.round(d.loadMs)}ms（${d.loadCount} 条），可调低聊天截断或开虚拟化改善后续滚动`);
    if (d.extCount > 10) tips.push(`已启用 ${d.extCount} 个扩展，建议逐个停用排查（尤其自带定时器的）`);
    if (d.heavy.length >= 2) tips.push(`已启用 ${d.heavy.join('、')}：它们会随每条消息或每次生成额外触发工作（表情分类/TTS/翻译/记忆摘要/向量检索/正则）；卡顿时先停用不用的`);
    if (isEditing()) tips.push('正在编辑消息，结构性优化已自动暂缓');
    if (!tips.length) tips.push('当前状态良好，保持现有配置即可');

    advice.innerHTML = tips.map((t) => `<div class="al-tip">· ${t}</div>`).join('');
}

/* ------------------------------------------------------------------ */
/* 智能推荐与体检报告                                                  */
/* ------------------------------------------------------------------ */

/**
 * 只推荐「不改外观」的选项：虚拟化、原生分页、流式降频、生成期关淡入/平滑、
 * 懒加载、代码直出、角色字段 token 跳过。毛玻璃/阴影/过渡等视觉项不自动动。
 */
function recommendedPlan() {
    const d = collectDiagnostics();
    const total = Math.max(Number(d.chatLen) || 0, Number(d.mesDom) || 0);
    let coarse = false;
    try {
        coarse = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (err) { /* 忽略 */ }

    const rec = {
        virtualize: true,
        genLite: true,
        lazyImg: true,
        codeDefer: true,
        streamFadeSkip: true,
        smoothStreamSkip: true,
        charTokenSkip: true,
        preserveScroll: true,
        streamFps: 15,
    };
    if (total >= 300) {
        rec.nativeLimit = coarse ? 80 : 100;
    }

    return { rec, total, coarse, diagnostics: d };
}

function applyRecommended() {
    if (!state.s) return;
    const plan = recommendedPlan();
    const changed = [];
    for (const [key, value] of Object.entries(plan.rec)) {
        if (state.s[key] !== value) {
            state.s[key] = value;
            changed.push(key);
        }
    }
    // 推荐不碰模式里的视觉项；如果当前还在临时极速，先退出，避免看起来没生效
    state.boost = false;
    state.lowStreak = 0;
    state.highStreak = 0;
    save();
    applyAll();
    if (state.s.nativeLimit) rerenderChatSoon();
    syncPanel();
    renderDiagnostics();

    const bits = [];
    if (plan.rec.nativeLimit) bits.push(`原生分页 ${plan.rec.nativeLimit} 条`);
    if (state.s.streamFps === 15) bits.push('流式上限 15 FPS');
    if (state.s.smoothStreamSkip) bits.push('生成期关平滑流式');
    if (state.s.streamFadeSkip) bits.push('生成期关淡入');
    if (state.s.codeDefer) bits.push('大代码可视行');
    const summary = bits.length ? bits.join('、') : '核心减负项';
    if (changed.length === 0) {
        toast('info', '当前已经是推荐配置，不需要再改');
    } else {
        toast('success', `已应用推荐：${summary}（不改外观）`);
    }
}

function copyDiagnosticReport() {
    const el = state.panelEl;
    if (!el) return;
    const grid = el.querySelector('[data-grid]');
    const advice = el.querySelector('[data-advice]');
    const d = collectDiagnostics();
    const text = [
        `AntiLag v${VERSION} 体检报告`,
        new Date().toLocaleString(),
        '',
        grid ? grid.innerText : '',
        '',
        '运行建议：',
        advice ? advice.innerText : '',
        '',
        `消息 ${d.chatLen} 条 / DOM ${d.mesDom} 条 / 节点 ${d.nodes}`,
        `虚拟化 ${d.virtOn ? '开' : '关'} / 原生截断 ${d.nativeTrunc || '不限'}`,
        `上次加载 ${d.loadMs ? Math.round(d.loadMs) + 'ms' : '—'} / 消息落地 ${d.renderMs ? Math.round(d.renderMs) + 'ms' : '—'}`,
        `帧率 ${state.fps || '采样中'} / 10s 长任务 ${recentLongTasks().count} 次`,
    ].join('\n');
    writeClipboardText(text).then(() => {
        toast('success', '体检报告已复制到剪贴板');
    }).catch(() => {
        toast('warning', '复制失败，请手动选择面板文字');
    });
}

/* ------------------------------------------------------------------ */
/* 监控                                                                */
/* ------------------------------------------------------------------ */

function recentLongTasks() {
    const now = performance.now();
    state.longTasks = state.longTasks.filter((t) => now - t.t < 10000);
    const max = state.longTasks.reduce((acc, t) => Math.max(acc, t.d), 0);
    return { count: state.longTasks.length, max };
}

function panelVisible() {
    if (!state.panelEl) return false;
    const drawer = state.panelEl.closest('.drawer-content');
    if (drawer) return drawer.classList.contains('openDrawer');
    return Boolean(state.panelEl.getClientRects && state.panelEl.getClientRects().length);
}

function needsFps() {
    // 只有开启自动降级或用户正在看体检面板时才需要采样；否则连 rAF 循环都停掉
    return Boolean(state.s && state.s.enabled && !isPaused() && (state.s.autoDetect || panelVisible()));
}

function startFpsLoop() {
    if (state.raf || document.hidden) return;
    state.startedAt = performance.now();
    state.lastSec = state.startedAt;
    state.frames = 0;
    const loop = (t) => {
        if (state.disposed) { state.raf = 0; return; }
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

function stopFpsLoop() {
    if (!state.raf) return;
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.frames = 0;
    state.fps = 0;
}

function startMonitor() {
    if (!state.s) return;

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
        if (document.hidden || !state.s || !state.s.enabled) return;
        // 暂停 10 分钟到点自动恢复，避免用户一直停在「已暂停」却不知道
        if (state.s.pausedUntil && Date.now() >= state.s.pausedUntil) {
            state.s.pausedUntil = 0;
            save();
            applyAll();
        }
        if (needsFps()) {
            if (!state.raf) startFpsLoop();
        } else if (state.raf) {
            stopFpsLoop();
        }
        // 面板不可见时不需要刷新 UI，避免每 10 秒做一批 querySelector/getComputedStyle
        if (!panelVisible()) {
            state.diagTick = 0;
            return;
        }
        state.diagTick++;
        if (state.diagTick >= 5) {
            state.diagTick = 0;
            renderDiagnostics();
            syncPanel();
        }
    }, 1000);
}

function onFps(fps) {
    state.fps = fps;
    if (state.disposed || !state.s || !state.s.enabled) return;
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

/** 注册 ST 的 MessageFormatter 钩子：在 Showdown 前截走超大代码，避免每次渲染都重啃 */
function registerCodeFormatterHooks() {
    if (state.codeFormatterHooked || state.disposed) return;
    const c = ctx();
    const mf = c && c.messageFormatter;
    if (!mf || typeof mf.addHook !== 'function' || !mf.stage) return;
    try {
        mf.addHook(encodeHugeCodeFences, { stage: mf.stage.AFTER_REGEX, order: (mf.order && mf.order.LATE) || 90 });
        mf.addHook(replaceCodeTokens, { stage: mf.stage.AFTER_MARKDOWN, order: (mf.order && mf.order.NORMAL) || 50 });
        state.codeFormatterHooked = true;
        console.log('[AntiLag] 超大代码完整直出钩子已注册');
    } catch (err) {
        console.warn('[AntiLag] 代码块格式化钩子注册失败', err);
    }
}

function clearCodeStore() {
    cleanupCodeViews();
    state.codeBlocks.clear();
    state.codeMesKeys.clear();
    state.codePending = null;
}

/* ------------------------------------------------------------------ */
/* 事件与挂载                                                          */
/* ------------------------------------------------------------------ */

function observeChat() {
    if (state.disposed) return;
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
    state.observer = new MutationObserver((records) => {
        // 只有「消息节点本身」增删才让签名失效；折叠提示条/按钮也是 #chat 子节点，
        // 如果一概重置会造成 applyTrim 反复插拔提示条的死循环
        const messageChanged = records.some((r) => {
            const nodes = [...r.addedNodes, ...r.removedNodes];
            return nodes.some((n) => n.nodeType === 1 && n.classList && n.classList.contains('mes'));
        });
        if (messageChanged) {
            state.trimSig = '';
            state.clipDirty = true;
        }
        scheduleSweep();
    });
    // 消息节点都是 #chat 的直接子节点，只观察 childList 即可；
    // 消息体内容变化走 MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_EDITED 事件，不做全子树观察。
    state.observer.observe(chat, { childList: true });
    state.observerOn = true;
    scheduleSweep();
}

/** 停止性能观察器（禁用扩展时不做无意义的 longtask / 输入延迟采集） */
function stopPerfObservers() {
    try { state.po?.disconnect(); } catch (err) { /* 忽略 */ }
    try { state.eventPo?.disconnect(); } catch (err) { /* 忽略 */ }
    state.po = null;
    state.eventPo = null;
}

function pauseObserver() {
    if (state.observer && state.observerOn) {
        state.observer.disconnect();
        state.observerOn = false;
    }
}

function mountUi() {
    if (state.disposed || !document.body || !state.s) return;
    try {
        if (state.panelEl && !state.panelEl.isConnected) state.panelEl = null;
        if (!state.panelEl && buildPanel()) {
            renderDiagnostics();
            syncPanel();
        }
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
    state.eventSource = es;
    const on = (name, fn) => {
        const type = et[name];
        if (!type) return;
        // 总开关关闭后事件仍会来，这里统一拦掉，避免禁用状态还在排队扫描
        const guarded = (...args) => {
            if (state.disposed || !state.s || !state.s.enabled) return;
            try { fn(...args); } catch (err) { console.warn('[AntiLag] 事件处理失败', name, err); }
        };
        try {
            es.on(type, guarded);
            state.eventBindings.push([type, guarded]);
        } catch (err) { /* 忽略 */ }
    };

    on('APP_READY', () => {
        state.mountTries = 0;
        // 初始化早期 getContext/powerUser 可能还没就绪，这里补一次应用
        applyAll();
        registerCodeFormatterHooks();
        mountUi();
        observeChat();
        hookScrollIdle();
        registerEvents();
        startInputTiming();
    });
    on('APP_INITIALIZED', () => { applyAll(); registerCodeFormatterHooks(); mountUi(); registerEvents(); });
    on('CHAT_LOADED', () => {
        // 这个事件在 printMessages 之前触发：从这里开始计时，才能覆盖真正的解析+渲染
        state.chatLoading = true;
        state.chatLoadT0 = performance.now();
        state.chatLoadMs = 0;
        state.chatLoadCount = 0;
        // 兜底：若某次加载没有等到 CHAT_CHANGED，别让虚拟化永久停在关闭状态
        clearTimeout(state.chatLoadTimer);
        state.chatLoadTimer = setTimeout(() => {
            state.chatLoadTimer = 0;
            if (state.disposed || !state.chatLoading) return;
            state.chatLoading = false;
            state.chatLoadT0 = 0;
            applyAll();
        }, 8000);
    });
    on('CHAT_CHANGED', () => {
        state.trimExpanded = false;
        state.trimSig = '';
        state.clipSig = '';
        state.clipDirty = true;
        state.lastGenLt = 0;
        state.tps = 0;
        state.lastRenderMs = 0;
        state.chatLoading = false;
        clearTimeout(state.chatLoadTimer);
        state.chatLoadTimer = 0;
        state.codeScanDone = false;
        clearCodeStore();
        applyAll();
        scheduleCodeHydration();
        if (state.codeRerenderPending && !state.generating && !state.chatLoading) {
            state.codeRerenderPending = false;
            rerenderChatSoon();
        }
        hookScrollIdle();
        scheduleSweep();
        // 等两帧后才包含绘制完成；没有前置 CHAT_LOADED 的场景不记这个指标
        const t0 = state.chatLoadT0;
        state.chatLoadT0 = 0;
        if (t0) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const c = ctx();
                state.chatLoadMs = performance.now() - t0;
                state.chatLoadCount = c && Array.isArray(c.chat) ? c.chat.length : countMessages();
                if (isOn()) scheduleMeasureCvSize();
                scheduleSweep();
            }));
        }
    });
    on('MESSAGE_RECEIVED', () => { measureRender(); hotZoneTick(); scheduleSweep(); });
    on('MESSAGE_SENT', () => { measureRender(); hotZoneTick(); scheduleSweep(); });
    on('MESSAGE_EDITED', () => { state.clipDirty = true; scheduleSweep(); scheduleCodeHydration(); });
    on('MESSAGE_UPDATED', () => { state.clipDirty = true; scheduleSweep(); scheduleCodeHydration(); });
    on('MESSAGE_SWIPED', () => { state.clipDirty = true; scheduleSweep(); scheduleCodeHydration(); });
    on('MESSAGE_DELETED', scheduleSweep);
    // ST 1.19.1 新增/细分的渲染事件：工具调用、文件嵌入、推理编辑都会往 .mes_text 写新 DOM。
    on('MESSAGE_FILE_EMBEDDED', () => { scheduleSweep(); scheduleCodeHydration(); });
    on('MESSAGE_REASONING_EDITED', () => { state.clipDirty = true; scheduleSweep(); scheduleCodeHydration(); });
    on('MESSAGE_REASONING_DELETED', () => { state.clipDirty = true; scheduleSweep(); scheduleCodeHydration(); });
    on('IMAGE_SWIPED', scheduleSweep);
    on('TOOL_CALLS_RENDERED', () => { scheduleSweep(); scheduleCodeHydration(); });
    on('CHARACTER_FIRST_MESSAGE_SELECTED', () => scheduleCodeHydration());
    on('USER_MESSAGE_RENDERED', () => { measureRender(); scheduleSweep(); scheduleCodeHydration(); });
    on('CHARACTER_MESSAGE_RENDERED', () => { measureRender(); hotZoneTick(); scheduleSweep(); scheduleCodeHydration(); });
    on('MORE_MESSAGES_LOADED', () => { scheduleSweep(); scheduleMeasureCvSize(); scheduleCodeHydration(); });
    on('STREAM_TOKEN_RECEIVED', () => { state.tokens++; scheduleCodeHydration(); });
    on('GENERATION_STARTED', () => {
        state.generating = true;
        state.genLt = 0;
        state.genT0 = performance.now();
        state.tokens = 0;
        pauseObserver();
        if (state.s && isOn() && state.s.genLite) document.body.classList.add('antilag-gen');
        else document.body.classList.remove('antilag-gen');
        targetStreamFps();
        applyStreamFadeSkip();
        applySmoothStreamSkip();
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
        restoreSmoothStreamSkip();
        if (state.nativeChanged && !state.chatLoading) {
            state.nativeChanged = false;
            rerenderChatSoon();
        }
        if (state.codeRerenderPending && !state.chatLoading) {
            state.codeRerenderPending = false;
            rerenderChatSoon();
        }
        observeChat();
        scheduleSweep();
        if (panelVisible()) renderDiagnostics();
    };
    on('GENERATION_ENDED', endGen);
    on('GENERATION_STOPPED', endGen);
}

function init() {
    try {
        state.disposed = false;
        loadSettings();
        // 上次会话留下过流式降频 / 原生分页记录：先还原 ST 原值，再按当前开关决定是否重新套用
        if (state.s.streamFpsOrig) restoreStreamFps();
        if (state.s.truncApplied) restoreNativeLimit();
        if (state.s.fadeApplied) restoreStreamFadeSkip();
        if (state.s.smoothApplied) restoreSmoothStreamSkip();
        applyAll();
        registerCodeFormatterHooks();
        scheduleCodeHydration();
        // 保存过「借用 ST 原生分页」时，ST 首屏可能还按旧值渲染，补一次重渲染
        if (state.s.nativeLimit) rerenderChatSoon();
        mountUi();
        observeChat();
        hookScrollIdle();
        registerEvents();
        startMonitor();
        if (needsFps()) startFpsLoop();
        startInputTiming();

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
    restoreSmoothStreamSkip();
    state.s.enabled = false;
    state.boost = false;
    state.generating = false;
    state.genT0 = 0;
    applyAll();
    pauseObserver();
    stopFpsLoop();
    stopPerfObservers();
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = 0; }
    return Promise.resolve();
}

/** 生命周期钩子：重新启用时恢复注入（manifest.hooks.enable） */
export function onEnable() {
    if (!state.s) {
        init();
        return Promise.resolve();
    }
    state.s.enabled = true;
    state.codeScanDone = false;
    save();
    applyAll();
    registerCodeFormatterHooks();
    mountUi();
    observeChat();
    hookScrollIdle();
    registerEvents();
    startMonitor();
    startInputTiming();
    if (state.s.nativeLimit) rerenderChatSoon();
    // 禁用时停掉了 rAF，重新启用必须拉回来，否则自动降级不会工作
    if (needsFps()) startFpsLoop();
    return Promise.resolve();
}

/** 生命周期钩子：更新/删除前清理残留（manifest.hooks.clean） */
export function onCleanUp() {
    try { unbindCharacterTokenGuard(); } catch (err) { /* 忽略 */ }
    state.disposed = true;
    try { restoreDeferredCode(); } catch (err) { /* 忽略 */ }
    if (state.codeClickTarget && state.codeClickHandler) {
        try { state.codeClickTarget.removeEventListener('click', state.codeClickHandler); } catch (err) { /* 忽略 */ }
        try { state.codeClickTarget.removeEventListener('keydown', state.codeKeyHandler); } catch (err) { /* 忽略 */ }
    }
    state.codeClickTarget = null;
    state.codeClickHandler = null;
    state.codeKeyHandler = null;
    try { restoreStreamFps(); } catch (err) { /* 忽略 */ }
    try { restoreNativeLimit(); } catch (err) { /* 忽略 */ }
    try { restoreStreamFadeSkip(); } catch (err) { /* 忽略 */ }
    try { restoreSmoothStreamSkip(); } catch (err) { /* 忽略 */ }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = 0; }
    if (state.chatLoadTimer) { clearTimeout(state.chatLoadTimer); state.chatLoadTimer = 0; }
    stopFpsLoop();
    pauseObserver();
    try { state.po?.disconnect(); } catch (err) { /* 忽略 */ }
    try { state.eventPo?.disconnect(); } catch (err) { /* 忽略 */ }
    state.po = null;
    state.eventPo = null;
    // 卸载时必须摘掉事件与滚动监听，否则同页重装会重复绑定、旧闭包继续跑
    const es = state.eventSource;
    const remove = es && (typeof es.removeListener === 'function' ? es.removeListener.bind(es) : (typeof es.off === 'function' ? es.off.bind(es) : null));
    if (remove) {
        state.eventBindings.forEach(([type, fn]) => { try { remove(type, fn); } catch (err) { /* 忽略 */ } });
    }
    state.eventBindings = [];
    state.eventSource = null;
    if (state.scrollTarget && state.scrollHandler) {
        try { state.scrollTarget.removeEventListener('scroll', state.scrollHandler); } catch (err) { /* 忽略 */ }
    }
    state.scrollTarget = null;
    state.scrollHandler = null;
    if (state.scrollTimer) { clearTimeout(state.scrollTimer); state.scrollTimer = 0; }
    if (rerenderTimer) { clearTimeout(rerenderTimer); rerenderTimer = 0; }
    state.eventsBound = false;
    try { clearStructural(); } catch (err) { /* 忽略 */ }
    ['antilag', 'antilag-virt', 'antilag-contain', 'antilag-gen', 'antilag-scrolling']
        .forEach((cls) => document.body && document.body.classList.remove(cls));
    if (document.documentElement) document.documentElement.classList.remove('antilag');
    if (state.styleEl) state.styleEl.remove();
    document.getElementById('al-lite-style')?.remove();
    state.styleEl = null;
    document.getElementById('al-cv-style')?.remove();
    try { document.documentElement.style.removeProperty('--al-cv-size'); } catch (err) { /* 忽略 */ }
    if (state.panelEl) state.panelEl.remove();
    state.panelEl = null;
    return Promise.resolve();
}
