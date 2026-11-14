// 后台隐藏页面：接收下载任务，一个一个执行，不打开任何标签页。
// 真正干活的函数（runDirect / runMerge / runHls / runImages）在 job.js 里。
// 这里拿不到 chrome.downloads，存盘由后台代办（见 job.js 的 saveBlob）。

const queue = [];
let busy = false;
let cur = null; // 正在执行的任务
let state = { ratio: 0, status: '', detail: '' };
let lastSent = 0;

const tell = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// 把进度告诉后台，后台再转给发起下载的那个网页。不用每一小步都发，隔一会儿发一次就够
function report(force) {
  if (!cur) return;
  const now = Date.now();
  if (!force && now - lastSent < 350) return;
  lastSent = now;
  tell({ type: 'jobProgress', id: cur.id, tabId: cur.fromTabId, title: cur.filename, ratio: state.ratio, status: state.status, detail: state.detail, waiting: queue.length });
}

// job.js 往界面上写进度的地方，顺便汇报一份
const rawStatus = ui.status;
const rawProgress = ui.progress;
ui.status = (t, cls) => {
  rawStatus(t, cls);
  state.status = t;
  report(true);
};
ui.progress = (ratio, detail) => {
  rawProgress(ratio, detail);
  if (ratio != null) state.ratio = ratio;
  if (detail != null) state.detail = detail;
  report(false);
};

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    cur = queue.shift();
    state = { ratio: 0, status: '准备下载…', detail: '' };
    ffmpegLog = [];
    report(true);
    try {
      // 一次只跑一个任务，所以“来源”规则同一时间只有一条
      await chrome.runtime.sendMessage({ type: 'jobReferer', referer: cur.referer || '' });
      let saved;
      if (cur.kind === 'merge') saved = await runMerge(cur);
      else if (cur.kind === 'hls') saved = await runHls(cur);
      else if (cur.kind === 'images') saved = await runImages(cur);
      else saved = await runDirect(cur);
      tell({ type: 'jobDone', id: cur.id, tabId: cur.fromTabId, ok: true, title: cur.filename, saved });
    } catch (e) {
      tell({ type: 'jobDone', id: cur.id, tabId: cur.fromTabId, ok: false, title: cur.filename, error: String((e && e.message) || e) });
    }
  }
  cur = null;
  busy = false;
  tell({ type: 'jobReferer', referer: '' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'runJob') {
    queue.push(msg.job);
    sendResponse({ ok: true, ahead: queue.length - 1 + (busy ? 1 : 0) });
    pump();
  }
});
