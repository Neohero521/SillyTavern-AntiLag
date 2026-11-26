# AntiLag 流畅优化（SillyTavern 扩展）

一个只做「渲染层减负 + 卡顿归因 + 与原生机制协同」的 SillyTavern 扩展：不碰角色卡、世界书、聊天记录，也不改其他扩展的数据。默认档位视觉零改动。

适配：桌面端 / 移动端（手机 APP、浏览器都可用），长聊天、重特效主题、流式输出场景收益最明显。

仓库：<https://github.com/Neohero521/SillyTavern-AntiLag>

---

## v1.2 做了什么：先把 ST 源码读懂，再动手

这一版不是加开关，而是把 SillyTavern（release 分支）的渲染链路读了一遍，按实际实现改：

| 在 ST 源码里查到的事实 | 意味着什么 | v1.2 的应对 |
| --- | --- | --- |
| `public/style.css` 里 **`#chat` 自身就带** `backdrop-filter: blur(var(--SmartThemeBlurStrength))` 和 `text-shadow` | 聊天区本身就是一块毛玻璃：每次滚动都要重新采样背景，这是「滚动发黏」的常见主因，不是主题额外加的 | 关毛玻璃时会一起关掉 `#chat` 本体；关阴影时也覆盖 `#chat`（v1.1 只覆盖了 `.mes`，漏了容器） |
| 移动端 `#send_form` 也有 `backdrop-filter: blur(*2)` | 输入条压在背景上做二次模糊，打字/滚动时都在重算 | 关毛玻璃范围扩到 `#send_form` / `#form_sheld` |
| `#chat` 是 `overflow-y: scroll` + `display:flex; flex-direction:column` 的滚动容器 | 虚拟化必须保证 `scrollHeight` 不虚，否则会「优化一下跳一段」 | `content-visibility` 只作用于**热区之外**；`contain-intrinsic-size` 用实测中位高度（`auto` 记忆真实高度） |
| `power_user.chat_truncation` 默认 **100**，`printMessages` 只渲染最近 N 条并插入 `#show_more_messages` | ST 原生已有「历史分页」，再叠一层折叠会打架 | 检测到 `#show_more_messages` 时本扩展**自动不折叠**；体检里显示原生截断条数并给出二选一建议 |
| 流式渲染每个 tick 都跑 `cleanUpMessage → 正则 → DOMPurify → showdown`，频率由 `power_user.streaming_fps`（默认 **30**）决定 | 「越打越卡」是每帧重复解析，不是消息变长本身 | 新增可选的「流式降频」上限（20/15/10 FPS），并在停用/暂停/选回「不改」时还原 ST 原值 |
| 消息节点是 `#chat` 的**直接子节点**，内容更新通过 `updateMessageBlock` 改 `.mes_text.innerHTML` | 全子树 `MutationObserver` 是白交的观察成本 | 观察器改为 `childList`（只看直接子节点），内容变化走 `MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_EDITED` 事件 |
| ST **没有**给聊天图片设置 `loading=lazy` | 长聊天里图片同步解码会掉帧 | 懒加载 + `decoding="async"` 确实有效，不是重复造轮子 |
| 扩展生命周期靠 `manifest.hooks`（`disable` / `enable` / `clean` / `update` / `install`…）回调 | 没有声明 hooks 时，禁用扩展的 `onDisable` 根本不会被调用 | manifest 声明三个钩子，禁用即撤销注入、启用即恢复、更新/删除前清理残留 |
| 消息编辑用动态创建的 `#curEditTextarea`，推理块编辑用 `.reasoning_edit_textarea` | 只判断前者会漏掉推理块编辑 | 「编辑时暂停」同时识别两种编辑态 |
| 原生有 `MORE_MESSAGES_LOADED`、`CHAT_LOADED`、`STREAM_TOKEN_RECEIVED`、`MESSAGE_*` 全套事件 | 不必靠轮询猜状态 | 全部改成事件驱动，并顺手量出「加载耗时 / TPS」 |

---

## v1.3 做了什么：第二轮源码核查（重点是「别和 ST 打架」）

这一轮重新拉了 release 分支源码，专查「我们以为对、其实会互相干扰」的地方：

| 在 ST 源码里查到的事实 | 意味着什么 | v1.3 的应对 |
| --- | --- | --- |
| `showMoreMessages` 会先量 `prevHeight`，前插消息后按 `newHeight - prevHeight` 补 `scrollTop` | 虚拟化会让新前插消息只按估算高度记账，高度差算错 → 点「Show more」会跳位 | **只要 `#show_more_messages` 存在就不做虚拟化**；折叠历史同样让路 |
| `chat_truncation` 只影响 `printMessages` 的渲染量，不影响 prompt 上下文 | 借用原生分页是「最原生、最不容易出 bug」的减负手段 | 面板新增「借用 ST 原生分页」（不改 / 最近 50 / 80 / 100 / 150 / 300），记录原值，停用、暂停、选回「不改」都还原；你若自己在 ST 里改过，就不覆盖你的值 |
| `updateMessageElement` 每次渲染都会重设 `.avatar img` 的 `src` | 对 `#chat img` 全量懒加载会让头像在滚动时闪加载 | 懒加载只作用于 `.mes_block img`（正文图/媒体）与 `.mes_block iframe`，**头像不碰** |
| `power_user.message_token_count_enabled` 默认 **false**，开启后消息落地与滑动都要 `getTokenCountAsync` | 这是可归因的额外分词开销，不是玄学 | 体检新增「ST 逐条 token 计数」并给建议；**不擅自改你的设置** |
| `power_user.auto_fix_generated_markdown` 默认 **true**，每次渲染对整条消息跑 `fixMarkdown` | 长消息渲染成本之一 | 体检显示状态（同样只报告，不动设置） |
| `MESSAGE_RECEIVED` / `*_MESSAGE_RENDERED` 在 `append` + `scrollChatToBottom` 之后触发 | 能量「消息落地后到稳定一帧」的真实收尾耗时（含 TTS/总结类扩展） | 体检新增「消息落地」 |
| 手机键盘弹出/收起走 `visualViewport`，普通 `resize` 不一定触发 | 只影响悬浮 UI 的定位，与卡顿无关 | v1.3 曾让 HUD 监听；v1.6 已移除 HUD，不再需要这段 |
| 切聊天、连发多条会连续触发一串 `MESSAGE_*` 事件 | 每个事件都全量扫一遍 DOM 是白烧 CPU | sweep 改为 300ms 去抖 + `requestIdleCallback(timeout 600)`（不支持则立即执行） |

用法建议：消息量很大（500+）且不介意顶部有「Show more」时，优先用「借用 ST 原生分页」设 150–300，比本扩展自己折叠更稳，也更接近 ST 作者的设计意图。

---

## v1.4 做了什么：第三轮核查（对齐 release 1.19.1）

这一轮直接拉了当前 release（1.19.1）重读，重点找「ST 自己新增的重活」和「我们可能已经过时的假设」：

| 在 ST 1.19.1 源码里查到的事实 | 意味着什么 | v1.4 的应对 |
| --- | --- | --- |
| 新增 `power_user.stream_fade_in`（默认关）：开启后**每个流式 tick** 都会 clone 整条消息 → `Intl.Segmenter` 把每个词包成 `<span class="text_segment">` → `morphdom` 全树 diff（`scripts/util/stream-fadein.js`） | 长消息 + 30 FPS 下这是数量级最贵的单项，比降频还狠 | 新增「生成时临时关闭流式淡入」开关：只在生成期把 ST 该项设为 false，生成结束、暂停、停用、清理都会还原（`fadeApplied` 记录，防止中途崩溃丢设置）；体检里显示它是否开着 |
| ST 的 `messageFormatting` 没有任何缓存，每次渲染整条消息都要重跑宏/正则/净化/Markdown | 任何「重渲染」都是全量成本，优化只能减少次数与频率 | 已有生成轻量渲染 + 流式降频；v1.4 再把「最后一条流式消息」强制 `content-visibility: visible`，确保它不会因为热区判定滞后被虚拟化跳过 |
| `fast_ui_mode`（默认 **true**）通过 `body.no-blur * {backdrop-filter: unset}` 全局去模糊 | 默认配置下聊天区毛玻璃本来就已经没了；此时再点「关闭毛玻璃」看不到变化是正常的 | 体检新增「ST 快速 UI」行，并提示这是 ST 原生的一键全界面去模糊方式；不再让用户误以为开关失效 |
| `smooth_streaming*` 只被 `scripts/sse-stream.js` 当作**人为延迟**使用（`getDelay()` 按标点加停顿） | 它不是性能开关：开了只是把流放慢，不会更卡；v1.4 曾误判为「无消费点」，v1.6 更正 | 不把它当优化项，也不擅自关；想更快看到完整输出可自行关闭 |
| `#show_more_messages` 的分页补偿逻辑与 1.19.1 一致（`prevHeight` → 前插 → `newHeight - prevHeight` 补 `scrollTop`） | v1.3 的「有分页就不虚拟化」判断在新版本仍然必要 | 保持不变，并在体检里标注「分页中」 |
| 正则脚本挂在 `extension_settings.regex`，`getRegexedString` 在每次消息渲染/推理更新时全量跑一遍 | 脚本越多，单条渲染越慢，且与消息数无关 | 体检新增「正则脚本」计数，>5 条给「精简不常用的脚本」建议 |
| 消息 DOM 结构、事件名（`CHAT_CHANGED='chat_id_changed'`、`MORE_MESSAGES_LOADED` 等）、`#curEditTextarea` / `.reasoning_edit_textarea`、`#extensions_settings2`、`#right-nav-panel` 全部未变 | 扩展的挂钩点没有失效 | 无需迁移；v1.4 的改动都在这些稳定挂钩之内 |

顺带修正一个细节：生成期间 ST 会持续往 `#chat` 末尾追加/更新消息，而本扩展在生成期是暂停扫描的；v1.4 在消息落地事件里补一次热区标记，并在 CSS 上把最后一条强制可见，避免「生成到一半，最后一条被判到热区外」。

---

## v1.5 做了什么：第四轮核查（把「归因」做准，把自身开销压下去）

第四轮盯的是两件事：体检会不会误判、以及这个扩展自己在长聊天里有没有偷偷变贵。

| 在 ST 1.19.1 源码里查到的事实 | 意味着什么 | v1.5 的应对 |
| --- | --- | --- |
| 扩展的启停真相是 `extension_settings.disabledExtensions` 数组，`isEnabled` 判断都走它 | 只按「设置里有没有这个键」统计，会把装了但停用的扩展算成负担，归因会错 | 体检按 `disabledExtensions` 过滤，新增「重型扩展」行：`expressions / vectors / caption / translate / tts / memory / quickReply / sd / regex`，并给出「随消息或生成触发额外工作」的建议 |
| `scrollChatToBottom` 在流式每个 tick 都读一次 `chatElement[0].scrollHeight`（`waitForFrame` 下按帧节流） | 最后一条消息必须真实参与布局，否则 `scrollHeight` 只能按估高算，滚动会抖 | 保留并强化 v1.4 规则：生成期 `.mes:last-child` 强制 `content-visibility: visible`，消息落地事件补热区标记 |
| `saveChatDebounced` 是 debounce + `saveChatConditional`，不在每个 token 上序列化整份 chat | 生成期的卡不是存档造成的；关自动保存只会丢数据 | 不提供「关闭自动保存」这类危险开关，README 明确说明 |
| `appendMediaToMessage` 只挂 DOM，1.19.1 没有给聊天媒体加 `autoplay` | 不需要为视频/音频自动播放额外做处理 | 维持只对 `.mes_block img/iframe` 做懒加载 |
| `getChat` 没有渐进式首屏加载，`showMoreMessages` 的 `messagesToLoad` 只是可选入参 | 打开聊天就是一次性渲染 N 条，首屏耗时全在主线程 | 「上次加载」指标依然准确；控制首屏条数仍靠 ST 原生分页 |
| 我们自己的「超长消息折叠」每次都要读所有未折叠消息的全文来判断长度 | 消息多且长时，光是判断就接近 O(总字数)，属于扩展自带的隐形开销 | 改为「签名 + dirty 标记」：只有消息增减、阈值变化、编辑/滑动后才全量扫；平时只复核已折叠的少量消息 |
| 体检里的节点数原来用 `document.querySelectorAll('*')` | 在超大 DOM 上会分配一个包含所有节点的数组，体检本身可能卡一下 | 改用 `getElementsByTagName('*')` 的 live length，不产生数组 |

另外，这一轮也确认了几个「看起来该改、其实不该碰」的点：存档、媒体自动播放、首屏加载都不在我们的可安全干预范围内，硬改只会带来数据或体验风险，所以只做归因与提示。

---

## v1.6 做了什么：第五轮全仓库核查（修正错项 + 去掉悬浮窗）

这一轮把整棵 `public/` 前端源码重新过了一遍，重点是「我们写的优化到底打没打中」和「扩展自己有没有在空转」。结论：有 4 处优化项打错了目标，若干处自身开销可以省掉，HUD 按你的要求整体移除。

| 在 ST 1.19.1 源码里查到的事实 | v1.5 及以前的问题 | v1.6 的修正 |
| --- | --- | --- |
| 真正带 `background-attachment: fixed` 的是 `#bg1`（`public/css/backgrounds.css` 第 2 行），`body` / `#chat` / `.background` 都没有 | 「停用动画背景」实际几乎没生效，fixed 背景还在每帧重绘 | 规则改为直接命中 `#bg1`、`#bg_custom`、`#bg_custom_content`：`background-attachment: scroll` + 去掉背景切换过渡 |
| 滑动动画 `.slide` 靠 `will-change: transform` 预提升（`style.css` 第 1238 行） | 「清理 will-change」把 `#chat *` 全清了，滑动时反而少一层合成提示 | 规则改为 `#chat *:not(.slide)`，只清主题滥用，不动 ST 自己的滑动提示 |
| `.last_mes` 在生成期被加了 `contain: layout paint style` | `paint` 会把消息内溢出内容裁掉（阴影、悬浮操作、超宽代码块） | 降为 `contain: layout`，只隔离布局传播，不裁剪绘制 |
| `contain-intrinsic-size: auto <len>` 在部分浏览器（尤其旧 Firefox）不支持 `auto` 关键字，整条声明会被丢弃 | 一旦声明失效，被跳过的消息按 0 高度记账，滚动条会大跳 | 同时写两行：`contain-intrinsic-size: var(--al-cv-size,240px)` 兜底，再用 `auto …` 覆盖；不支持的浏览器至少还有实测中位高度 |
| 实测中位高度原来抽样 `.mes:not(.al-hot)` | 抽到的正是被虚拟化的元素，`getBoundingClientRect()` 返回的是估高，等于拿估算校准估算 | 改为只量热区 `.mes.al-hot`（永远真实渲染）的真实高度 |
| `applyHotZone()` 每次扫描都遍历全部消息做 `classList.contains` | 3000 条聊天里每次增删消息都要 O(n) 跑一遍 | 只处理尾部 30 条；只有消息总数变化时才清理一次旧热区；消息计数改用 `getElementsByClassName('mes').length` 的 live collection |
| 关闭「折叠历史 / 超长折叠」时，`applyTrim/applyClip` 仍然先 `querySelectorAll` 建数组、算签名 | 开关关着也在每次扫描时做无用功 | 先做一次廉价的「有没有残留类」检查，没有就直接返回 |
| 懒加载只加属性，没有撤销路径 | 关掉「图片懒加载」后，`loading=lazy` / `decoding=async` 仍留在消息里 | 记录哪些属性是本扩展加的（`data-al-loading/decoding`），关闭或清理时精确移除；`loading` 原本就有的不动 |
| rAF 帧率循环无条件常驻；1 秒定时器每 10 秒 `syncPanel + renderDiagnostics` | 关掉自动降级、面板也关着时，仍在 60Hz 唤醒主线程、定期做 `getComputedStyle` | 帧率循环只在「自动降级开 或 体检面板可见」时运行，否则连 rAF 都取消；体检刷新只在面板可见时做 |
| 面板可见性原来判断 `#right-nav-panel` 是否 `openDrawer` | 本扩展挂在 `#extensions_settings2`，它的抽屉是 `#rm_extensions_block`——原判断几乎永远为假，10 秒自动体检其实从没跑过 | 改为 `panelEl.closest('.drawer-content').classList.contains('openDrawer')`，与 ST 真实 DOM 一致 |
| 毛玻璃体检只抽样 `.mes` | `backdrop-filter` 真正在 `#chat` / `#send_form` / `#top-bar` 容器上，消息本身通常没有 → 误报「无毛玻璃」 | 先查这 4 个容器，再抽样消息；`filter` 只认 `blur(` / `drop-shadow(`，不再把头像灰度算成模糊 |
| `extension_settings` 里混着 `apiUrl`、`apiKey`、`note`、`disabledExtensions` 等非扩展键 | 「已启用扩展」数量虚高，归因不准 | 排除元数据键，并跳过 `disabledExtensions` 里的名字 |
| `chat_truncation` 只在 `printMessages` 时消费 | 改「借用 ST 原生分页」后当前聊天不重渲染，要等下次切聊天才生效 | 改完 400ms 去抖调用 `getContext().printMessages()` 重新渲染（生成中/加载中跳过） |
| `CHAT_LOADED` 在 `printMessages()` **之前**触发，`CHAT_CHANGED` 在渲染**之后**触发（`getChatResult()`） | 「上次加载」从 `CHAT_CHANGED` 才开始计时，只量到最后两帧，永远显示 ~30ms | 改为 `CHAT_LOADED` 起表、`CHAT_CHANGED` 后两帧停表，才覆盖「解析 + 渲染 + 绘制」 |
| `smooth_streaming*` 被 `sse-stream.js` 消费（人为延迟），不是死设置 | v1.4 的结论错了，文档会误导 | 更正文档；不提供开关，避免把「放慢输出」当成优化 |

另外两处按你的要求直接砍掉：

- **悬浮仪表（HUD）整体移除**：不再有右下角小球、拖拽定位、`visualViewport` 夹取、`hud/hudPos` 设置、HUD 专属 CSS 与 `al-pulse` 动画。看帧率请打开扩展面板的「运行体检」，那里有同一套数据，而且不占屏幕、不拦截点击。
- **常驻开销再削一层**：禁用扩展时停掉 rAF 采样与 `MutationObserver`，清理时关定时器、断开两个 `PerformanceObserver`、撤掉懒加载属性与折叠类；启用时再恢复。

---

## v1.6.1 做了什么：第六轮复查（开关、生命周期、还原）

第六轮专门盯「开关是否真的接线」和「停用/重装是否留尾巴」，又抓到几处真 Bug：

| 问题 | 原因 | v1.6.1 的修正 |
| --- | --- | --- |
| 「滚动期降载」开关点了没反应 | 面板里有 `al-scrollidle`，但 `TOGGLES` 绑定表漏了它 | 补上绑定；滚动监听同时识别 `scrollIdle || scrollBlur` |
| 掉帧阈值 / 长任务阈值改不了 | 两个设置项存在于代码和体检逻辑里，但面板没有对应输入框 | 在「体验保护」里补两个数字输入，实时生效 |
| 选回「不改」后 ST 原生截断没还原 | `restoreNativeLimit` 用「当前下拉值」判断，选 0 后 applied 也是 0，条件永远不成立 | 单独记录 `truncAppliedValue`（实际写进 ST 的值），还原时用它比对；旧数据回落到 `nativeLimit` |
| 保存过「借用原生分页」，重启后只显示旧的条数 | 启动时 `chat_truncation` 改了，但 DOM 还按旧值渲染 | 初始化 / 重新启用 / 切聊天后检测到实际变化就调用 `printMessages` 重渲染；生成中则延后到结束 |
| 流式降频刷新后原值可能丢失 | `streamFpsApplied` 只在内存里，页面刷新/崩溃后无法判断当前值是不是扩展改的 | 每次写入都持久化 applied 值；还原仍只还原「确实等于我们写入值」的情况 |
| 关掉自动降级/点暂停后仍停在「极速·临时」 | boost 只由 FPS 恢复退出，关闭自动或暂停没有清 boost | 关自动、关总开关、暂停、手动改任一 boost 视觉项、切预设/重置都清 boost |
| 禁用后自动降级不再工作 | `onDisable` 停掉了 rAF，`onEnable` 没有重新拉起 | 启用时按 `needsFps()` 重启采样 |
| 同页卸载/重装后事件重复执行 | `eventSource.on` 的匿名闭包没有保存，无法 `removeListener`；滚动监听也会残留 | 记录 `[type, handler]` 与 scroll handler，卸载时全部摘除；延迟挂载加 `disposed` 闸门，避免卸载后重建面板 |
| 暂停期间仍在给图片加 `loading=lazy` | 扫描只判断了开关，没有判断 `isOn()` | `applyImages` 先判 `isOn()`，暂停/禁用即撤销 |
| 某次加载没等到 `CHAT_CHANGED` 就永远不虚拟化 | `chatLoading` 没有超时兜底 | `CHAT_LOADED` 起 8 秒兜底，超时清标记并重新应用 |
| 整体重渲染后折叠/裁剪不重做 | 签名只看「条数 + 末条 mesid」，`printMessages` 换了一批同数量、同 mesid 的节点会误判没变化 | MutationObserver 只对「`.mes` 节点增删」失效签名；折叠提示条不是 `.mes`，不会触发死循环 |
| 关图片懒加载把 iframe 懒加载也撤了 | 两个开关共用了一个提前返回 | 图片与 iframe 分别清理、分别应用 |
| 卸载后统计/面板残留 | `--al-cv-size`、样式、监听、面板没有统一收口 | 清理时移除 CSS 变量、样式、面板、监听与定时器，并置 `disposed` |
| 点过「展开全文」的消息，来新消息又被折回去 | 重扫只看字符数，没记住「用户展开过」 | 消息上打 `data-al-expanded`，重扫时跳过；关功能/卸载统一清理 |
| 点几次 Show more 后，折叠又把历史藏回去 | 只判断页面上有没有按钮；加载完按钮会被移除 | 同时看 `chat_truncation > 0`，只要 ST 原生截断在，扩展就不叠加折叠 |

这轮之后，`node --check` 通过，jsdom 测试覆盖初始化、折叠/裁剪、原生分页还原与重渲染、流式降频还原、禁用/启用、事件监听无泄漏、卸载无残留，全部通过。

---

## 与酒馆助手（JS-Slash-Runner）的兼容与加速

酒馆助手会把 `<html>`、`<head>`、`<body>` 的前端代码块替换成 iframe。它只扫描原生的 `<pre><code>`，不会认 AntiLag 的虚拟直出壳。

v1.7.8 对超大前端代码走“快速交接”：在 AFTER_REGEX 把代码截成 token，绕过 `fixMarkdown`、`encode_tags` 和 Showdown 对 2M+ HTML 的解析；AFTER_MARKDOWN 再直接还原成原生 `<pre><code class="no-highlight">`，让 ST 的 hljs 跳过，酒馆助手照常从中读出完整代码并渲染 iframe。

普通 JS/CSS/超长文本代码块仍走 AntiLag 虚拟直出；前端代码块不再变成 AntiLag 的加载中壳。

## v1.9.0 做了什么：把“体检”变成可执行的一键推荐

这一轮继续按 release 1.19.1 的渲染路径核对，重点不是再加一个性能开关，而是降低用户理解和配置成本。

- **智能推荐**：面板新增「智能推荐」按钮，只应用不改外观的安全项：虚拟化、图片懒加载、代码可视行、生成期关流式淡入/平滑流式、流式上限 15 FPS、角色字段 Token 跳过、滚动保持。消息数达到 300 时，桌面端建议借用 ST 原生分页 100 条，移动端建议 80 条。
- **不碰视觉项**：毛玻璃、阴影、过渡、动画背景、`contain` 都不会被推荐自动打开；想要这些仍由「均衡 / 极速」手动切换。推荐后不会把主题改得面目全非。
- **复制体检报告**：体检标题栏新增「复制报告」，把当前指标、建议、消息/DOM 数、加载耗时、落地耗时、帧率和长任务次数一次性复制到剪贴板，方便对比安装前后或发给别人排查。
- **移动端识别**：推荐用 `(pointer: coarse)` 区分手机/平板与桌面，移动端原生分页更激进，减少首屏要布局的消息数。
- **状态一致性**：应用推荐会退出临时极速、重新应用设置；如果推荐里包含原生分页，会立即重渲染当前聊天，不需要等下次切聊天。

这一轮仍然不改 ST 核心源码，推荐项全部可以回滚；视觉项不会被偷偷打开。

---

## v1.8.0 做了什么：继续核对 release 1.19.1 的事件与渲染热点

这一轮重新拉取 `release` 分支（`82b64a4`，1.19.1），逐段核对 `public/script.js`、`public/scripts/events.js`、`power-user.js` 后发现三处真实缺口：

- **v1.7.9 的「生成时临时关闭平滑流式」没有真正接上**：`GENERATION_STARTED` 只调了 `applyStreamFadeSkip()`，漏了 `applySmoothStreamSkip()`。现在生成开始时会真正把 `power_user.smooth_streaming` 临时设为 false，结束后还原；同时补上 `targetStreamFps()`，确保流式降频在生成开始时生效。
- **ST 1.19.1 新增/细分的渲染事件没有被消费**：`MESSAGE_FILE_EMBEDDED`、`MESSAGE_REASONING_EDITED`、`MESSAGE_REASONING_DELETED`、`TOOL_CALLS_RENDERED`、`IMAGE_SWIPED`、`CHARACTER_FIRST_MESSAGE_SELECTED` 都会往 `.mes_text` 写新 DOM，或者改变图片/首条消息。现在统一触发扫描与代码补水，避免这些路径留下未懒加载的图片、没补水的代码块或过期的裁剪签名。
- **`auto_fix_generated_markdown` 每次渲染都跑 `fixMarkdown`**：`messageFormatting()` 在 `AFTER_REGEX` 后无条件执行 `fixMarkdown(mes, true)`，长消息越多成本越高。体检新增「自动修 Markdown」行，只报告、不改用户设置；需要时可在 ST 用户设置里关掉（代价是畸形 Markdown 不再自动修复）。

这一轮没有改任何核心源码，也没有新增会常驻的扫描循环；新增事件都挂在现有的 `scheduleSweep` / `scheduleCodeHydration` 上，禁用扩展时统一摘除。

---

## v1.7.9 做了什么：对齐 ST 1.19.1 的官方性能项

这一轮重新核对 SillyTavern 官方 FAQ 与 release 1.19.1 源码（commit `82b64a4`）：

- 官方 FAQ 的性能建议是：**No Blur Effect（Fast UI）**、**Reduced motion**、浏览器硬件加速、流式 FPS 降到 **10–15**。AntiLag 的毛玻璃、过渡、流式降频、快速 UI 体检项都按这几个真实开关对齐，不改角色卡和上下文。
- **`smooth_streaming` 不是“更顺滑的渲染”**：1.19.1 的 `sse-stream.js` 会在每个流式分片之间 `await delay(getDelay(...))`，逗号/换行/句号还会额外加长。它不减少主线程解析，但会把回复整体拖慢。v1.7.9 新增「生成时临时关闭平滑流式」：只在 `GENERATION_STARTED` 到结束之间把 `power_user.smooth_streaming` 设为 false（轻度档默认关，均衡/极速档默认开），结束、暂停、停用、清理都会还原；记录 `smoothApplied`，中途刷新也不会把设置留在关闭状态。
- **`chat_truncation` 默认就是 100**：ST 只渲染最近 N 条，顶部 `Show more` 前插旧消息。v1.7.9 的「借用 ST 原生分页」补了 **50 / 80** 两档，移动端和大聊天可以更激进地减少要布局的 DOM；仍然只影响显示，不影响发给模型的上文。
- 体检新增 **平滑流式 / 减少动画** 两项，并提示 ST 官方推荐的 Reduced motion；移动端没有原生截断且 DOM 多时，直接建议 50–80 条。

这一轮没有把 ST 的 `fast_ui_mode`、`reduced_motion` 偷偷改掉：它们属于用户外观设置，AntiLag 只检测、给建议，避免“装个性能插件结果界面被改了”。

---

## v1.7.8 做了什么：2M+ 字符代码只画可视行，并与酒馆助手共存

这一轮把 ST 的消息渲染链路重新走了一遍：

`messageFormatting()` → 正则 → Showdown → DOMPurify → 插入 `.mes_text` → `addCopyToCodeBlocks()` 对每个 `pre code` 调 `hljs.highlightElement()`。

真正贵的不只是 Markdown：巨大代码块会先生成完整 HTML，再让 highlight.js 生成大量 `<span>`，最后参与布局。角色卡里的巨量代码还有第二条链路：`RA_CountCharTokens()` 会对编辑器所有字段逐个 `await getTokenCountAsync()`。

**这一版不再把 2.69M 字符塞进一个文本节点。** 完整代码保存在内存里，DOM 里只保留当前滚动窗口的几十行；单行超过 2000 字会切成可视段，但仍用原文复制。这样既不会出现超长文本节点布局失败导致的整块空白，也不会生成几万个高亮 span。

对应做了四件事：

1. **超大代码直出 + 可视行虚拟渲染**：用 ST 公开的 `messageFormatter.addHook()`，在 `AFTER_REGEX` 阶段把超大围栏代码替换成短 token，`AFTER_MARKDOWN` 阶段只生成块头和空代码视口。渲染后由 `hydrateCodeView()` 从 `state.codeBlocks` 取完整代码，只创建可视行的 DOM；块内没有 `<code>`，ST 的 `addCopyToCodeBlocks()` 不会再次跑 hljs。
2. **滚动窗口按行更新**：`.al-code-view` 本身是滚动容器，上下用 spacer 撑出总高度；滚动时只重建当前窗口的行，DOM 节点数不随 2.69M 的总代码增长。流式生成时也走这条路径，不再每个 tick 把整块代码塞进 DOMPurify。
3. **整条消息代码总量预算**：除了单块 8000 字，整条消息代码合计超过 30000 字时，小块也一起走虚拟直出。专门解决「几十个几百字代码块、单看都不大，但整条消息一起解析很卡」。
4. **角色字段 Token 统计降载**：在 ST 的 500ms/1000ms 防抖触发之前，把超大字段的 `data-token-counter` 摘掉，ST 的 `RA_CountCharTokens()` 就不会再对它们分词；字段缩小或关闭功能时自动恢复。只影响 token 数字，不改内容、不写角色卡。

兜底：已经渲染出来的旧消息，`convertRenderedHugeCode()` 会按消息统计代码总量，把超标的 `pre` 换成直出块；关闭功能/卸载时 `restoreDeferredCode()` 把直出块还原成普通 `pre`。

这轮之后，jsdom 覆盖 40 项：初始化、虚拟化、折叠/裁剪、代码块直出、可视行渲染、整条消息代码预算、角色字段跳过与清理恢复、原生分页还原与重渲染、流式降频还原、禁用/启用、事件监听无泄漏、卸载无残留，全部通过；另外用 Chromium 对 2.64M 字符代码做了可视行渲染验证。

> 说明：代码块默认显示约 62vh 高度，滚动可看完完整代码；块头的“复制”按钮复制的是完整原文。普通小代码块仍由 ST 原生 highlight.js 处理。

---

## 设计原则：先不打扰，再谈优化

1. **默认「轻度」档视觉零改动**：只做不可见的减负（虚拟化、懒加载、生成隔离、清理 will-change、滚动期降载）。
2. **结构性操作默认关闭**：折叠历史、裁剪超长消息要你手动开，且随时可还原、切聊天自动重置。
3. **编辑 / 选中文本时一切让路**：不折叠、不裁剪、不硬切样式。
4. **每次切样式先记 `#chat` 滚动位置再回填**；贴底时保持贴底。
5. **自动降级只动视觉开销**，绝不自动隐藏内容，也不写你的设置。
6. **和 ST 原生功能不重复**：原生已截断历史时，本扩展不再折叠。
7. **改 ST 设置必须能还**：流式降频会记录原值与「我们写进去的值」，停用 / 暂停 / 选回「不改」都会还原；你若中途自己改过 ST 设置，就不覆盖你的值。
8. **不占屏、不拦截操作**：不做悬浮窗；所有入口都在扩展面板里。

---

## 卡顿场景对照表

| 你会遇到的卡顿 | 真正的开销 | AntiLag 的处理 | 默认 |
| --- | --- | --- | --- |
| 聊天一长，滚动一顿一顿 | 几百条消息全量参与布局/绘制；`#chat` 自身毛玻璃每帧重采样 | 消息虚拟化（仅针对热区外消息，≥120 条才启用） | 开 |
| 滚动时按钮闪、hover 抖动 | 滚动中仍做 hover 命中与 transition 重算 | 滚动期降载：滚动中屏蔽按钮命中与过渡，停手 160ms 恢复 | 开 |
| 主题好看但整体发黏 | `backdrop-filter` 毛玻璃、`filter: blur()` | 关聊天区毛玻璃/滤镜（含 `#chat` 本体、`#send_form`；可扩到全界面） | 均衡档 |
| 背景在动、CPU 常年高 | 动画背景 / `background-attachment: fixed` | 停用背景动画 + 固定背景 | 均衡档 |
| 消息气泡发光、阴影多 | `box-shadow` / `text-shadow` 叠加（`#chat` 本体也有） | 关消息区与容器阴影 | 极速档 |
| 手机发烫、掉帧、切后台回来卡 | 主题滥用 `will-change`，GPU 图层堆积 | 清理 `#chat` 内被滥用的 `will-change` | 开 |
| 消息进出场动画拖慢滚动 | 每条消息的 `transition` / 关键帧 | 关消息区过渡与动画 | 极速档 |
| **流式输出越打越卡** | 每 tick 对整条消息重跑正则+净化+Markdown，默认 30 FPS | 生成期隔离 `.last_mes` 重特效；可选「流式降频」到 15–20 FPS | 生成隔离开；降频关 |
| 滚动时图片解码掉帧 | 所有图片同步解码（ST 未做懒加载） | `loading="lazy"` + `decoding="async"` | 开 |
| 消息里嵌网页/视频卡整页 | iframe 立即加载 | iframe `loading="lazy"` | 均衡档 |
| 单条超长回复拖动卡 | 巨型文本节点反复重排 | 超长消息先折前段，点「展开全文」 | 关（可选） |
| **打开角色卡就卡几秒** | ST 的 `RA_CountCharTokens` 对简介/示例/首条消息逐字段 `await getTokenCountAsync()`；字段里塞几十万字符代码时最明显 | 「跳过超大角色字段 Token 统计」：字段超过阈值就跳过统计（只影响数字显示，不改内容） | 开（20000 字） |
| **消息里几十个代码块，越滚越卡** | Showdown 解析全部代码，落地后 hljs 对每个 `pre code` 一次性高亮 | 超大代码直出：单块超 8000 字，或整条消息代码总量超 30000 字，绕过 Showdown 与 hljs；DOM 只保留当前滚动窗口的行 | 开 |
| 聊天几千条，找最近消息也卡 | 渲染树过大、内存占用高 | 折叠较早消息（保留最近 N 条），顶部一键展开 | 极速档（原生截断时自动跳过） |
| 输入长文本发涩 | 输入框自动增高 + 拼写检查 + 聊天区重排牵连 | `contain: layout` 隔离聊天区；体检给出「输入延迟」归因 | 极速档 |
| 手机弹键盘整页重排 | viewport 变化 + 抽屉动画 + 背景 blur 叠加 | 毛玻璃/动画背景关闭后重排成本显著下降 | 均衡档起 |
| 整屏僵住 0.3s+ | 主线程长任务：大聊天渲染、世界书多条目扫描、向量检索/摘要、正则脚本、扩展定时器、tokenizer 计数 | **CSS 解决不了计算**：体检做归因（10s 长任务、生成期长任务、输入延迟、TPS、扩展数） | 只诊断 |
| 切换聊天/打开抽屉卡一下 | 抽屉动画 + 大面积 blur + 聊天区重排 | 关毛玻璃后明显变轻；`contain` 隔离聊天区 | 均衡档起 |
| 用久了越来越卡（内存） | 长聊天 + 大图常驻、扩展定时器泄漏 | 折叠历史释放渲染树；体检看 DOM 节点数 | 极速档 |

> 诚实边界：世界书扫描、向量检索、正则、tokenizer 是**主线程计算**，纯前端 CSS 扩展无法消除，只能帮你把「谁在拖」看清楚。真要治，得减世界书条目 / 换更轻的检索扩展 / 关掉带 `setInterval` 的扩展。

---

## 三档模式

| 档位 | 适合 | 包含 |
| --- | --- | --- |
| **轻度**（默认） | 只想更顺，不想画面变样 | 虚拟化、懒加载、生成轻量渲染、清理 will-change、滚动期降载 |
| **均衡** | 用了毛玻璃/发光主题，能接受画面变朴素 | 轻度 + 关聊天区毛玻璃/滤镜（含输入条）+ 停背景动画 + iframe 懒加载 |
| **极速** | 手机端、长聊天、明显掉帧 | 均衡 + 关阴影 + 关过渡 + `contain` 隔离 + 折叠历史（保留 100 条） |

单项开关可自由改，改完徽标显示「自定义」，不会被预设覆盖。

---

## 功能

**面板位置**：`扩展` 抽屉 → 最下方 `AntiLag 流畅优化` 卡片（高级项折叠收纳，不占屏）。

- **三档模式**：轻度 / 均衡 / 极速，一键切换（入口只在扩展面板，不再有悬浮窗）。
- **体验保护**：编辑消息（含推理块）时暂停、选中文本时暂停、切换保持滚动位置、暂停 10 分钟做 A/B。
- **滚动期降载**：滚动中暂时屏蔽消息按钮的 hover 命中与过渡，停手立刻恢复；可选「滚动时临时关模糊」（默认关，低配机可开，会有一瞬视觉跳变）。
- **渲染减负**：消息虚拟化（阈值 30–500，热区 30 条永不虚拟化）、生成时轻量渲染、正文图片/iframe 懒加载（头像不碰）、清理 will-change、关毛玻璃、停动画背景、关阴影、关过渡、`contain` 隔离聊天区。
- **生成时临时关闭流式淡入**（新）：ST 的淡入每个 tick 都要整条消息重新分词并 morphdom，长消息时关掉收益很大；只在生成期生效，结束自动还原。
- **生成时临时关闭平滑流式**（v1.7.9）：ST 1.19.1 的 `smooth_streaming` 会在每个流式分片之间插入人工延迟，长回复更慢；轻度档默认关，均衡/极速档默认开，生成期关闭，结束自动还原。
- **流式降频**（新）：把 ST 的流式刷新上限压到 20/15/10 FPS，明显减少「正则+净化+Markdown」的重复解析；原值会被记录并在停用时还原。
- **借用 ST 原生分页**：把 ST 自己的「聊天截断」设成 50/80/100/150/300 条，只渲染最近 N 条、顶部「Show more」可翻回；改完会调用 ST 的 `printMessages` 立即重渲染，可还原，且不改变发给模型的上文。
- **历史管理**：折叠较早消息（默认关）；检测到 ST 原生分页或 `chat_truncation > 0` 时自动跳过（避免把用户刚点 Show more 加载出来的历史又藏回去）；顶部「展开」随时还原，不删数据。
- **超长消息折叠**：单条超过阈值（默认 3000 字）先显示前段，点「展开全文」。
- **超大普通代码直出**：单块超过 8000 字，或整条消息所有代码合计超过 30000 字，代码**完整保留、不折叠、不丢字符**，绕过 Showdown 解析和 hljs 的巨量 span；DOM 只渲染当前滚动窗口的几十行，2.69M 字符也不会整块空白。块内提供复制按钮，复制的是完整原文。
- **超大前端代码快速交接**（v1.7.8）：识别 `<html>/<head>/<body>` 的代码块，先 token 化绕过 Showdown、`encode_tags` 和 hljs（`no-highlight`），再还原成原生 `<pre><code>` 交给酒馆助手渲染 iframe；既不让代码卡在 AntiLag 的“加载中”壳，也不让 ST 先做一遍 2.69M 的 Markdown/HTML 解析。
- **角色卡 Token 统计降载**（v1.7.0）：角色简介/示例对话/首条消息等字段超过 20000 字时，跳过 ST 自带的分词统计，避免打开角色卡时被 `getTokenCountAsync()` 拖住；只影响 token 数字显示，不改角色卡内容。阈值与开关都可调。
- **体检与归因**：帧率、消息条数、**实际渲染条数/虚拟化状态**、**原生截断（含是否分页中）**、**上次加载耗时**、**消息落地耗时**、**输入延迟（10s 最大）**、**生成期长任务 + TPS**、**ST 流式 FPS**、**流式淡入/平滑流式状态**、**减少动画状态**、**ST 快速 UI 状态**、**正则脚本数**、**重型扩展**、**ST 逐条 token 计数状态**、DOM 节点、毛玻璃元素、will-change、动画背景、最长消息、图片数、扩展数，并按红黄项给建议。
- **自动降级**：连续 3 秒低于阈值（默认 28 FPS）→ 临时升级到「极速视觉」（不折叠内容），恢复 12 秒后自动退出，不写设置。

---

## 输入延迟怎么用

打字卡有两种完全不同的原因：

- **输入框本身重排**：自动增高、拼写检查、聊天区 `contain` 未隔离 → 调布局能解决。
- **主线程被占用**：按键事件排队等世界书扫描/正则/向量检索/tokenizer 算完 → 调布局没用。

体检里的「输入延迟 10s」来自浏览器的 Event Timing（Chrome/Edge 支持）：`keydown/input` 处理超 100ms 就会记录。**它 >100ms 说明是主线程算力问题，不是输入框样式问题**，这时该去减世界书条目、关重扩展，而不是继续调 CSS。

不支持 Event Timing 的浏览器该指标恒为「无慢事件」，其余功能不受影响。

---

## 与 ST 原生功能的关系（重要）

ST 自带「聊天截断」（`用户设置 → 聊天截断`，默认 100 条）：只渲染最近 N 条，顶部出现 `Show more messages`。

- 原生截断为 **100**：你的长聊天本来只渲染 100 条，虚拟化基本用不上，**也不需要再开折叠历史**——本扩展会自动跳过折叠，避免两套历史机制互相打架。
- 原生截断设为 **0（不限）**：所有消息都会渲染，这时虚拟化 / 折叠历史才真正有意义。

体检会直接告诉你当前属于哪种情况，并给出建议。两条路都行，**别同时叠三层**。

---

## 安装

### 方式一：手动放入（最稳）

1. 把整个 `antilag` 文件夹放到：
   - 桌面版：`SillyTavern/public/scripts/extensions/third-party/antilag`
   - 新版数据目录安装：`SillyTavern/data/<你的用户名>/extensions/antilag`
2. 重启 SillyTavern（或刷新页面）。
3. 打开「扩展」抽屉，确认出现 `AntiLag 流畅优化` 卡片并处于启用状态。

### 方式二：从本地 zip 安装

1. 解压 `antilag.zip`；
2. 按方式一把解压出的 `antilag` 目录放到位；
3. 刷新页面。

### 方式三：扩展管理器 URL 安装

在「扩展 → 安装扩展」里填：

```
https://github.com/Neohero521/SillyTavern-AntiLag
```

（仓库根目录带 `manifest.json`，可直接识别。）

---

## 建议怎么用

1. **先点「重新检测」**：看红黄项，哪项红开对应开关。
2. **长聊天（>300 条）**：先看「原生截断」——为 0 才需要虚拟化，阈值 120 左右最稳。
3. **毛玻璃/发光主题**：切「均衡」，掉帧通常直接减半；画面变朴素是原理，不是 bug。
4. **手机端**：切「极速」，保留 80–150 条；`contain` 隔离让键盘弹出重排更轻。
5. **流式输出卡**：先开「生成时轻量渲染」；仍卡再把「流式降频」设 15–20（文字更新会变粗一点，属于取舍）。
6. **想保观感**：留在「轻度」。
7. **怀疑优化本身影响体验**：点「暂停 10 分钟」对比。
8. **长期不用想关掉**：直接禁用扩展即可（manifest 已声明 hooks，禁用会撤销注入并还原 ST 的流式 FPS）。

---

## 体检指标怎么看

| 指标 | 含义 | 判断 |
| --- | --- | --- |
| 帧率 | rAF 实测帧率 | 低于阈值（默认 28）就是真卡；45 以下算偏黏 |
| 消息条数 | 聊天数据条数 | 300 以上必须关注 |
| 渲染条数 | 实际在 DOM 里的消息数 / 虚拟化状态 | 400 以上且虚拟化关 → 该开 |
| 原生截断 | ST 的 `chat_truncation` | 有值说明原生已分页，别再叠折叠 |
| 上次加载 | 打开聊天到首帧的耗时 + 条数 | >1200ms 说明加载链路偏重 |
| 输入延迟 10s | 键盘事件处理时长最大值 | >100ms = 主线程算力问题 |
| 10s 长任务 | 最近 10 秒主线程阻塞次数 / 最长一次 | 单次 >150ms 会有可感知的「顿一下」 |
| 生成期长任务 / TPS | 本次生成期间长任务次数 / 每秒 token | 次数多且 TPS 低 → 流式重绘或后端慢 |
| 流式帧率 | ST 当前 `streaming_fps` | ≥30 且生成期长任务多 → 可降频 |
| 流式淡入 | ST 的 `stream_fade_in` | 开着且长消息卡 → 开「生成时临时关闭」或直接在 ST 里关 |
| 平滑流式 | ST 的 `smooth_streaming` | 长回复等待明显 → 开「生成时临时关闭平滑流式」；它只改生成期节奏，不改渲染 |
| ST 快速 UI | `fast_ui_mode` / `body.no-blur` | 开着说明毛玻璃已全局去掉，本扩展的毛玻璃开关不会再有额外变化 |
| 正则脚本 | `extension_settings.regex` 条数 | >5 条且单条消息渲染慢 → 精简不常用的脚本 |
| 重型扩展 | 按 `disabledExtensions` 过滤后的 expressions/vectors/caption/translate/tts/memory/quickReply/sd/regex | 同时开 2 个以上且卡 → 先停用不用的，它们会随消息/生成额外触发 |
| 毛玻璃元素 | `#chat/#send_form/#form_sheld/#top-bar` + 抽样 30 条消息中含 `backdrop-filter` / `blur` / `drop-shadow` 的数量 | 大于 0 就值得关掉；ST 快速 UI 开着时本来就为 0 |
| will-change | 抽样消息里非 auto 的 will-change 数量 | >2 说明主题在滥用 |
| 动画背景 | 背景是否在动或 fixed | 是则滚动必掉帧 |
| 最长消息 | 最近 40 条里最长的字符数 | 超过 5000 字建议开超长折叠 |
| 已启用扩展 | `extension_settings` 里排除元数据、排除 `disabledExtensions` 后的模块数 | 超过 10 个建议逐个排查 |

---

## 技术实现

- 只用 `SillyTavern.getContext()` 稳定 API：`eventSource` / `eventTypes` / `extensionSettings` / `powerUserSettings` / `saveSettingsDebounced`，不 import 内部模块。
- 所有样式注入挂在 `html.antilag` / `body.antilag` 根类上，关总开关即整段移除；没有常驻悬浮窗。
- 虚拟化：`content-visibility: auto` 只作用于「热区之外」（最近 30 条永远真实渲染），`contain-intrinsic-size` 先用实测中位高度兜底、再用 `auto` 记忆真实高度；中位高度只从热区真实渲染的消息里量。
- 帧率用 `requestAnimationFrame` 分秒采样，但只在「自动降级开启 或 体检面板可见」时运行；长任务用 `PerformanceObserver({entryTypes:['longtask']})`；输入延迟用 `PerformanceObserver({type:'event', durationThreshold:104})`；不支持则静默降级。
- 生成期由 `GENERATION_STARTED / GENERATION_ENDED / GENERATION_STOPPED` 驱动：进入时断开 `MutationObserver`（不跟流式抢主线程），结束时重连并补扫。
- 页面隐藏时跳过扫描与刷新；面板不可见时不做定期体检渲染；禁用后停掉 rAF 与观察器。
- `MutationObserver` 只观察 `#chat` 的 `childList`（消息是直接子节点），消息内容变化走 ST 事件，不做全子树观察。
- 设置存 `extension_settings['antilag']`；暂停带时间戳，过期自动恢复。
- `manifest.hooks`：`disable → onDisable`、`enable → onEnable`、`clean → onCleanUp`。
- 代码直出只依赖 ST 公开的 `messageFormatter.addHook()`（`AFTER_REGEX` / `AFTER_MARKDOWN`），不 import 内部模块；代码文本先做 HTML 转义再写进 `<pre>`，不把代码当 HTML 解析。
- 角色字段降载只摘 `[data-token-counter]` 属性并记住原字段 id，不调用 ST 内部函数；字段缩小、关开关、禁用、卸载都会恢复。

---

## 边界与副作用

- **不改内容**：不动消息文本、不重写正则、不影响世界书扫描与出戏质量。
- **虚拟化的代价**：极早期消息在视口外时不参与布局；依赖实测高度 + `auto` 记忆，正常滚动不会跳位，但「直接跳转到很旧的消息」可能有一帧估算偏差。在意可关该项或调高阈值。
- **关闭毛玻璃**：视觉会明显变朴素（这是它的原理）。
- **折叠历史 / 超长折叠**：只裁显示不删数据，都能一键还原；切聊天后折叠状态重置。
- **`contain: layout`**：极速档启用；若主题依赖「聊天区撑开页面高度」，可关掉该项。
- **流式降频**：改的是 ST 全局设置 `streaming_fps`。本扩展会记录原值并在停用/暂停/选回「不改」时还原；**但如果你在扩展限流期间手动去 ST 设置里改过流式 FPS，本扩展不会覆盖你改后的值**（只还原仍等于它写进去的那个值）；若你先禁用扩展再保存设置，原值可能已被覆盖——最稳的做法是关扩展前把「流式降频」调回「不改」。
- **超大代码直出**：超过 8000 字的单块、或整条消息合计超过 30000 字的代码，完整原文保存在内存里，DOM 只渲染当前滚动窗口的行；块内提供“复制”按钮复制完整原文。这样 2.69M 字符也不会整块空白或生成几万个 span。代价是浏览器全局查找只能命中当前窗口内的行，滚动窗口外的代码不在 DOM 里；需要全文请用复制。普通小代码片段不受影响，仍由 ST 原生渲染和高亮。
- **角色字段 Token 统计**：跳过超大字段后，ST 面板上的 token 数字不包含这些字段；只影响统计显示，不影响实际发送给模型的内容。介意可关掉该项或调高阈值。
- **不支持 `longtask` / `event` timing 的浏览器**：对应体检项为空，其余功能正常。

---

## 文件结构

```
antilag/
├── manifest.json   # 扩展清单（loading_order: 100，hooks: disable/enable/clean）
├── index.js        # 面板 / 体检 / 归因 / 自动降级 / 生命周期钩子
├── style.css       # 面板、模式卡、折叠组样式（暗色鎏金，移动端适配）
└── README.md
```

## 版本

- **v1.9.0**：新增「智能推荐」（只改安全项、不改外观）与「复制体检报告」；按桌面/移动端给出原生分页 100/80 条建议；推荐后立即重渲染当前聊天。
- **v1.8.0**：继续核对 release 1.19.1 的 `events.js` / `script.js` / `power-user.js`——修复「生成时关闭平滑流式」漏调用；生成开始补 `targetStreamFps()`；接入 `MESSAGE_FILE_EMBEDDED`、`MESSAGE_REASONING_EDITED/DELETED`、`TOOL_CALLS_RENDERED`、`IMAGE_SWIPED`、`CHARACTER_FIRST_MESSAGE_SELECTED`；体检新增 `auto_fix_generated_markdown` 归因。
- **v1.7.9**：对齐 ST 1.19.1 官方性能项——新增「生成时临时关闭平滑流式」（`smooth_streaming` 的逐分片人工延迟）、原生分页补 50/80 档、体检增加平滑流式/减少动画；只检测不改用户的 ST 外观设置。
- **v1.7.8**：给超大前端代码加“快速交接”——在 Showdown 前截成 token，绕过 Markdown/HTML 解析，随后还原成原生 `<pre><code class="no-highlight">` 交给酒馆助手；hljs 直接跳过，酒馆助手仍能接管 iframe。普通大代码块继续虚拟直出。
- **v1.7.7**：兼容 `JS-Slash-Runner`（酒馆助手）。含 `<html>`、`<head>`、`<body>` 的前端代码块**不再被 AntiLag 截走**，原样交给 Showdown 和酒馆助手，由它转成 iframe 渲染；只有普通大代码块才走虚拟直出。此前把前端代码截成 raw 代码壳，酒馆助手只认原生 `<pre><code>`，所以会一直停在“代码加载中”。
- **v1.7.6**：给“代码加载中”加最后一道保险——每秒扫描仍停在 loading 的 `.al-code-full`，强制重试补水；允许 dataset 已标记但 `__alCodeState` 未建立的失败重试；loading 文案带版本号，方便确认实际加载的是哪一版。这样即使没有任何 ST 事件、主题延迟写入或 rAF 卡住，代码块也会在 1 秒内自己恢复。
- **v1.7.5**：彻底修掉“代码加载中”不结束——不再只依赖 `requestAnimationFrame`，`MutationObserver` 直接监听 `.mes_text` 里空壳落地并立即补水，同时 `hydrateCodeView` 先同步画一帧再下一帧校正。这样即使 ST 事件顺序、主题重渲染或 rAF 延迟，代码也会马上出现。2.69M 字符虚拟窗口、2.7M 多行、2.6M 单行回归通过。
- **v1.7.4**：修复 v1.7.3 空壳补水时机——`AFTER_MARKDOWN` 返回后再等一帧补水，确保 `.mes_text` 已写入；复制按钮改成鎏金描边，浅色主题也看得见。2.7M 多行、2.6M 单行 jsdom 回归通过，Chromium 2.69M 可视行验证通过。
- **v1.7.3**：修正 2M+ 字符代码整块空白——不再把完整代码塞进单个超长文本节点，改为完整代码存内存、DOM 只渲染可见行；上下 spacer 撑总高度，滚动按行重建；超长单行按 2000 字切可视段；流式期间也走可视行路径，避免每个 tick 把整块代码送进 DOMPurify；块内颜色用行级 token span，并强制前景色避免主题把代码染成背景色。jsdom 40 项通过，Chromium 2.64M 字符渲染验证通过。
- **v1.7.2**：过渡版本——完整文本 + CSS Custom Highlight API，只对可视行上色；已被 v1.7.3 替换。
- **v1.7.1**：过渡版本——代码完整直出，但没有语法颜色；已被 v1.7.2 替换。
- **v1.6.1**：第六轮复查——补齐「滚动期降载」缺失的事件绑定与掉帧/长任务阈值输入；修复原生分页选回「不改」不还原、启动/切换聊天不重渲染；持久化流式降频 applied 值；关闭自动降级/暂停/手动改视觉项时退出临时极速；禁用后重启 rAF；卸载时摘除事件与滚动监听、加 disposed 闸门；暂停时不再加图片懒加载；加载卡住 8 秒兜底；整体重渲染后重置折叠/裁剪签名（并避免提示条触发死循环）；图片与 iframe 懒加载拆分。
- **v1.6.0**：第五轮全仓库核查——移除悬浮仪表；修正「停用动画背景」未命中 `#bg1`、`will-change` 误清 `.slide`、生成期 `contain:paint` 裁切、`contain-intrinsic-size` fallback、中位高度抽样虚拟化元素等错项；折叠/裁剪关闭时不再空扫；懒加载可精确撤销；帧率采样与体检刷新按需启停（并修正面板可见性判断错抽屉）；原生分页改完立即重渲染；修正「上次加载」计时起点；更正 `smooth_streaming` 结论。
- **v1.5.0**：第四轮核查——体检按 `disabledExtensions` 真实启停归因，新增「重型扩展」；确认存档/媒体/首屏加载不属可安全干预范围（只归因不改）；「超长消息折叠」改为签名 + dirty 标记，避免长聊天里每次全量扫文本；节点统计改用 live collection。
- **v1.4.0**：第三轮源码核查（release 1.19.1）——新增「生成时临时关闭流式淡入」（`stream_fade_in` 每 tick 的 Segmenter + morphdom 是当前最贵的单项，可记录/还原）；生成期最后一条强制 `content-visibility: visible` 并补热区标记；体检新增「流式淡入 / ST 快速 UI / 正则脚本」并修正提示；确认 1.19.1 的 `smooth_streaming` 在 `sse-stream.js` 有逐流式分片延迟消费点，v1.7.9 才据此做生成期关闭。
- **v1.3.0**：第二轮源码核查——原生分页与虚拟化互斥（`show_more_messages` 存在即不虚拟化/不折叠）；新增「借用 ST 原生分页」并记录/还原原值（用户改过则尊重用户）；懒加载限定 `.mes_block img/iframe`，头像不再被懒加载；sweep 改 300ms 去抖 + `requestIdleCallback`；体检新增「消息落地 / ST 逐条 token 计数 / 分页中」；HUD 监听 `visualViewport` 防被键盘顶出屏幕。
- **v1.2.0**：源码级对齐（`#chat` 本体毛玻璃与阴影、输入条毛玻璃、原生 `chat_truncation` 协同、`childList` 观察器）；虚拟化热区 + 实测 `contain-intrinsic-size`；滚动期降载；流式降频（可还原）；输入延迟 / 加载耗时 / TPS / 原生截断体检；`manifest.hooks` 生命周期；推理块编辑识别。
- **v1.1.0**：三档模式、虚拟化阈值化、体验保护（编辑/选区让路、滚动保持、隐藏页暂停）、清理 will-change、伪元素毛玻璃、`contain` 隔离、超长消息折叠、暂停 10 分钟、生成期长任务归因、HUD 快捷切档、面板折叠收纳。
- **v1.0.0**：消息虚拟化、毛玻璃/滤镜关闭、动画背景停用、生成中轻量渲染、图片懒加载、历史折叠、FPS/长任务体检、悬浮仪表、自动降级。
