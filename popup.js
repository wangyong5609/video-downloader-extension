// 弹窗：点插件图标时出现。
// 结构：上半部分是各平台“取数据”的函数（送到网页里执行），下半部分是界面。
// 界面统一成一种卡片：平台标签 → 标题 → 清晰度 → 一个下载按钮 → 次要操作。

const main = document.getElementById('main');

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const send = (msg) => chrome.runtime.sendMessage(msg);
const fmtSize = (n) => (!n ? '' : n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 10485760 ? Math.round(n / 1048576) + ' MB' : (n / 1048576).toFixed(1) + ' MB');
const fmtDur = (s) => {
  s = Math.round(s || 0);
  if (!s) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

async function exec(tabId, func, args = [], world = 'MAIN') {
  const r = await chrome.scripting.executeScript({ target: { tabId }, world, func, args });
  return r && r[0] ? r[0].result : null;
}

// =====================================================================
// B站
// =====================================================================
// 在 B站 页面里执行：用页面自己的登录状态去问 B站 接口要视频地址
async function biliExtract() {
  const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (!m) return null;
  const bvid = m[1];
  const p = Number(new URLSearchParams(location.search).get('p')) || 1;
  const getJson = async (u) => (await fetch(u, { credentials: 'include' })).json();
  try {
    const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (view.code !== 0) return { error: view.message || '获取视频信息失败' };
    const pages = view.data.pages || [];
    const page = pages[p - 1] || pages[0];
    const play = await getJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${page.cid}&qn=0&fnval=4048&fourk=1`
    );
    if (play.code !== 0) return { error: play.message || '获取视频地址失败' };
    const d = play.data;
    const names = {};
    (d.accept_quality || []).forEach((q, i) => (names[q] = (d.accept_description || [])[i] || String(q)));

    let title = view.data.title;
    if (pages.length > 1) title += ` - P${page.page} ${page.part}`;
    const out = { title, owner: (view.data.owner && view.data.owner.name) || '', duration: page.duration, qualities: [], audio: null, subtitles: [] };

    if (d.dash) {
      // 同一清晰度有多种编码，优先选兼容性最好的 H.264（剪辑软件都认）
      const rank = (c) => (/^avc/.test(c) ? 0 : /^hev|^hvc/.test(c) ? 1 : 2);
      const byId = {};
      for (const v of d.dash.video || []) {
        if (!byId[v.id] || rank(v.codecs) < rank(byId[v.id].codecs)) byId[v.id] = v;
      }
      out.qualities = Object.values(byId)
        .sort((a, b) => b.id - a.id)
        .map((v) => ({
          label: names[v.id] || `${v.height}P`,
          codec: /^avc/.test(v.codecs) ? 'H.264' : /^hev|^hvc/.test(v.codecs) ? 'H.265' : 'AV1',
          size: Math.round(((v.bandwidth || 0) * (d.dash.duration || 0)) / 8),
          urls: [v.baseUrl || v.base_url].concat(v.backupUrl || v.backup_url || []).filter(Boolean),
        }));
      const audios = (d.dash.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth);
      if (audios[0]) {
        out.audio = { urls: [audios[0].baseUrl || audios[0].base_url].concat(audios[0].backupUrl || audios[0].backup_url || []).filter(Boolean) };
      }
    } else if (d.durl && d.durl.length === 1) {
      out.qualities = [{ label: names[d.quality] || '默认', codec: '', size: d.durl[0].size, urls: [d.durl[0].url].concat(d.durl[0].backup_url || []), single: true }];
    }

    try {
      const pv = await getJson(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${page.cid}`);
      const subs = (pv.data && pv.data.subtitle && pv.data.subtitle.subtitles) || [];
      out.subtitles = subs
        .filter((s) => s.subtitle_url)
        .map((s) => ({ name: s.lan_doc || s.lan, url: s.subtitle_url.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url }));
    } catch {}
    return out;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// =====================================================================
// 抖音
// =====================================================================
function douyinExtract() {
  const store = window.__vdl;
  let id = (location.pathname.match(/\/(?:video|note)\/(\d+)/) || [])[1] || new URLSearchParams(location.search).get('modal_id') || '';
  // 画面里正在播放的那个播放器（优先没暂停的、面积最大的）
  const players = [...document.querySelectorAll('video')]
    .map((v) => ({ v, r: v.getBoundingClientRect() }))
    .filter((x) => x.r.width > 100 && x.r.bottom > 0 && x.r.top < innerHeight)
    .sort((a, b) => Number(a.v.paused) - Number(b.v.paused) || b.r.width * b.r.height - a.r.width * a.r.height);
  const live = !!(players[0] && players[0].v.closest('[data-e2e="feed-live"]'));
  if (!id && !live) {
    // 推荐页：视频外层容器上带着作品编号
    for (const p of players) {
      const box = p.v.closest('[data-e2e-vid]');
      if (box) {
        id = box.getAttribute('data-e2e-vid') || '';
        break;
      }
    }
    if (!id) {
      const el = document.querySelector('[data-e2e="feed-active-video"]');
      id = (el && el.getAttribute('data-e2e-vid')) || '';
    }
  }
  let info = (store && store.awemes && store.awemes[id]) || null;

  // 单个视频页的数据有时是直接写在网页里的，不走接口，这里补一手
  if (!info && id) {
    try {
      const el = document.getElementById('RENDER_DATA');
      if (el) {
        const data = JSON.parse(decodeURIComponent(el.textContent));
        const fix = (u) => (u && u.startsWith('//') ? 'https:' + u : u);
        const found = [];
        const walk = (o, depth) => {
          if (!o || typeof o !== 'object' || depth > 10 || found.length) return;
          if (String(o.awemeId || '') === id && o.video) {
            found.push(o);
            return;
          }
          for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
        };
        walk(data, 0);
        if (found[0]) {
          const a = found[0];
          const formats = [];
          for (const b of a.video.bitRateList || []) {
            const urls = (b.playAddr || []).map((x) => fix(x.src)).filter(Boolean);
            if (urls.length) formats.push({ label: b.gearName || '', urls, width: b.width || 0, height: b.height || 0, size: b.dataSize || 0, h265: !!b.isH265, bitrate: b.bitRate || 0 });
          }
          if (!formats.length) {
            const urls = (a.video.playAddr || []).map((x) => fix(x.src)).filter(Boolean);
            if (urls.length) formats.push({ label: '默认', urls, width: a.video.width || 0, height: a.video.height || 0, size: 0, h265: false, bitrate: 0 });
          }
          if (formats.length) info = { id, desc: a.desc || '', author: (a.authorInfo && a.authorInfo.nickname) || '', duration: a.video.duration || 0, formats };
        }
      }
    } catch {}
  }

  // 最后的办法：直接读正在播放的播放器地址
  let fallback = [];
  if (!info) {
    const vids = players;
    if (vids[0]) {
      const v = vids[0].v;
      fallback = [v.currentSrc, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter((u, i, arr) => /^https?:/.test(u || '') && arr.indexOf(u) === i);
    }
  }
  return { hooked: !!store, id, info, fallback, live, pageTitle: document.title.replace(/\s*-\s*抖音\s*$/, '') };
}

// =====================================================================
// 小红书（视频笔记 + 图文笔记）
// =====================================================================
// 在小红书页面里执行：笔记的数据网页自己已经加载好了，放在 window.__INITIAL_STATE__ 里，直接读
function xhsExtract() {
  const unref = (x) => (x && typeof x === 'object' && '_rawValue' in x ? x._rawValue : x);
  try {
    const st = window.__INITIAL_STATE__;
    const noteState = st && unref(st.note);
    if (!noteState) return { error: 'nostate' };
    const map = unref(noteState.noteDetailMap) || {};
    const has = (k) => {
      const e = k && unref(map[k]);
      const n = e && unref(e.note);
      return !!(n && n.noteId);
    };
    const m = location.pathname.match(/\/(?:explore|discovery\/item|search_result)\/([0-9a-f]{24})/) || location.pathname.match(/\/user\/profile\/[^/]+\/([0-9a-f]{24})/);
    let id = m ? m[1] : '';
    if (!has(id)) id = unref(noteState.currentNoteId) || '';
    if (!has(id)) id = Object.keys(map).filter(has).pop() || '';
    if (!has(id)) return null;
    const n = JSON.parse(JSON.stringify(unref(unref(map[id]).note)));
    const fix = (u) => (typeof u === 'string' ? u.replace(/^http:/, 'https:').replace(/^\/\//, 'https://') : '');

    const out = { id, title: n.title || '', desc: n.desc || '', author: (n.user && (n.user.nickname || n.user.nickName)) || '', isVideo: n.type === 'video', formats: [], images: [] };

    const stream = (n.video && n.video.media && n.video.media.stream) || {};
    // 分组的名字小红书会换（h264 / EF4 之类），所以不认名字，全部读出来，编码看每条数据自己写的
    const codecOf = (v, key) => {
      const c = String(v.videoCodec || v.codec || key || '').toLowerCase();
      if (/hevc|h265|hvc|hev/.test(c)) return 'h265';
      if (/av1|av01/.test(c)) return 'av1';
      if (/avc|h264/.test(c)) return 'h264';
      return 'other';
    };
    for (const key of Object.keys(stream)) {
      for (const v of Array.isArray(stream[key]) ? stream[key] : []) {
        const urls = [v.masterUrl].concat(v.backupUrls || []).map(fix).filter(Boolean);
        if (urls.length) out.formats.push({ codec: codecOf(v, key), width: v.width || 0, height: v.height || 0, size: v.size || 0, bitrate: v.avgBitrate || v.videoBitrate || 0, urls });
      }
    }
    out.duration = (n.video && n.video.capa && n.video.capa.duration) || 0;

    for (const img of n.imageList || []) {
      const url = fix(img.urlDefault || img.url || img.urlPre || ((img.infoList || []).slice(-1)[0] || {}).url);
      if (!url) continue;
      const item = { url, width: img.width || 0, height: img.height || 0 };
      // 实况照片还带一小段视频
      const live = img.stream && (img.stream.h264 || img.stream.h265 || [])[0];
      if (live && live.masterUrl) item.liveUrl = fix(live.masterUrl);
      out.images.push(item);
    }
    return out;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// =====================================================================
// 快手、微博（数据由 hook.js 在页面里抄好，这里只负责取出来显示）
// =====================================================================
function kuaishouExtract() {
  const store = window.__vdl;
  if (!store || !store.walk) return { hooked: false };
  try {
    if (window.__APOLLO_STATE__) store.walk(window.__APOLLO_STATE__); // 页面里现成带着的作品数据
  } catch {}
  const m = location.pathname.match(/\/(?:short-video|video|fw\/photo)\/([^/?#]+)/);
  let item = m ? store.items['ks:' + m[1]] || null : null;
  const playing = store.playing();
  if (!item && playing.length) item = store.findByUrl('ks:', playing);
  return { hooked: true, item, fallback: item ? [] : playing, pageTitle: document.title.replace(/\s*[-_|]\s*快手.*$/, '') };
}

async function weiboExtract() {
  const store = window.__vdl;
  if (!store || !store.walk) return { hooked: false };
  let item = null;
  const tv = location.pathname.match(/\/tv\/show\/([\d:]+)/);
  const detail = location.pathname.match(/^\/\d+\/([A-Za-z0-9]{8,10})\/?$/) || location.pathname.match(/^\/detail\/(\d+)/);
  if (tv) item = store.items['wbtv:' + tv[1]] || null;
  if (!item && detail) {
    item = store.items['wb:' + detail[1]] || null;
    if (!item) {
      // 详情页：直接向微博要这一条的数据（用的是你自己的登录状态）
      try {
        const res = await store.rawFetch(`/ajax/statuses/show?id=${detail[1]}&locale=zh-CN`, { credentials: 'include', headers: { 'x-requested-with': 'XMLHttpRequest' } });
        store.walk(await res.json());
        item = store.items['wb:' + detail[1]] || null;
      } catch {}
    }
  }
  const playing = store.playing();
  if (!item && playing.length) item = store.findByUrl('wb', playing);
  return { hooked: true, item, fallback: item ? [] : playing, pageTitle: document.title.replace(/\s*[-_|]\s*微博.*$/, '') };
}

// =====================================================================
// YouTube 字幕
// =====================================================================
function ytExtract() {
  const player = document.querySelector('#movie_player');
  const pr = player && player.getPlayerResponse && player.getPlayerResponse();
  if (!pr || !pr.videoDetails) return null;
  const tracks = ((pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || []).map((t) => ({
    url: t.baseUrl,
    lang: t.languageCode,
    name: (t.name && (t.name.simpleText || (t.name.runs || []).map((x) => x.text).join(''))) || t.languageCode,
    auto: t.kind === 'asr',
  }));
  return { videoId: pr.videoDetails.videoId, title: pr.videoDetails.title, author: pr.videoDetails.author, duration: Number(pr.videoDetails.lengthSeconds) || 0, tracks };
}

// =====================================================================
// 通用：嗅探到的资源 + 页面上的播放器
// =====================================================================
function pageVideos() {
  return [...document.querySelectorAll('video')]
    .map((v) => ({ url: v.currentSrc || v.src || '', duration: isFinite(v.duration) ? v.duration : 0 }))
    .filter((x) => /^https?:/.test(x.url));
}

// =====================================================================
// 界面
// =====================================================================

// ---------- 图标（线条风格，跟随文字颜色）----------
const ICONS = {
  download: '<path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M4 16l4.5-4.5 4 4 2.5-2.5L20 17"/><circle cx="15.5" cy="9.5" r="1.2"/>',
  text: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  layers: '<path d="M12 4l8 4.5-8 4.5-8-4.5L12 4z"/><path d="M4 13l8 4.5 8-4.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  terminal: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M8 10l3 2.5L8 15M13.5 15H16"/>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ic';
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

// ---------- 提示条 ----------
function makeHint() {
  const el = h('div', { class: 'hint' });
  return {
    el,
    info: (t) => ((el.className = 'hint'), (el.textContent = t)),
    ok: (t) => ((el.className = 'hint ok'), (el.textContent = t)),
    err: (t) => ((el.className = 'hint err'), (el.textContent = t)),
  };
}

// ---------- 发起下载 ----------
async function startJob(job, hint) {
  const r = await send({ type: 'startJob', job });
  if (r && r.error) {
    hint.err('启动失败：' + r.error);
    return false;
  }
  hint.ok('已开始下载。进度在旁边新开的标签页里，下完会自动关闭，文件在“下载”文件夹。');
  return true;
}

// 主按钮：点了以后变成“已开始下载”，过几秒恢复，方便再下别的清晰度
function primaryButton(label, iconName, run) {
  const text = h('span', {}, label);
  const ic = icon(iconName);
  const btn = h('button', { class: 'btn primary block' }, ic, text);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const ok = await run();
    if (ok) {
      btn.classList.add('done');
      ic.replaceWith(icon('check'));
      text.textContent = '已开始下载';
      setTimeout(() => {
        btn.classList.remove('done');
        btn.querySelector('.ic').replaceWith(icon(iconName));
        text.textContent = label;
        btn.disabled = false;
      }, 3500);
    } else {
      btn.disabled = false;
    }
  });
  return btn;
}

// 次要操作：小号按钮，点完显示结果
function smallButton(label, iconName, run) {
  const btn = h('button', { class: 'btn sm' }, iconName ? icon(iconName) : null, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await run();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// ---------- 通用作品卡片 ----------
// view = {
//   platform: '抖音',
//   title, meta: ['作者', '1:02'],
//   formats: [{ label: '1080P', sub: '66 MB', job }],   // 可下载的清晰度，第一个是默认
//   formatNote: '…',                                    // 清晰度下面的一句小字
//   images: { count, label, job(toJpg) },               // 图片（图文作品 / 封面）
//   copyText: '…',                                      // “复制文案”
//   actions: [node],                                    // 其他小按钮
//   blocks: [node],                                     // 额外的一整块（比如字幕）
//   empty: '…',                                         // 没东西可下时显示的话
// }
function mediaCard(view, hint) {
  const card = h('div', { class: 'card stack' });
  card.append(
    h('div', { class: 'row' }, h('span', { class: 'pill accent' }, h('span', { class: 'dot' }), view.platform), h('span', { class: 'meta grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, (view.meta || []).filter(Boolean).join(' · ')))
  );
  if (view.title) card.append(h('div', { class: 'title', title: view.title }, view.title));

  const formats = view.formats || [];
  if (formats.length) {
    let picked = 0;
    const chips = formats.map((f, i) => {
      const chip = h('button', { class: 'chip' + (i === 0 ? ' on' : ''), type: 'button' }, h('b', {}, f.label), f.sub ? h('small', {}, f.sub) : null);
      chip.addEventListener('click', () => {
        picked = i;
        chips.forEach((c, j) => c.classList.toggle('on', j === i));
      });
      return chip;
    });
    const box = h('div', {}, h('div', { class: 'label', style: 'margin-bottom:6px' }, formats.length > 1 ? '选择清晰度' : '清晰度'), h('div', { class: 'chips' }, chips));
    if (view.formatNote) box.append(h('div', { class: 'meta', style: 'margin-top:6px' }, view.formatNote));
    card.append(
      box,
      primaryButton(view.primary || '下载视频', 'download', () => startJob(formats[picked].job, hint))
    );
  }

  if (view.images) {
    const jpg = h('input', { type: 'checkbox', checked: true });
    const run = () => startJob(view.images.job(jpg.checked), hint);
    const btn = formats.length ? smallButton(view.images.label, 'image', run) : primaryButton(view.images.label, 'image', run);
    if (formats.length) card.append(h('div', { class: 'row' }, btn, h('span', { class: 'grow' }), h('label', { class: 'check' }, jpg, '转成 JPG')));
    else card.append(btn, h('label', { class: 'check' }, jpg, '转成 JPG（剪辑和发布更通用）'));
  }

  for (const b of view.blocks || []) card.append(b);

  const actions = (view.actions || []).slice();
  if (view.copyText) {
    actions.unshift(
      smallButton('复制文案', 'copy', async () => {
        await navigator.clipboard.writeText(view.copyText);
        hint.ok('文案已复制。');
      })
    );
  }
  if (actions.length) card.append(h('div', { class: 'row', style: 'flex-wrap:wrap' }, actions));

  if (view.empty && !formats.length && !view.images && !(view.blocks || []).length) card.append(h('div', { class: 'meta' }, view.empty));
  card.append(hint.el);
  return card;
}

function loadingCard(platform) {
  return h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('span', { class: 'pill accent' }, h('span', { class: 'dot' }), platform), h('span', { class: 'meta' }, '正在解析…')));
}

// 把一段清晰度说明压成短标签：“高清 1080P” → “1080P”
const shortQuality = (s) => ((String(s).match(/\d{3,4}P\+?|[48]K/i) || [String(s)])[0]);

// ---------- 字幕保存 ----------
async function saveCues(cues, filename, ext, hint) {
  if (!cues.length) return hint.err('字幕内容是空的。');
  const text = buildSubtitleText(cues, ext);
  const r = await send({ type: 'saveText', filename, ext, text });
  if (r && r.error) hint.err('保存失败：' + r.error);
  else hint.ok(`字幕已保存到“下载”文件夹（共 ${cues.length} 句）。`);
}

// =====================================================================
// 各平台：把取到的数据整理成卡片
// =====================================================================

async function renderBili(tab, slot) {
  slot.replaceChildren(loadingCard('B站'));
  const info = await exec(tab.id, biliExtract);
  if (!info) return slot.replaceChildren(); // 不是视频页
  const hint = makeHint();
  if (info.error || !info.qualities.length) {
    slot.replaceChildren(mediaCard({ platform: 'B站', empty: '解析失败：' + (info.error || '没有找到可下载的视频') }, hint));
    return true;
  }
  const base = { filename: info.title, referer: 'https://www.bilibili.com/' };
  const view = {
    platform: 'B站',
    title: info.title,
    meta: [info.owner, fmtDur(info.duration)],
    formats: info.qualities.map((q) => ({
      label: shortQuality(q.label),
      sub: [q.size ? '约 ' + fmtSize(q.size) : '', q.codec && q.codec !== 'H.264' ? q.codec : ''].filter(Boolean).join(' · '),
      job: q.single || !info.audio ? { ...base, kind: 'direct', urls: q.urls } : { ...base, kind: 'merge', videoUrls: q.urls, audioUrls: info.audio.urls },
    })),
    formatNote: '能选到的最高清晰度取决于你在 B站 的登录和会员状态。',
    blocks: [],
  };
  if (info.subtitles.length) {
    const sel = h('select', { class: 'grow' }, info.subtitles.map((s, i) => h('option', { value: i }, s.name)));
    const save = async (ext) => {
      try {
        const s = info.subtitles[Number(sel.value)];
        const j = await (await fetch(s.url)).json();
        const cues = (j.body || []).map((c) => ({ start: c.from * 1000, end: c.to * 1000, text: c.content }));
        await saveCues(cues, `${info.title}.${s.name}`, ext, hint);
      } catch (e) {
        hint.err('字幕下载失败：' + e.message);
      }
    };
    view.blocks.push(h('div', {}, h('div', { class: 'label', style: 'margin-bottom:6px' }, '字幕'), h('div', { class: 'row' }, sel, smallButton('SRT', 'download', () => save('.srt')), smallButton('纯文本', 'text', () => save('.txt')))));
  }
  slot.replaceChildren(mediaCard(view, hint));
  return true;
}

async function renderDouyin(tab, slot) {
  slot.replaceChildren(loadingCard('抖音'));
  const r = await exec(tab.id, douyinExtract);
  if (!r) return slot.replaceChildren();
  const hint = makeHint();
  const referer = 'https://www.douyin.com/';
  const view = { platform: '抖音' };

  if (r.live) {
    view.empty = '当前这一条是直播，不支持下载。翻到普通视频再点插件图标。';
  } else if (r.info && !r.info.formats.length && (r.info.images || []).length) {
    const a = r.info;
    const name = (a.author ? a.author + ' - ' : '') + (a.desc || a.id);
    Object.assign(view, {
      title: a.desc || a.id,
      meta: [a.author, '图文作品'],
      images: { count: a.images.length, label: `下载全部图片（${a.images.length} 张）`, job: (toJpg) => ({ kind: 'images', items: a.images.map((x) => ({ url: x.url })), toJpg, filename: name, referer }) },
      copyText: a.desc,
    });
  } else if (r.info) {
    const a = r.info;
    // 同一分辨率只留一个，优先 H.264；按分辨率从高到低排
    const seen = new Set();
    const formats = a.formats
      .slice()
      .sort((x, y) => Math.min(y.width, y.height) - Math.min(x.width, x.height) || Number(x.h265) - Number(y.h265) || y.bitrate - x.bitrate)
      .filter((f) => {
        const key = String(Math.min(f.width, f.height)); // 每个清晰度只给一个按钮，免得选择困难
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const name = (a.author ? a.author + ' - ' : '') + (a.desc || a.id);
    Object.assign(view, {
      title: a.desc || a.id,
      meta: [a.author, fmtDur(a.duration / 1000)],
      formats: formats.map((f) => ({
        label: Math.min(f.width, f.height) ? Math.min(f.width, f.height) + 'P' : f.label || '默认',
        sub: [fmtSize(f.size), f.h265 ? 'H.265' : ''].filter(Boolean).join(' · '),
        job: { kind: 'direct', urls: f.urls, ext: '.mp4', filename: name, referer },
      })),
      copyText: a.desc,
    });
  } else if (r.fallback.length) {
    Object.assign(view, {
      title: r.pageTitle || '当前播放的视频',
      formats: [{ label: '当前清晰度', sub: '', job: { kind: 'direct', urls: r.fallback, ext: '.mp4', filename: r.pageTitle || '抖音视频', referer } }],
    });
  } else {
    view.empty = r.hooked ? '没有找到当前视频。先让视频播放起来，再点一次插件图标。' : '请刷新一下这个页面（插件是在页面打开之后才装上的），然后再试。';
  }
  slot.replaceChildren(mediaCard(view, hint));
  return true;
}

async function renderXhs(tab, slot) {
  slot.replaceChildren(loadingCard('小红书'));
  const r = await exec(tab.id, xhsExtract);
  const hint = makeHint();
  if (!r || r.error) {
    slot.replaceChildren(mediaCard({ platform: '小红书', empty: r && r.error && r.error !== 'nostate' ? '解析失败：' + r.error : '先点开一篇笔记，再点插件图标。' }, hint));
    return true;
  }
  const referer = 'https://www.xiaohongshu.com/';
  const head = r.title || r.desc.split('\n')[0] || r.id;
  const name = (r.author ? r.author + ' - ' : '') + head;
  const rank = { h264: 0, h265: 1, av1: 2, other: 3 };
  const CODEC = { h265: 'H.265', av1: 'AV1' };
  const seen = new Set();
  const formats = r.formats
    .slice()
    .sort((x, y) => Math.min(y.width, y.height) - Math.min(x.width, x.height) || rank[x.codec] - rank[y.codec] || y.bitrate - x.bitrate)
    .filter((f) => {
      const key = String(Math.min(f.width, f.height));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const view = {
    platform: '小红书',
    title: head,
    meta: [r.author, r.isVideo ? '视频笔记' : `图文笔记 · ${r.images.length} 张图`, fmtDur(r.duration)],
    formats: r.isVideo
      ? formats.map((f) => ({ label: Math.min(f.width, f.height) + 'P', sub: [fmtSize(f.size), CODEC[f.codec]].filter(Boolean).join(' · '), job: { kind: 'direct', urls: f.urls, ext: '.mp4', filename: name, referer } }))
      : [],
    copyText: [r.title, r.desc].filter(Boolean).join('\n\n'),
  };
  if (r.images.length) {
    view.images = {
      count: r.images.length,
      label: r.isVideo ? '下载封面' : `下载全部图片（${r.images.length} 张）`,
      job: (toJpg) => {
        const items = [];
        for (const img of r.images) {
          items.push({ url: img.url });
          if (img.liveUrl) items.push({ url: img.liveUrl, video: true });
        }
        return { kind: 'images', items, toJpg, filename: name, referer };
      },
    };
  }
  slot.replaceChildren(mediaCard(view, hint));
  return true;
}

// 快手、微博
async function renderHooked(tab, slot, opt) {
  slot.replaceChildren(loadingCard(opt.platform));
  const r = await exec(tab.id, opt.extract);
  const hint = makeHint();
  const referer = opt.referer;
  const view = { platform: opt.platform };
  if (!r || !r.hooked) {
    view.empty = '请刷新一下这个页面，然后再试。';
  } else if (r.item) {
    const it = r.item;
    const firstLine = (it.title || '').split('\n')[0].trim();
    const name = (it.author ? it.author + ' - ' : '') + (firstLine || it.id);
    const res = (f) => (f.width && f.height ? Math.min(f.width, f.height) : f.height || 0);
    const seen = new Set();
    const formats = it.formats
      .slice()
      .sort((x, y) => res(y) - res(x) || Number(x.codec === 'h265') - Number(y.codec === 'h265') || (y.size || y.bitrate) - (x.size || x.bitrate))
      .filter((f) => {
        const key = `${res(f)}_${res(f) ? '' : f.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    Object.assign(view, {
      title: firstLine || it.id,
      meta: [it.author, it.images.length ? `${it.images.length} 张图` : '', fmtDur(it.duration / 1000)],
      formats: formats.map((f) => ({ label: res(f) ? res(f) + 'P' : f.label || '默认', sub: [fmtSize(f.size), f.codec === 'h265' ? 'H.265' : ''].filter(Boolean).join(' · '), job: { kind: 'direct', urls: f.urls, ext: '.mp4', filename: name, referer } })),
      copyText: it.title,
    });
    if (it.images.length) {
      view.images = {
        count: it.images.length,
        label: `下载全部图片（${it.images.length} 张）`,
        job: (toJpg) => {
          const items = [];
          for (const img of it.images) {
            items.push({ url: img.url });
            if (img.liveUrl) items.push({ url: img.liveUrl, video: true });
          }
          return { kind: 'images', items, toJpg, filename: name, referer };
        },
      };
    }
  } else if (r.fallback.length) {
    Object.assign(view, {
      title: r.pageTitle || '当前播放的视频',
      formats: [{ label: '当前清晰度', sub: '', job: { kind: 'direct', urls: r.fallback, ext: '.mp4', filename: r.pageTitle || opt.platform, referer } }],
    });
  } else {
    view.empty = opt.emptyHint;
  }
  slot.replaceChildren(mediaCard(view, hint));
  return true;
}

async function renderYoutube(tab, slot) {
  const info = await exec(tab.id, ytExtract);
  if (!info) return slot.replaceChildren();
  const hint = makeHint();
  const view = { platform: 'YouTube', title: info.title, meta: [info.author, fmtDur(info.duration)], blocks: [], actions: [] };

  if (info.tracks.length) {
    const sel = h('select', { class: 'grow' }, info.tracks.map((t, i) => h('option', { value: i }, t.name + (t.auto && !/自动|auto/i.test(t.name) ? '（自动生成）' : ''))));
    const zh = h('input', { type: 'checkbox' });
    const save = async (ext) => {
      hint.info('正在获取字幕…');
      const t = info.tracks[Number(sel.value)];
      const tlang = zh.checked && !/^zh/i.test(t.lang) ? 'zh-Hans' : '';
      const uniqueLang = info.tracks.filter((x) => x.lang === t.lang).length === 1;
      const r = (await send({ type: 'ytCaption', tabId: tab.id, track: t, videoId: info.videoId, tlang, uniqueLang, ext, filename: `${info.title}.${tlang || t.lang}` })) || {};
      if (r.ok) return hint.ok(`字幕已保存到“下载”文件夹（共 ${r.count} 句）。`);
      hint.err(
        r.reason === 'nohook'
          ? '请刷新一下这个页面（插件是在页面打开之后才装上的），然后再试。'
          : r.reason === 'ad'
            ? '正在放广告，等广告结束、正片开始播放后再试一次。'
            : tlang
              ? '没拿到翻译字幕（YouTube 没有返回内容）。可以取消勾选“翻译成中文”，先下载原文字幕。'
              : '没拿到字幕。请先让视频播放几秒钟，再试一次。' + (r.error ? '（' + r.error + '）' : '')
      );
    };
    const srt = h('button', { class: 'btn primary block' }, icon('download'), h('span', {}, '下载字幕（SRT）'));
    srt.addEventListener('click', async () => {
      srt.disabled = true;
      await save('.srt');
      srt.disabled = false;
    });
    view.blocks.push(
      h('div', {}, h('div', { class: 'label', style: 'margin-bottom:6px' }, '字幕语言'), h('div', { class: 'row' }, sel)),
      h('label', { class: 'check' }, zh, '翻译成中文（YouTube 自带的机器翻译）'),
      srt
    );
    view.actions.push(smallButton('存成纯文本', 'text', () => save('.txt')));
  } else {
    view.blocks.push(h('div', { class: 'meta' }, '这个视频没有字幕。'));
  }

  // 视频本身：YouTube 的视频地址是加密的，交给本机的 yt-dlp 最稳
  const cmd = `yt-dlp "https://www.youtube.com/watch?v=${info.videoId}"`;
  view.actions.push(
    smallButton('复制视频下载命令', 'terminal', async () => {
      await navigator.clipboard.writeText(cmd);
      hint.ok('命令已复制（yt-dlp）。粘贴到“终端”里回车即可下载视频本身。');
    })
  );
  slot.replaceChildren(mediaCard(view, hint));
  return true;
}

// =====================================================================
// 批量下载入口
// =====================================================================
async function renderBatchEntry(tab, slot, hooked) {
  let tip = '列出本页的全部视频 / 笔记，勾选后一起下载';
  if (hooked) {
    const n = await exec(tab.id, () => (window.__vdl && window.__vdl.list ? window.__vdl.list().length : -1));
    if (n == null || n < 0) return;
    tip = `本页已加载 ${n} 个作品，也能导出数据表`;
  }
  const row = h('button', { class: 'card entry', type: 'button' }, h('span', { class: 'entry-ic' }, icon('layers')), h('span', { class: 'grow' }, h('b', {}, '批量下载'), h('span', { class: 'meta' }, tip)), icon('chevron'));
  row.addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'openDrawer' }); // 在网页右侧打开面板
    } catch {
      await send({ type: 'openBatch', tabId: tab.id }); // 页面还没刷新过时，退回到独立窗口
    }
    window.close();
  });
  slot.replaceChildren(row);
}

// =====================================================================
// 通用：嗅探到的资源 + 页面上的播放器
// =====================================================================
async function renderResources(tab, slot, hasCard) {
  const KIND = { video: '视频', audio: '音频', hls: 'm3u8', dash: 'mpd' };
  let items = (await send({ type: 'getSniffed', tabId: tab.id })) || [];
  if (!Array.isArray(items)) items = [];

  // 页面播放器里直接能读到的视频地址也算上
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: pageVideos });
    for (const f of frames) {
      for (const v of f.result || []) {
        const u = new URL(v.url);
        if (/(^|\.)googlevideo\.com$/.test(u.hostname)) continue;
        const key = u.origin + u.pathname;
        if (items.some((x) => x.key === key)) continue;
        if (/\.m3u8$/i.test(u.pathname)) items.unshift({ key, kind: 'hls', url: v.url, size: 0, name: '页面播放器', host: u.hostname });
        else items.unshift({ key, kind: 'video', url: v.url, size: 0, name: '页面播放器' + (v.duration ? `（${fmtDur(v.duration)}）` : ''), host: u.hostname });
      }
    }
  } catch {}

  // 已经有平台卡片、又没嗅探到东西时，这一块不显示，免得添乱
  if (hasCard && !items.length) return slot.replaceChildren();

  const hint = makeHint();
  const title = (tab.title || '视频').replace(/\s*[-_|–—]\s*[^-_|–—]{1,20}$/, '') || tab.title || '视频';

  if (!items.length) {
    slot.replaceChildren(
      h(
        'div',
        { class: 'card empty-state' },
        h('div', { class: 'empty-ic' }, icon('download')),
        h('b', {}, '这个页面还没发现视频'),
        h('div', { class: 'meta' }, '让视频播放几秒钟，再点一次插件图标。'),
        h('div', { class: 'meta' }, 'B站、抖音、小红书、快手、微博会自动识别当前作品。')
      )
    );
    return;
  }

  const list = h('div', { class: 'res-list' });
  for (const it of items) {
    const dl =
      it.kind === 'dash'
        ? null
        : smallButton('下载', 'download', async () => {
            await startJob({ kind: it.kind === 'hls' ? 'hls' : 'direct', urls: [it.url], filename: title, referer: tab.url }, hint);
          });
    const cp = h('button', { class: 'btn sm ghost', title: '复制链接' }, icon('copy'));
    cp.addEventListener('click', async () => {
      await navigator.clipboard.writeText(it.url);
      hint.ok('链接已复制。');
    });
    list.append(h('div', { class: 'res' }, h('span', { class: 'pill' }, KIND[it.kind] || it.kind), h('div', { class: 'grow' }, h('div', { class: 'res-name', title: it.url }, it.name || it.host), h('div', { class: 'meta num' }, [it.host, fmtSize(it.size)].filter(Boolean).join(' · '))), dl, cp));
  }
  const clear = h('button', { class: 'btn sm ghost' }, '清空');
  clear.addEventListener('click', async (e) => {
    e.preventDefault();
    await send({ type: 'clearSniffed', tabId: tab.id });
    renderResources(tab, slot, hasCard);
  });
  const box = h(
    'details',
    { class: 'card more', open: !hasCard },
    h('summary', {}, icon('chevron'), h('span', { class: 'grow' }, hasCard ? `页面里嗅探到的其他资源（${items.length}）` : `在这个页面发现 ${items.length} 个资源`), clear),
    hasCard ? h('div', { class: 'meta', style: 'margin:2px 0 6px' }, '这些是网页播放时请求到的原始文件，可能只有声音或只是片段。优先用上面的下载按钮。') : null,
    list,
    hint.el
  );
  slot.replaceChildren(box);
}

// =====================================================================
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  if (!/^https?:/.test(tab.url || '')) {
    main.append(h('div', { class: 'card empty-state' }, h('div', { class: 'empty-ic' }, icon('download')), h('b', {}, '这个页面用不了'), h('div', { class: 'meta' }, '打开一个有视频的网页，再点插件图标。')));
    return;
  }
  const slotMedia = h('div', { class: 'slot' });
  const slotBatch = h('div', { class: 'slot' });
  const slotRes = h('div', { class: 'slot' });
  main.append(slotMedia, slotBatch, slotRes);

  const is = (re) => re.test(host);
  let media = null;
  if (is(/(^|\.)bilibili\.com$/)) media = renderBili(tab, slotMedia);
  else if (is(/(^|\.)douyin\.com$/)) media = renderDouyin(tab, slotMedia);
  else if (is(/(^|\.)youtube\.com$/)) media = renderYoutube(tab, slotMedia);
  else if (is(/(^|\.)(xiaohongshu|rednote)\.com$/)) media = renderXhs(tab, slotMedia);
  else if (is(/(^|\.)kuaishou\.com$/)) media = renderHooked(tab, slotMedia, { platform: '快手', extract: kuaishouExtract, referer: 'https://www.kuaishou.com/', emptyHint: '没有找到当前视频。先让视频播放起来，再点一次插件图标。' });
  else if (is(/(^|\.)weibo\.com$/)) media = renderHooked(tab, slotMedia, { platform: '微博', extract: weiboExtract, referer: 'https://weibo.com/', emptyHint: '没有找到当前这条微博。点开这条微博的详情页（或让视频播放起来），再点一次插件图标。' });

  const guard = async (p, slot) => {
    try {
      return await p;
    } catch (e) {
      slot.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'hint err' }, '出错了：' + ((e && e.message) || e))));
      return true;
    }
  };

  if (is(/(^|\.)(douyin|kuaishou|weibo|bilibili|xiaohongshu|rednote)\.com$/)) guard(renderBatchEntry(tab, slotBatch, is(/(^|\.)(douyin|kuaishou|weibo)\.com$/)), slotBatch);
  const hasCard = media ? !!(await guard(media, slotMedia)) : false;
  await guard(renderResources(tab, slotRes, hasCard), slotRes);
})();
