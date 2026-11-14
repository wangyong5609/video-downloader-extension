// 批量下载页：列出原页面上已经加载过的全部作品，勾选后一个一个下载；也可以导出作品数据表。
// 下载用的函数（runDirect、runImages、saveBlob 等）来自 job.js。

const srcTabId = Number(new URLSearchParams(location.search).get('tab'));
const el = (id) => document.getElementById(id);

let all = []; // 原页面上的全部作品
let owner = ''; // 原页面是博主主页时的博主编号
let pageTitle = '';
let referer = '';
const picked = new Map(); // 作品 id -> 是否勾选
const status = new Map(); // 作品 id -> { cls, text }
let running = false;
let stopFlag = false;
let autoTimer = null;

async function inTab(func, args = []) {
  const r = await chrome.scripting.executeScript({ target: { tabId: srcTabId }, world: 'MAIN', func, args });
  return r && r[0] ? r[0].result : null;
}

let provider = PROVIDERS.hooked;

const safeName = (s, max = 80) =>
  String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/[​-‏‪-‮﻿]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max);

const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
};
const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const num = (v) => (v == null || v === '' ? '' : String(v));

// 发布日期筛选的起止时间（毫秒），没填就是 0
function dateRange() {
  const f = el('dateFrom').value;
  const t = el('dateTo').value;
  return { from: f ? new Date(f + 'T00:00:00').getTime() : 0, to: t ? new Date(t + 'T23:59:59.999').getTime() : 0 };
}

function visible() {
  let list = all;
  if (owner && el('ownerOnly').checked) {
    const mine = all.filter((x) => x.authorId === owner);
    if (mine.length) list = mine;
  }
  const { from, to } = dateRange();
  // 填了日期就只留这段时间内发布的；读不到发布时间的作品不算在内
  if (from || to) list = list.filter((x) => x.time && (!from || x.time >= from) && (!to || x.time <= to));
  return list;
}

const EMPTY_TEXT = el('empty').textContent;
const rowEls = new Map(); // 作品 id -> 这一行的元素（改状态时只动这一行）

function kindOf(it) {
  return it.formats.length ? '视频' : it.images.length ? `图文 ${it.images.length} 张` : it.kind || '';
}

function render() {
  const list = visible();
  const rows = el('rows');
  rows.textContent = '';
  rowEls.clear();
  const showAuthor = !(owner && el('ownerOnly').checked) && new Set(list.map((x) => x.author)).size > 1;
  list.forEach((it, i) => {
    if (!picked.has(it.id)) picked.set(it.id, true);
    const st = status.get(it.id) || { cls: '', text: '' };
    const row = document.createElement('label');
    row.className = 'item ' + st.cls;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = picked.get(it.id);
    cb.addEventListener('change', () => {
      picked.set(it.id, cb.checked);
      summary();
    });
    const mk = (cls, text) => {
      const d = document.createElement('div');
      d.className = cls;
      if (text != null) d.textContent = text;
      return d;
    };
    const thumb = mk('thumb');
    if (it.cover) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = it.cover;
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    const badge = fmtDur(it.duration) || (it.images.length ? `${it.images.length} 图` : it.kind === '图文' ? '图文' : '');
    if (badge) {
      const b = document.createElement('span');
      b.textContent = badge;
      thumb.append(b);
    }
    const body = mk('body');
    const meta = [showAuthor ? it.author : '', num(it.stats.likes) ? '赞 ' + num(it.stats.likes) : '', num(it.stats.comments) ? '评 ' + num(it.stats.comments) : '', fmtTime(it.time).slice(0, 10)].filter(Boolean).join(' · ');
    body.append(mk('t', (it.title || '').split('\n')[0] || it.id), mk('m', meta));
    row.append(cb, mk('n', String(i + 1)), thumb, body, mk('s', st.text));
    rows.append(row);
    rowEls.set(it.id, row);
  });
  el('empty').hidden = list.length > 0;
  el('empty').textContent = all.length && !list.length ? '没有符合筛选条件的作品。换个日期范围，或者先让原页面多加载一些作品。' : EMPTY_TEXT;
  el('dateWrap').hidden = !all.some((x) => x.time); // 这个平台的列表里有发布时间才显示日期筛选
  summary();
}

function summary() {
  const list = visible();
  const n = list.filter((x) => picked.get(x.id)).length;
  el('summary').textContent = `已加载 ${list.length} 个，勾选 ${n} 个`;
  el('all').checked = list.length > 0 && n === list.length;
}

const known = new Map(); // 作品 id -> 已经查到的补充数据（刷新列表时不丢）

async function refresh() {
  const r = await inTab(provider.list);
  if (!r) {
    el('summary').textContent = '读不到原页面的数据。请回到原页面刷新一下，再重新打开批量下载。';
    return;
  }
  all = r.items.map((it) => Object.assign(it, known.get(it.id) || {}));
  owner = r.owner;
  pageTitle = r.title;
  el('pageTitle').textContent = r.title;
  el('ownerWrap').hidden = !(owner && all.some((x) => x.authorId === owner));
  render();
  fillInfo();
}

// B站：列表先出来，标题、作者、数据随后一小批一小批补上
let filling = false;
async function fillInfo() {
  if (!provider.info || filling) return;
  filling = true;
  try {
    for (;;) {
      const todo = all.filter((x) => x.needInfo && !known.has(x.id)).slice(0, 8);
      if (!todo.length) break;
      const got = (await inTab(provider.info, [todo.map((x) => x.id)])) || {};
      for (const it of todo) {
        const extra = Object.assign({ needInfo: false }, got[it.id] || {});
        known.set(it.id, extra);
        Object.assign(it, extra);
      }
      el('ownerWrap').hidden = !(owner && all.some((x) => x.authorId === owner));
      render();
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch {}
  filling = false;
}

function setStatus(id, cls, text) {
  status.set(id, { cls, text });
  const row = rowEls.get(id);
  if (!row) return render();
  row.className = 'item ' + cls;
  row.querySelector('.s').textContent = text;
  if (cls === 'run') row.scrollIntoView({ block: 'nearest' });
}

// 下载一个作品的封面，存成“标题_封面.jpg”
async function saveCover(it, name) {
  if (!it.cover) throw new Error('没有读到这个作品的封面');
  const data = await withRetry(() => fetchBytes(it.cover));
  let ext = imageExt(data);
  let blob = new Blob([data], { type: IMAGE_MIME[ext] });
  if (ext !== '.jpg' && ext !== '.gif') {
    try {
      blob = await toJpeg(data, ext);
      ext = '.jpg';
    } catch {}
  }
  await saveBlob(blob, `${name}_封面${ext}`);
}

async function start() {
  if (running) return;
  const todo = visible().filter((x) => picked.get(x.id) && (status.get(x.id) || {}).cls !== 'done');
  if (!todo.length) return;
  running = true;
  stopFlag = false;
  el('start').hidden = true;
  el('stop').hidden = false;
  const pref = el('quality').value;
  const content = el('content').value; // media / both / cover
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < todo.length && !stopFlag; i++) {
    const it = todo[i];
    setStatus(it.id, 'run', '下载中…');
    const folder = safeName(it.author, 40) || '批量下载';
    const name = `${folder}/${safeName((it.title || '').split('\n')[0]) || it.id}`;
    ui.title(`(${i + 1}/${todo.length}) ${name}`);
    ui.progress(0, '');
    try {
      let note = '';
      let audioUrls = [];
      const needMedia = content !== 'cover';
      if (it.lazy && provider.resolve && (needMedia || !it.cover)) {
        ui.status('正在获取下载地址…');
        const r = await inTab(provider.resolve, [it]);
        if (!r || r.error) throw new Error((r && r.error) || '获取下载地址失败');
        it.formats = r.formats || [];
        it.images = r.images || [];
        audioUrls = r.audioUrls || [];
        if (r.extra) {
          known.set(it.id, Object.assign(known.get(it.id) || {}, r.extra));
          Object.assign(it, r.extra);
        }
        if (needMedia && !it.formats.length && !it.images.length) throw new Error('没有找到可下载的内容');
      }
      if (needMedia && it.formats.length) {
        const f = pickFormat(it.formats, pref);
        if (audioUrls.length) await runMerge({ videoUrls: f.urls, audioUrls, filename: name });
        else await runDirect({ urls: f.urls, ext: '.mp4', filename: name });
        note = f.res ? f.res + 'P' : '';
      }
      if (needMedia && it.images.length) {
        const items = [];
        for (const img of it.images) {
          items.push({ url: img.url });
          if (img.liveUrl) items.push({ url: img.liveUrl, video: true });
        }
        await runImages({ items, toJpg: true, filename: name });
        note = `${it.images.length} 张图`;
      }
      if (content !== 'media') {
        ui.status('正在下载封面…');
        if (content === 'cover') {
          await saveCover(it, name);
          note = '封面';
        } else {
          try {
            await saveCover(it, name);
            note += ' + 封面';
          } catch {
            note += '（封面没下到）';
          }
        }
      }
      if (it.lazy) it.formats = [];
      ok++;
      setStatus(it.id, 'done', '完成 ' + note);
    } catch (e) {
      fail++;
      setStatus(it.id, 'fail', '失败：' + ((e && e.message) || e));
    }
    await new Promise((r) => setTimeout(r, provider.gap)); // 一个一个来，中间歇一下，别给平台造成压力
  }
  running = false;
  el('start').hidden = false;
  el('stop').hidden = true;
  ui.title('');
  ui.progress(1, '');
  ui.status(`${stopFlag ? '已停止。' : '全部处理完。'}成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}，文件在“下载”文件夹里按作者分文件夹存放。`, fail ? 'err' : 'ok');
}

async function exportCsv() {
  const list = visible().filter((x) => picked.get(x.id));
  if (!list.length) return;
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const head = ['序号', '标题/文案', '作者', '类型', '发布时间', '时长(秒)', '点赞', '评论', '收藏', '分享', '播放', '链接'];
  const lines = [head.map(esc).join(',')];
  list.forEach((it, i) => {
    lines.push(
      [i + 1, (it.title || '').replace(/\r?\n/g, ' '), it.author, it.formats.length ? '视频' : it.images.length ? '图文' : it.kind || '', fmtTime(it.time), it.duration ? Math.round(it.duration / 1000) : '', it.stats.likes, it.stats.comments, it.stats.collects, it.stats.shares, it.stats.plays, it.url]
        .map(esc)
        .join(',')
    );
  });
  // 开头加 BOM，Excel 打开中文才不会乱码
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  const name = `${safeName(pageTitle, 50) || '作品'}_作品数据表.csv`;
  await saveBlob(blob, name);
  ui.status(`数据表已保存到“下载”文件夹：${name}（${list.length} 条）`, 'ok');
}

function toggleAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    el('auto').classList.remove('on');
    el('auto').textContent = '自动往下翻页';
    return;
  }
  el('auto').classList.add('on');
  el('auto').textContent = '停止翻页';
  const tick = async () => {
    try {
      // 让原页面滚到底，触发它加载下一批作品
      await inTab(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        let best = null;
        let max = 0;
        for (const e of document.querySelectorAll('div,main,section,ul')) {
          if (e.clientHeight > 300 && e.scrollHeight - e.clientHeight > 300 && e.scrollHeight > max) {
            const oy = getComputedStyle(e).overflowY;
            if (oy === 'auto' || oy === 'scroll') {
              best = e;
              max = e.scrollHeight;
            }
          }
        }
        if (best) best.scrollTop = best.scrollHeight;
      });
      if (!running) await refresh();
    } catch {}
  };
  tick();
  autoTimer = setInterval(tick, 2500);
}

el('refresh').addEventListener('click', refresh);
el('start').addEventListener('click', () => start());
for (const id of ['dateFrom', 'dateTo']) el(id).addEventListener('change', render);
el('dateClear').addEventListener('click', () => {
  el('dateFrom').value = '';
  el('dateTo').value = '';
  render();
});
el('stop').addEventListener('click', () => {
  stopFlag = true;
  el('stop').disabled = true;
  setTimeout(() => (el('stop').disabled = false), 1500);
});
el('csv').addEventListener('click', exportCsv);
el('auto').addEventListener('click', toggleAuto);
el('ownerOnly').addEventListener('change', render);
el('content').addEventListener('change', () => {
  if (running) return;
  status.clear(); // 换了要下的内容，之前标“完成”的可以重新下
  render();
});
const EMBED = new URLSearchParams(location.search).get('embed') === '1'; // 嵌在网页右侧的面板里
if (EMBED) {
  el('close').hidden = false;
  el('close').addEventListener('click', () => window.parent.postMessage({ vdl: 'close' }, '*'));
}
el('all').addEventListener('change', () => {
  for (const it of visible()) picked.set(it.id, el('all').checked);
  render();
});

(async () => {
  try {
    const tab = await chrome.tabs.get(srcTabId);
    referer = new URL(tab.url).origin + '/';
    const host = new URL(tab.url).hostname;
    if (/(^|\.)bilibili\.com$/.test(host)) provider = PROVIDERS.bili;
    else if (/(^|\.)(xiaohongshu|rednote)\.com$/.test(host)) provider = PROVIDERS.xhs;
    await send({ type: 'setReferer', referer }); // 让这个页面发出的下载请求带上原网站的来源
  } catch {}
  await refresh();
})();
