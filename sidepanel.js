// ============================================================
//  Flow Batch — sidepanel.js
//  Điều phối: đọc prompt -> gửi từng cái cho content.js trên
//  tab Flow -> nhận ảnh -> tải về -> nghỉ ngẫu nhiên -> lặp.
// ============================================================

const $ = (id) => document.getElementById(id);
const els = {
  plist: $("plist"),
  count: $("count"),
  addPrompt: $("addPrompt"),
  clearAll: $("clearAll"),
  copyAll: $("copyAll"),
  exportTxt: $("exportTxt"),
  uploadPrompt: $("uploadPrompt"),
  uploadFile: $("uploadFile"),
  modal: $("modal"),
  modalText: $("modalText"),
  modalCount: $("modalCount"),
  modalAdd: $("modalAdd"),
  modalCancel: $("modalCancel"),
  loadTxt: $("loadTxt"),
  txtFile: $("txtFile"),
  editModal: $("editModal"),
  editTitle: $("editTitle"),
  editText: $("editText"),
  editRefs: $("editRefs"),
  addRef: $("addRef"),
  editSave: $("editSave"),
  editCancel: $("editCancel"),
  folder: $("folder"),
  serial: $("serial"),
  delayMin: $("delayMin"),
  delayMax: $("delayMax"),
  start: $("start"),
  restart: $("restart"),
  stop: $("stop"),
  queue: $("queue"),
  progress: $("progress"),
  pfill: $("pfill"),
  conn: $("conn"),
  connText: $("connText"),
};

let running = false;
let items = []; // [{raw, prompt, mediaType, timeRange, fileTimestamp, status}]

const TIME_TOKEN_SRC = "\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d+)?";
const TIMESTAMP_RANGE_RE = new RegExp(
  `\\[\\s*(${TIME_TOKEN_SRC})\\s*[-–—]\\s*(${TIME_TOKEN_SRC})\\s*\\]`,
  "g"
);
const VIDEO_PREFIX_RE = /^\[\s*VIDEO\s*[-–—]\s*Image-to-Video\s*\]\s*/i;
const IMAGE_PREFIX_RE = /^\[\s*IMAGE\s*\]\s*/i;

function sanitizeTimeToken(t) {
  return t.replace(/:/g, "-").replace(/,/g, ".");
}

// Dòng ảnh tham chiếu: [ref 1: tên ảnh trong thư viện Flow]
const REF_LINE_RE = /^\s*\[\s*ref\s*\d*\s*:\s*(.+?)\s*\]\s*$/i;

// Tách các dòng [ref N: ...] ra khỏi nội dung 1 khối prompt
function extractRefs(body) {
  const refs = [];
  const kept = [];
  for (const line of String(body).split(/\r?\n/)) {
    const m = line.match(REF_LINE_RE);
    if (m) refs.push(m[1].trim());
    else kept.push(line);
  }
  return { body: kept.join("\n"), refs };
}

function extractMediaAndPrompt(body, rawFallback) {
  let mediaType = "image";
  let text = body.trim();
  if (VIDEO_PREFIX_RE.test(text)) {
    mediaType = "video";
    text = text.replace(VIDEO_PREFIX_RE, "").trim();
  } else if (IMAGE_PREFIX_RE.test(text)) {
    mediaType = "image";
    text = text.replace(IMAGE_PREFIX_RE, "").trim();
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return {
    mediaType,
    prompt: normalized || rawFallback.replace(/\s+/g, " ").trim(),
  };
}

// ---------- Tách danh sách prompt ----------
// Nếu văn bản có mốc thời gian [MM:SS.s - MM:SS.s] thì chỉ khi gặp mốc thời gian
// mới tính là 1 prompt mới (bỏ qua mọi khoảng trắng / xuống dòng thừa).
// Nếu không có mốc thời gian nào thì giữ cách cũ: mỗi dòng là 1 prompt.
function parsePrompts(text) {
  text = text || "";
  const matches = [...text.matchAll(TIMESTAMP_RANGE_RE)];

  if (matches.length > 0) {
    const result = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const startIdx = m.index;
      const endIdx = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const rawBlock = text.slice(startIdx, endIdx).trim();
      const { body, refs } = extractRefs(text.slice(startIdx + m[0].length, endIdx));
      const startTime = m[1];
      const endTime = m[2];
      const timeRange = `${startTime} - ${endTime}`;
      const fileTimestamp = `${sanitizeTimeToken(startTime)}_${sanitizeTimeToken(endTime)}`;
      const { mediaType, prompt } = extractMediaAndPrompt(body, rawBlock);
      if (!prompt) continue;
      result.push({
        raw: rawBlock,
        prompt,
        mediaType,
        timeRange,
        fileTimestamp,
        refs,
        useRef: refs.length > 0,
      });
    }
    return result;
  }

  // Fallback: không có mốc thời gian -> mỗi dòng là 1 prompt (dòng [ref N: ...] gắn vào prompt trước)
  const out = [];
  for (const line of text.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const rm = line.match(REF_LINE_RE);
    if (rm && out.length) {
      out[out.length - 1].refs.push(rm[1].trim());
      out[out.length - 1].useRef = true;
      continue;
    }
    const { mediaType, prompt } = extractMediaAndPrompt(line, line);
    out.push({
      raw: line,
      prompt,
      mediaType,
      timeRange: "",
      fileTimestamp: "",
      refs: [],
      useRef: false,
    });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Danh sách prompt (kèm ảnh tham chiếu) ----------
let promptList = []; // [{prompt, mediaType, timeRange, fileTimestamp, useRef, refs}]

function splitRefs(s) {
  if (Array.isArray(s)) {
    return s.map((x) => String(x || "").trim()).filter(Boolean);
  }
  return (s || "")
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ---------- Lưu / khôi phục cài đặt ----------
function saveSettings() {
  chrome.storage.local.set({
    promptList,
    folder: els.folder.value,
    serial: els.serial.checked,
    delayMin: els.delayMin.value,
    delayMax: els.delayMax.value,
  });
}
async function loadSettings() {
  const s = await chrome.storage.local.get();
  if (Array.isArray(s.promptList)) {
    promptList = s.promptList;
  } else if (typeof s.prompts === "string" && s.prompts.trim()) {
    // chuyển dữ liệu bản cũ sang danh sách mới
    promptList = parsePrompts(s.prompts);
  }
  if (s.folder) els.folder.value = s.folder;
  if (s.serial != null) els.serial.checked = s.serial;
  if (s.delayMin != null) els.delayMin.value = s.delayMin;
  if (s.delayMax != null) els.delayMax.value = s.delayMax;
  renderPromptList();
}

function renderPromptList() {
  els.count.textContent = `${promptList.length} prompt`;
  els.plist.innerHTML = "";
  if (!promptList.length) {
    els.plist.innerHTML = '<li class="empty">Chưa có prompt. Bấm “➕ Thêm prompt” để dán danh sách.</li>';
    return;
  }
  promptList.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "pitem" + (p.useRef ? " has-ref" : "");
    li.dataset.i = i;
    const kindLabel = p.mediaType === "video" ? "VIDEO" : "IMG";
    const time = p.timeRange ? `<span class="time">${escapeHtml(p.timeRange)}</span>` : "";
    const refs = splitRefs(p.refs);
    li.innerHTML = `
      <div class="pitem__top">
        <input type="checkbox" class="chk" title="Gắn ảnh tham chiếu" ${p.useRef ? "checked" : ""} />
        <span class="num">${i + 1}</span>
        <span class="kind kind--${p.mediaType}">${kindLabel}</span>
        ${time}
        <span class="txt" title="${escapeHtml(p.prompt)}">${escapeHtml(p.prompt)}</span>
        <button class="del" title="Xoá prompt này">✕</button>
      </div>
      ${
        p.useRef && refs.length
          ? `<div class="refline" title="${escapeHtml(refs.join(" · "))}">🖼 (${refs.length}) ${refs.map(escapeHtml).join(" · ")}</div>`
          : ""
      }`;
    els.plist.appendChild(li);
  });
}

// ---------- Đếm prompt ----------
function refreshCount() {
  els.modalCount.textContent = `${parsePrompts(els.modalText.value).length} prompt`;
}

// ---------- Tìm tab Google Flow ----------
async function getFlowTab() {
  // Flow có 2 miền: cũ labs.google/fx/.../tools/flow và mới flow.google.com/project/...
  const tabs = await chrome.tabs.query({
    url: ["https://labs.google/fx/*", "https://flow.google.com/*"],
  });
  return (
    tabs.find((t) => /\/tools\/flow|\/project\//.test(t.url || "")) ||
    tabs[0] ||
    null
  );
}

// ---------- Gửi tin nhắn tới content script ----------
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

// gửi cho background (nơi điều khiển chrome.debugger)
function sendToBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

// ---------- Kiểm tra kết nối ----------
async function checkConnection() {
  const tab = await getFlowTab();
  if (!tab) return setConn(false, "Hãy mở một project Google Flow");

  // thử ping
  let resp = await sendToTab(tab.id, { type: "PING" });

  // không thấy content script -> tự tiêm lại rồi ping lần nữa (tự chữa)
  if (!resp) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, 400));
      resp = await sendToTab(tab.id, { type: "PING" });
    } catch (e) {
      console.warn("[h2dev_flow] Không tiêm được content script:", e);
    }
  }

  if (!resp) return setConn(false, "Tải lại trang Flow (F5) rồi thử lại");
  // PING ok => coi như đã kết nối (lúc chạy bot sẽ focus để ô prompt hiện ra)
  if (resp.hasInput) setConn(true, "Đã kết nối với Google Flow");
  else setConn(true, "Đã kết nối (ô prompt sẽ nhận diện khi chạy)");
  return tab;
}
function setConn(on, text) {
  els.conn.className = "conn " + (on ? "conn--on" : "conn--off");
  els.connText.textContent = text;
}

// ---------- Vẽ hàng đợi ----------
function renderQueue() {
  els.queue.innerHTML = "";
  items.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = "qitem " + it.status;
    const kindLabel = it.mediaType === "video" ? "VIDEO" : "IMG";
    const timeBadge = it.timeRange
      ? `<span class="time">${escapeHtml(it.timeRange)}</span>`
      : "";
    const errLine = it.error
      ? `<div class="qerr" title="${escapeHtml(it.error)}">⚠ ${escapeHtml(it.error)}</div>`
      : "";
    li.innerHTML = `
      <span class="num">${i + 1}</span>
      <span class="kind kind--${it.mediaType}">${kindLabel}</span>
      ${timeBadge}
      <span class="txt">${escapeHtml(it.prompt)}</span>
      <span class="tag ${it.status}">${statusLabel(it.status)}</span>
      ${errLine}`;
    els.queue.appendChild(li);
  });
  const done = items.filter((i) => i.status === "done").length;
  const finished = items.filter((i) =>
    ["done", "error", "timeout"].includes(i.status)
  ).length;
  els.progress.textContent = items.length ? `${done}/${items.length} xong` : "—";
  if (els.pfill) {
    els.pfill.style.width = items.length
      ? Math.round((finished / items.length) * 100) + "%"
      : "0%";
  }
}
function statusLabel(s) {
  return {
    pending: "Chờ",
    generating: "Đang tạo",
    done: "Xong",
    error: "Lỗi",
    timeout: "Quá giờ",
  }[s] || s;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// ---------- Tên file (theo mốc thời gian) ----------
function safeName(s) {
  return s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50)
    .replace(/-+$/, "");
}
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "_" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}
function detectExtension(src, mediaType, mimeType) {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime") || mime.includes("mov")) return "mov";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("png")) return "png";

  const cleanUrl = (src || "").split(/[?#]/)[0].toLowerCase();
  const m = cleanUrl.match(/\.(mp4|webm|mov|png|jpe?g|webp)$/);
  if (m) return m[1] === "jpeg" ? "jpg" : m[1];

  return mediaType === "video" ? "mp4" : "png";
}
function buildFilename(serial, fileTimestamp, ext) {
  const folder = safeName(els.folder.value || "h2dev_flow") || "h2dev_flow";
  const num = els.serial.checked ? String(serial).padStart(3, "0") + "_" : "";
  const ts = fileTimestamp || formatTimestamp(new Date());
  return `${folder}/${num}${ts}.${ext}`;
}

// ---------- Tải ảnh / video ----------
async function downloadMedia(src, serial, item, tabId) {
  let url = src;
  let mimeType = "";
  // blob: thì nhờ content script đổi sang dataURL
  if (!/^https?:/i.test(src)) {
    const r = await sendToTab(tabId, { type: "TODATAURL", src });
    if (r && r.dataUrl) {
      url = r.dataUrl;
      mimeType = r.mimeType || "";
    } else {
      throw new Error(
        item.mediaType === "video"
          ? "Không tải được video blob"
          : "Không tải được ảnh blob"
      );
    }
  }
  const ext = detectExtension(src, item.mediaType, mimeType);
  await chrome.downloads.download({
    url,
    filename: buildFilename(serial, item.fileTimestamp, ext),
    conflictAction: "uniquify",
    saveAs: false,
  });
}

// ---------- Delay ngẫu nhiên ----------
function randDelay() {
  const a = Math.max(0, parseInt(els.delayMin.value) || 0);
  const b = Math.max(a, parseInt(els.delayMax.value) || 0);
  return (a + Math.random() * (b - a)) * 1000;
}

// ---------- Tự chuyển chế độ Ảnh ↔ Video bằng click thật (CDP) ----------
async function ensureFlowMode(tabId, mediaType) {
  const info = await sendToTab(tabId, { type: "GET_MODE_BTN", mediaType });
  if (!info || !info.ok || !info.needSwitch) return true;

  // Click thật vào nút pill (Nano Banana / Video · 720p...) để mở menu
  const openRes = await sendToBg({
    type: "DEBUG_CLICK",
    tabId,
    x: info.x,
    y: info.y,
  });
  if (!openRes || !openRes.ok) return false;
  await sleep(450);

  // Tìm toạ độ tab "Hình ảnh" / "Video" trong menu vừa mở
  let opt = await sendToTab(tabId, { type: "GET_MODE_OPTION", mediaType });
  if (!opt || !opt.ok) {
    await sleep(400);
    opt = await sendToTab(tabId, { type: "GET_MODE_OPTION", mediaType });
  }

  if (opt && opt.ok) {
    await sendToBg({ type: "DEBUG_CLICK", tabId, x: opt.x, y: opt.y });
    await sleep(350);
  } else {
    console.warn("[h2dev_flow] Không tìm thấy tab chọn chế độ:", mediaType);
  }

  // Đóng menu trước khi focus lại ô prompt
  await sendToBg({ type: "DEBUG_ESCAPE", tabId });
  await sleep(250);
  return !!(opt && opt.ok);
}

// ---------- Gắn ảnh tham chiếu từ thư viện Flow (click thật qua CDP) ----------
async function waitUi(tabId, kind, name, tries) {
  for (let t = 0; t < tries; t++) {
    const r = await sendToTab(tabId, { type: "GET_ASSET_UI", kind, name });
    if (r && r.ok) return r;
    await sleep(400);
  }
  return null;
}
const clickAt = (tabId, p) =>
  sendToBg({ type: "DEBUG_CLICK", tabId, x: p.x, y: p.y });

async function attachReferences(tabId, refsText) {
  const names = splitRefs(refsText);
  for (const name of names) {
    if (!running) return { ok: false, error: "Đã dừng" };

    // 1) mở hộp thoại bằng nút "+"
    const plus = await sendToTab(tabId, { type: "GET_REF_BTN" });
    if (!plus || !plus.ok) return { ok: false, error: "Không thấy nút “+” thêm ảnh" };
    const c1 = await clickAt(tabId, plus);
    if (!c1 || !c1.ok) {
      return { ok: false, error: "Lỗi debugger khi bấm “+”: " + (c1?.error || "đóng F12 rồi thử lại") };
    }
    await sleep(800);

    // 2) ô tìm kiếm (nếu chưa thấy thì thử chọn mục "thành phần/thư viện" trong menu)
    let search = await waitUi(tabId, "search", null, 4);
    if (!search) {
      const menu = await waitUi(tabId, "menu", null, 3);
      if (menu) {
        await clickAt(tabId, menu);
        await sleep(800);
        search = await waitUi(tabId, "search", null, 5);
      }
    }
    if (!search) {
      await sendToBg({ type: "DEBUG_ESCAPE", tabId });
      return { ok: false, error: "Không thấy ô “Tìm kiếm thành phần”" };
    }

    // 3) gõ tên ảnh rồi chọn dòng kết quả
    const typed = await sendToBg({ type: "DEBUG_TYPE", tabId, x: search.x, y: search.y, text: name });
    if (!typed || !typed.ok) {
      await sendToBg({ type: "DEBUG_ESCAPE", tabId });
      return { ok: false, error: "Không gõ được tên ảnh: " + (typed?.error || "") };
    }
    await sleep(1100);
    const row = await waitUi(tabId, "row", name, 6);
    if (!row) {
      await sendToBg({ type: "DEBUG_ESCAPE", tabId });
      return { ok: false, error: `Không tìm thấy ảnh “${name}” trong thư viện` };
    }
    await clickAt(tabId, row);
    await sleep(600);

    // 4) bấm "Thêm vào câu lệnh" (nếu hộp thoại tự đóng sau khi click ảnh thì coi như đã gắn)
    const add = await waitUi(tabId, "add", null, 3);
    if (add) {
      await clickAt(tabId, add);
      await sleep(900);
    } else if (await waitUi(tabId, "search", null, 1)) {
      await sendToBg({ type: "DEBUG_ESCAPE", tabId });
      return { ok: false, error: "Không thấy nút “Thêm vào câu lệnh”" };
    }

    // hộp thoại còn mở thì đóng
    if (await waitUi(tabId, "search", null, 1)) {
      await sendToBg({ type: "DEBUG_ESCAPE", tabId });
      await sleep(300);
    }
  }
  return { ok: true };
}

// ---------- Vòng lặp chính ----------
async function run(fresh = false) {
  const tab = await checkConnection();
  if (!tab) return;

  const list = promptList;
  if (list.length === 0) {
    setConn(false, "Chưa có prompt nào");
    return;
  }

  // Tiếp tục từ chỗ dừng nếu hàng đợi cũ còn khớp danh sách prompt và còn mục chưa chạy
  const isOpen = (s) => s === "pending" || s === "generating";
  const canResume =
    !fresh &&
    items.length === list.length &&
    items.length > 0 &&
    items.some((it) => isOpen(it.status)) &&
    items.some((it) => !isOpen(it.status)) &&
    items.every((it, k) => it.prompt === list[k].prompt && it.mediaType === list[k].mediaType);

  if (canResume) {
    items.forEach((it) => {
      if (it.status === "generating") it.status = "pending";
    });
  } else {
    items = list.map((it) => ({ ...it, status: "pending", error: "" }));
  }
  renderQueue();

  running = true;
  els.start.disabled = true;
  els.restart.disabled = true;
  els.stop.disabled = false;

  try {
    // Phiên mới thì khởi tạo bộ nhớ media đã thấy (tránh tải lặp); tiếp tục thì giữ nguyên
    if (!canResume) await sendToTab(tab.id, { type: "RESET_RUN" });

    for (let i = 0; i < items.length; i++) {
      if (!running) break;
      if (!isOpen(items[i].status)) continue; // bỏ qua mục đã xong/lỗi khi tiếp tục

      items[i].status = "generating";
      items[i].error = "";
      renderQueue();

      // 1) tự chuyển chế độ Ảnh/Video (bằng click thật qua debugger) rồi lấy toạ độ ô prompt
      await ensureFlowMode(tab.id, items[i].mediaType);
      if (!running) { items[i].status = "pending"; break; }

      // 1b) gắn ảnh tham chiếu (nếu prompt này được tick)
      if (items[i].useRef && splitRefs(items[i].refs).length) {
        const ref = await attachReferences(tab.id, items[i].refs);
        if (!running) { items[i].status = "pending"; break; }
        if (!ref.ok) {
          items[i].status = "error";
          items[i].error = "Ảnh tham chiếu: " + (ref.error || "lỗi không xác định");
          setConn(false, items[i].error);
          renderQueue();
          continue;
        }
      }

      const box = await sendToTab(tab.id, { type: "GET_BOX" });
      if (!running) { items[i].status = "pending"; break; }
      if (!box || !box.ok) {
        items[i].status = "error";
        items[i].error = (box && box.error) || "Không tìm thấy ô prompt";
        setConn(false, items[i].error);
        renderQueue();
        continue;
      }

      // 2) GÕ CHỮ THẬT + Enter qua background (chrome.debugger)
      const typed = await sendToBg({
        type: "DEBUG_SUBMIT",
        tabId: tab.id,
        x: box.x,
        y: box.y,
        prompt: items[i].prompt,
      });
      if (!running) { items[i].status = "pending"; break; }
      if (!typed || !typed.ok) {
        items[i].status = "error";
        items[i].error =
          typed && typed.error
            ? "Lỗi debugger: " + typed.error + " (đóng DevTools F12 trên tab Flow rồi thử lại)"
            : "Không gõ được (hãy đóng DevTools F12 trên tab Flow)";
        setConn(false, items[i].error);
        renderQueue();
        // không tiếp tục nếu debugger lỗi
        break;
      }

      // 3) chờ ảnh/video mới rồi tải
      const resp = await sendToTab(tab.id, {
        type: "WAIT_MEDIA",
        mediaType: items[i].mediaType,
      });
      if (!running) { items[i].status = "pending"; break; }

      if (resp && resp.ok && resp.src) {
        try {
          await downloadMedia(resp.src, i + 1, items[i], tab.id);
          items[i].status = "done";
        } catch (e) {
          console.warn("Download lỗi:", e);
          items[i].status = "error";
          items[i].error = "Lỗi tải file: " + (e.message || e);
        }
      } else if (resp && resp.timeout) {
        items[i].status = "timeout";
        items[i].error = "Hết thời gian chờ kết quả";
      } else {
        items[i].status = "error";
        items[i].error = (resp && resp.error) || "Không nhận được phản hồi từ tab Flow";
      }
      renderQueue();

      // nghỉ ngẫu nhiên trước prompt kế (trừ prompt cuối)
      if (i < items.length - 1 && running) {
        await sleep(randDelay());
      }
    }
  } finally {
    // xong hàng đợi -> tách debugger để thanh vàng biến mất
    await sendToBg({ type: "DEBUG_DETACH" });
    running = false;
    els.start.disabled = false;
    els.restart.disabled = false;
    els.stop.disabled = true;
    renderQueue();
  }
}

async function stop() {
  running = false;
  els.stop.disabled = true;
  const tab = await getFlowTab();
  if (tab) await sendToTab(tab.id, { type: "STOP" });
  await sendToBg({ type: "DEBUG_DETACH" });
}

// ---------- Sự kiện ----------
// Form thêm prompt
function openModal() {
  els.modalText.value = "";
  refreshCount();
  els.modal.hidden = false;
  els.modalText.focus();
}
function closeModal() {
  els.modal.hidden = true;
}
els.addPrompt.addEventListener("click", openModal);
els.modalCancel.addEventListener("click", closeModal);
els.modalText.addEventListener("input", refreshCount);
els.modalAdd.addEventListener("click", () => {
  const added = parsePrompts(els.modalText.value);
  if (added.length) {
    promptList = promptList.concat(added);
    saveSettings();
    renderPromptList();
  }
  closeModal();
});
// Xuất toàn bộ danh sách prompt ra đúng định dạng có thể dán lại vào form "Thêm prompt"
function promptListToText() {
  return promptList
    .map((p) => {
      const tag = p.mediaType === "video" ? "[VIDEO - Image-to-Video]" : "[IMAGE]";
      const head = p.timeRange ? `[${p.timeRange}] ${tag}` : tag;
      const refLines = p.useRef
        ? splitRefs(p.refs).map((r, k) => `\n[ref ${k + 1}: ${r}]`).join("")
        : "";
      return `${head}\n${p.prompt}${refLines}`;
    })
    .join("\n\n");
}
els.copyAll.addEventListener("click", async () => {
  if (!promptList.length) return;
  const text = promptListToText();
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const old = els.copyAll.textContent;
  els.copyAll.textContent = "✓ Đã chép " + promptList.length;
  setTimeout(() => (els.copyAll.textContent = old), 1500);
});
els.exportTxt.addEventListener("click", () => {
  if (!promptList.length) return;
  const blob = new Blob([promptListToText()], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `prompts_${formatTimestamp()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

els.clearAll.addEventListener("click", () => {
  if (running) return;
  if (promptList.length && !confirm("Xoá toàn bộ danh sách prompt?")) return;
  promptList = [];
  saveSettings();
  renderPromptList();
});

// Tick / sửa / xoá từng prompt (event delegation)
els.plist.addEventListener("change", (e) => {
  const li = e.target.closest(".pitem");
  if (!li || !e.target.classList.contains("chk")) return;
  const i = +li.dataset.i;
  if (e.target.checked) {
    renderPromptList(); // trả ô tick về trạng thái cũ cho tới khi bấm Lưu
    openEdit(i);
  } else {
    promptList[i].useRef = false;
    promptList[i].refs = "";
    saveSettings();
    renderPromptList();
  }
});
els.plist.addEventListener("click", (e) => {
  const li = e.target.closest(".pitem");
  if (!li || running) return;
  const i = +li.dataset.i;
  if (e.target.classList.contains("del")) {
    promptList.splice(i, 1);
    saveSettings();
    renderPromptList();
  } else if (e.target.classList.contains("txt") || e.target.classList.contains("refline")) {
    openEdit(i);
  }
});

// Form sửa prompt + ảnh tham chiếu (không giới hạn số lượng)
let editIndex = -1;

function renumberRefRows() {
  [...els.editRefs.querySelectorAll(".refrow")].forEach((row, idx) => {
    const num = row.querySelector(".num");
    if (num) num.textContent = idx + 1;
    const inp = row.querySelector("input");
    if (inp) {
      inp.placeholder =
        idx === 0
          ? "Tên ảnh trong thư viện Flow, VD: Portrait of young man"
          : `Tên ảnh tham chiếu ${idx + 1}`;
    }
  });
}

function addRefRow(value = "", focus = false) {
  const row = document.createElement("div");
  row.className = "refrow";
  row.innerHTML = `
    <span class="num"></span>
    <input type="text" />
    <button type="button" class="del" title="Xoá ảnh này">✕</button>
  `;
  const input = row.querySelector("input");
  input.value = value;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addRefRow("", true);
    }
  });
  row.querySelector(".del").addEventListener("click", () => {
    if (els.editRefs.querySelectorAll(".refrow").length > 1) {
      row.remove();
      renumberRefRows();
    } else {
      input.value = "";
      input.focus();
    }
  });
  els.editRefs.appendChild(row);
  renumberRefRows();
  if (focus) {
    input.focus();
    row.scrollIntoView({ block: "nearest" });
  }
  return input;
}

function openEdit(i) {
  if (running) return;
  editIndex = i;
  const p = promptList[i];
  const refs = splitRefs(p.refs);
  els.editTitle.textContent = `Prompt #${i + 1}${p.timeRange ? " · " + p.timeRange : ""}`;
  els.editText.value = p.prompt;
  els.editRefs.innerHTML = "";
  let firstInput = null;
  if (refs.length) {
    refs.forEach((r, idx) => {
      const inp = addRefRow(r, false);
      if (idx === 0) firstInput = inp;
    });
  } else {
    firstInput = addRefRow("", false);
  }
  els.editModal.hidden = false;
  (refs.length ? els.editText : firstInput).focus();
}
function closeEdit() {
  els.editModal.hidden = true;
  editIndex = -1;
}
els.addRef.addEventListener("click", () => addRefRow("", true));
els.editCancel.addEventListener("click", closeEdit);
els.editSave.addEventListener("click", () => {
  if (editIndex < 0) return;
  const p = promptList[editIndex];
  const text = els.editText.value.replace(/\s+/g, " ").trim();
  if (text) p.prompt = text;
  const refs = [...els.editRefs.querySelectorAll("input")]
    .map((inp) => inp.value.trim())
    .filter(Boolean);
  p.refs = refs;
  p.useRef = refs.length > 0;
  saveSettings();
  renderPromptList();
  closeEdit();
});
[els.folder, els.serial, els.delayMin, els.delayMax].forEach((el) =>
  el.addEventListener("change", saveSettings)
);
// Upload file .txt đúng định dạng -> tự tách prompt + ảnh tham chiếu và thêm thẳng vào danh sách
els.uploadPrompt.addEventListener("click", () => {
  if (running) return;
  els.uploadFile.click();
});
els.uploadFile.addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const added = parsePrompts(String(reader.result || ""));
    if (!added.length) {
      alert("Không đọc được prompt nào trong file. Kiểm tra lại định dạng [00:00.0 - 00:02.0] [VIDEO - Image-to-Video].");
      return;
    }
    promptList = promptList.concat(added);
    saveSettings();
    renderPromptList();
  };
  reader.readAsText(f);
});
els.loadTxt.addEventListener("click", () => els.txtFile.click());
els.txtFile.addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    els.modalText.value = reader.result;
    refreshCount();
  };
  reader.readAsText(f);
});
els.start.addEventListener("click", () => run(false));
els.restart.addEventListener("click", () => {
  if (running) return;
  if (items.some((it) => it.status === "done") && !confirm("Chạy lại từ prompt đầu tiên? Các file đã tải sẽ được tải lại.")) return;
  run(true);
});
els.stop.addEventListener("click", stop);

// ---------- Khởi động ----------
loadSettings();
checkConnection();
setInterval(checkConnection, 5000); // tự kiểm tra kết nối mỗi 5s
