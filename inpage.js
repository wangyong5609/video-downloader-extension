// 注入到抖音、B站、小红书、快手、微博页面里的界面：
//   1. 鼠标移到某个视频 / 作品上，右上角出现下载按钮，点一下就下载这一个
//   2. 页面右下角有“批量下载”按钮，点开后从右侧滑出面板（面板内容是 batch.html）
// 所有元素都放在 Shadow DOM 里，不受网页样式影响，也不影响网页。
(() => {
  if (window.top !== window || window.__vdlInpage) return;
  window.__vdlInpage = true;

  const host = location.hostname;
  const SITE = /(^|\.)douyin\.com$/.test(host)
    ? { key: 'douyin', re: /\/(?:video|note)\/(\d{8,})/ }
    : /(^|\.)bilibili\.com$/.test(host)
      ? { key: 'bili', re: /\/video\/(BV[0-9A-Za-z]+)/, subtitle: true } // 只有 B站 有平台自带的字幕
      : /(^|\.)(xiaohongshu|rednote)\.com$/.test(host)
        ? { key: 'xhs', re: /\/(?:explore|search_result|discovery\/item|user\/profile\/[0-9a-f]+)\/([0-9a-f]{24})/ }
        : /(^|\.)kuaishou\.com$/.test(host)
          ? { key: 'kuaishou', re: /\/short-video\/([0-9A-Za-z_-]+)/ }
          : /(^|\.)weibo\.com$/.test(host)
            ? { key: 'weibo', re: /weibo\.com\/\d+\/([A-Za-z0-9]{9})(?:[/?#]|$)/ }
            : null;
  if (!SITE) return;

  const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const TEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M5 12h14M5 17h9"/></svg>';
  const LAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l8 4.5-8 4.5-8-4.5L12 4z"/><path d="M4 13l8 4.5 8-4.5"/></svg>';

  const hostEl = document.createElement('div');
  hostEl.id = 'vdl-inpage';
  hostEl.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = hostEl.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
      [hidden] { display: none !important; }
      .dl {
        position: fixed; width: 38px; height: 38px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
        display: flex; align-items: center; justify-content: center; color: #fff;
        background: linear-gradient(180deg, #ff7a3d, #ff4a1c);
        box-shadow: 0 2px 10px rgba(0, 0, 0, .35), 0 0 0 2px rgba(255, 255, 255, .9);
        transition: transform .12s, opacity .12s;
      }
      .dl:hover { transform: scale(1.08); }
      .dl svg { width: 20px; height: 20px; }
      .dl.busy { pointer-events: none; }
      .dl.busy svg { animation: bob .7s ease-in-out infinite alternate; }
      .dl.done { background: #16a34a; }
      .dl.sub { background: #fff; color: #17171a; box-shadow: 0 2px 10px rgba(0, 0, 0, .35); }
      .dl.sub.done { background: #16a34a; color: #fff; }
      @keyframes bob { from { transform: translateY(-2px); } to { transform: translateY(3px); } }
      .tip {
        position: fixed; padding: 4px 8px; border-radius: 6px; background: rgba(23, 23, 26, .92); color: #fff;
        font-size: 12px; line-height: 1.4; white-space: nowrap; pointer-events: none;
      }
      .fab {
        position: fixed; right: 22px; bottom: 92px; height: 42px; padding: 0 16px 0 12px; border-radius: 21px; border: 0; cursor: pointer;
        display: flex; align-items: center; gap: 7px; color: #fff; font-size: 14px; font-weight: 650;
        background: #17171a; box-shadow: 0 6px 22px rgba(0, 0, 0, .3), 0 0 0 1px rgba(255, 255, 255, .14);
        transition: transform .12s;
      }
      .fab:hover { transform: translateY(-1px); }
      .fab .ic { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(180deg, #ff7a3d, #ff4a1c); }
      .fab svg { width: 15px; height: 15px; }
      .fab .x { margin-left: 2px; width: 18px; height: 18px; border-radius: 50%; display: none; align-items: center; justify-content: center; font-size: 14px; line-height: 1; color: #a1a1aa; }
      .fab:hover .x { display: flex; }
      .fab .x:hover { background: rgba(255, 255, 255, .16); color: #fff; }
      .toast {
        position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); max-width: min(560px, 86vw);
        padding: 11px 16px; border-radius: 12px; background: #17171a; color: #fff; font-size: 13px; line-height: 1.5;
        box-shadow: 0 8px 28px rgba(0, 0, 0, .35); display: flex; align-items: center; gap: 9px;
      }
      .toast b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .toast .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #4ade80; }
      .toast.err .dot { background: #f87171; }
      .drawer {
        position: fixed; top: 0; right: 0; bottom: 0; width: min(620px, 100vw); background: #f6f6f7;
        box-shadow: -12px 0 40px rgba(0, 0, 0, .28); animation: slide .18s ease-out;
      }
      @keyframes slide { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }
      .drawer iframe { width: 100%; height: 100%; border: 0; display: block; }
    </style>
    <button class="dl" hidden aria-label="下载这个视频">${ARROW}</button>
    <button class="dl sub" hidden aria-label="下载字幕">${TEXT}</button>
    <div class="tip" hidden></div>
    <button class="fab"><span class="ic">${LAYERS}</span>批量下载<span class="x" title="这次先收起">×</span></button>
    <div class="toast" hidden><span class="dot"></span><b></b></div>
    <div class="drawer" hidden></div>
  `;
  (document.body || document.documentElement).appendChild(hostEl);

  const $ = (sel) => root.querySelector(sel);
  const dl = $('.dl');
  const sub = $('.dl.sub');
  const tip = $('.tip');
  const fab = $('.fab');
  const toastEl = $('.toast');
  const drawer = $('.drawer');

  // ---------- 和后台通信（插件被重新加载后，旧页面要刷新才能继续用）----------
  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return { error: '插件刚更新过，请刷新一下这个页面。' };
    }
  }

  let toastTimer = 0;
  function toast(text, isErr) {
    toastEl.className = 'toast' + (isErr ? ' err' : '');
    toastEl.querySelector('b').textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), isErr ? 6000 : 3500);
  }

  // ---------- 找出鼠标下面的作品 ----------
  // 作品卡片：一个指向作品的链接，外面包着封面
  function cardBox(a) {
    let box = a;
    for (let i = 0; i < 4 && box; i++) {
      const r = box.getBoundingClientRect();
      if (r.width >= 110 && r.height >= 80 && r.width <= 760 && r.height <= 960 && box.querySelector('img, video, picture, canvas')) return box;
      box = box.parentElement;
    }
    return null;
  }

  function fromPlayer(x, y) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 240 || r.height < 135 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      let id = '';
      let url = location.href;
      if (SITE.key === 'douyin') {
        const box = v.closest('[data-e2e-vid]');
        id = (box && box.getAttribute('data-e2e-vid')) || '';
        if (!id) id = new URLSearchParams(location.search).get('modal_id') || '';
      }
      if (!id) {
        const m = location.href.match(SITE.re);
        if (m) id = m[1];
      }
      if (id) return { el: v, id, url };
    }
    return null;
  }

  function findTarget(x, y) {
    const els = document.elementsFromPoint(x, y);
    if (els[0] === hostEl) return 'self';
    for (const el of els.slice(0, 8)) {
      const a = el.closest ? el.closest('a[href]') : null;
      if (!a) continue;
      const m = a.href.match(SITE.re);
      if (!m) continue;
      const box = cardBox(a);
      if (box) return { el: box, id: m[1], url: a.href };
    }
    return fromPlayer(x, y);
  }

  // ---------- 悬停时显示下载按钮 ----------
  let current = null;
  let hideTimer = 0;
  let busy = false;

  let tipLeft = 0;
  let tipTop = 0;
  function showTip(text, row) {
    tip.textContent = text;
    tip.hidden = false;
    tip.style.top = tipTop + 7 + row * 46 + 'px';
    tip.style.left = Math.max(tipLeft - tip.offsetWidth - 8, 4) + 'px';
  }

  function place(t) {
    const r = t.el.getBoundingClientRect();
    const left = Math.min(Math.max(r.right - 48, 4), innerWidth - 42);
    const top = Math.min(Math.max(r.top + 10, 4), innerHeight - 42);
    dl.style.left = left + 'px';
    dl.style.top = top + 'px';
    sub.style.left = left + 'px';
    sub.style.top = Math.min(top + 46, innerHeight - 42) + 'px';
    tipLeft = left;
    tipTop = top;
  }

  function show(t) {
    clearTimeout(hideTimer);
    if (!current || current.id !== t.id || current.el !== t.el) {
      if (busy) return; // 上一个还在处理，按钮先不挪走
      current = t;
      dl.className = 'dl';
      dl.innerHTML = ARROW;
      sub.className = 'dl sub';
      sub.innerHTML = TEXT;
    }
    place(current);
    dl.hidden = false;
    sub.hidden = !SITE.subtitle;
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (busy) return;
      dl.hidden = true;
      sub.hidden = true;
      tip.hidden = true;
      current = null;
    }, 220);
  }

  let last = 0;
  document.addEventListener(
    'mousemove',
    (e) => {
      const now = Date.now();
      if (now - last < 70) return;
      last = now;
      if (!drawer.hidden && e.clientX > innerWidth - drawer.offsetWidth) return;
      const t = findTarget(e.clientX, e.clientY);
      if (t === 'self') return clearTimeout(hideTimer);
      if (t) show(t);
      else hideSoon();
    },
    { passive: true, capture: true }
  );
  document.addEventListener('scroll', () => !busy && ((dl.hidden = true), (sub.hidden = true), (tip.hidden = true), (current = null)), { passive: true, capture: true });

  dl.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    if (!busy) showTip('下载这个视频', 0);
  });
  sub.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    if (!busy) showTip('下载字幕', 1);
  });
  sub.addEventListener('mouseleave', () => {
    tip.hidden = true;
    hideSoon();
  });
  sub.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!current || busy) return;
    const t = current;
    busy = true;
    tip.hidden = true;
    sub.classList.add('busy');
    const r = (await send({ type: 'quickSubtitle', site: SITE.key, id: t.id, url: t.url })) || {};
    sub.classList.remove('busy');
    busy = false;
    if (!r.ok) return toast(r.error || '没有取到字幕', true);
    if (r.kind !== 'srt') return toast('这个视频没有字幕。', true);
    sub.classList.add('done');
    sub.innerHTML = CHECK;
    toast(`字幕已保存到“下载”文件夹（${r.lang ? r.lang + '，' : ''}${r.count} 句）：${r.title}`);
    setTimeout(hideSoon, 1200);
  });
  dl.addEventListener('mouseleave', () => {
    tip.hidden = true;
    hideSoon();
  });
  dl.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!current || busy) return;
    const t = current;
    busy = true;
    tip.hidden = true;
    dl.classList.add('busy');
    const r = (await send({ type: 'quickDownload', site: SITE.key, id: t.id, url: t.url })) || {};
    dl.classList.remove('busy');
    busy = false;
    if (r.ok) {
      dl.classList.add('done');
      dl.innerHTML = CHECK;
      toast(`已开始下载：${r.title}${r.note ? '（' + r.note + '）' : ''}`);
      setTimeout(hideSoon, 1200);
    } else {
      toast(r.error || '下载失败', true);
    }
  });

  // ---------- 批量下载：右下角按钮 + 右侧面板 ----------
  async function openDrawer() {
    if (!drawer.firstChild) {
      const who = await send({ type: 'whoami' });
      if (!who || who.error || who.tabId == null || who.tabId < 0) return toast((who && who.error) || '打不开批量面板', true);
      const frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL(`batch.html?tab=${who.tabId}&embed=1`);
      frame.allow = 'clipboard-write';
      drawer.appendChild(frame);
    }
    drawer.hidden = false;
    fab.hidden = true;
    dl.hidden = true;
    sub.hidden = true;
  }
  function closeDrawer() {
    drawer.hidden = true;
    fab.hidden = false;
  }
  fab.addEventListener('click', (e) => {
    if (e.target.classList.contains('x')) {
      fab.hidden = true; // 只收起到下次刷新页面
      return;
    }
    openDrawer();
  });
  window.addEventListener('message', (e) => {
    const frame = drawer.firstChild;
    if (frame && e.source === frame.contentWindow && e.data && e.data.vdl === 'close') closeDrawer();
  });
  // 弹窗里的“批量下载”也走这里
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'openDrawer') openDrawer();
  });

  // 全屏看视频时不打扰
  document.addEventListener('fullscreenchange', () => {
    hostEl.style.display = document.fullscreenElement ? 'none' : '';
  });
})();
