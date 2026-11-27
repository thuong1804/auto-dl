// ============================================================
//  Flow Batch — content.js
//  Đây là "con bot" được tiêm thẳng vào trang Google Flow.
//  Nó tìm ô prompt, gõ chữ, bấm Generate, canh ảnh xong, rồi
//  trả ảnh về cho side panel để tải xuống.
//
//  >>> NẾU GOOGLE ĐỔI GIAO DIỆN VÀ TOOL HỎNG <<<
//  Bạn chỉ cần sửa phần CONFIG ngay bên dưới. Mở Google Flow,
//  bấm F12 -> chọn ô prompt / nút generate -> copy CSS selector
//  rồi dán vào promptSelector / generateSelector.
// ============================================================

const CONFIG = {
  // Để trống ("") thì tool TỰ DÒ. Nếu tự dò sai, điền selector vào đây.
  promptSelector: "",        // vd: 'textarea[placeholder*="create"]'
  generateSelector: "",      // vd: 'button[aria-label="Generate"]'
  modeButtonSelector: "",    // vd: nút chọn Ảnh / Video trên thanh prompt

  // Cách submit: Flow này submit bằng phím ENTER nên để true (mặc định).
  // Nếu Flow của bạn cần click nút thì đổi false.
  submitWithEnter: true,

  // Ảnh / video kết quả thường to; bỏ qua icon/avatar nhỏ hơn ngưỡng này (pixel)
  minImageSize: 256,
  minVideoSize: 80,

  // Canh ảnh/video: kiểm tra mỗi pollMs mili-giây, tối đa chờ maxWaitMs / maxWaitVideoMs
  pollMs: 2000,
  maxWaitMs: 240000,         // 4 phút / 1 ảnh (chỉnh nếu model chậm hơn)
  maxWaitVideoMs: 360000,    // 6 phút / 1 video

  // Thời gian tối thiểu sau khi gửi prompt mới bắt đầu nhận kết quả (tránh bắt nhầm thẻ cũ khi lưới dịch chuyển)
  minGenerateImageMs: 3000,
  minGenerateVideoMs: 8000,

  // Chờ thêm sau khi thấy ảnh/video mới, để load đầy đủ trước khi tải
  settleMs: 1800,
};

let STOP = false;

// ---------- Tiện ích nhỏ ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

function area(el) {
  const r = el.getBoundingClientRect();
  return r.width * r.height;
}

function srcKey(img) {
  return img.currentSrc || img.src || "";
}

// Chuẩn hoá URL để nhận diện trùng lặp ngay cả khi Google đổi chữ ký (Signature/Expires/token)
const VOLATILE_QUERY_PARAMS = new Set([
  "expires",
  "signature",
  "googleaccessid",
  "x-goog-algorithm",
  "x-goog-credential",
  "x-goog-date",
  "x-goog-expires",
  "x-goog-signedheaders",
  "x-goog-signature",
  "token",
  "authuser",
]);

function mediaKey(url) {
  if (!url) return "";
  if (url.startsWith("blob:") || url.startsWith("data:")) return url;
  try {
    const u = new URL(url, location.href);
    for (const k of [...u.searchParams.keys()]) {
      if (VOLATILE_QUERY_PARAMS.has(k.toLowerCase())) {
        u.searchParams.delete(k);
      }
    }
    return u.origin + u.pathname + (u.search ? u.search : "");
  } catch (_) {
    return url;
  }
}

function getSeenImages() {
  if (!window.__h2dev_flow_seen_images) {
    window.__h2dev_flow_seen_images = new Set();
  }
  return window.__h2dev_flow_seen_images;
}

function getSeenVideos() {
  if (!window.__h2dev_flow_seen_videos) {
    window.__h2dev_flow_seen_videos = new Set();
  }
  return window.__h2dev_flow_seen_videos;
}

function markSeen(set, url) {
  if (!url) return;
  set.add(url);
  const norm = mediaKey(url);
  if (norm) set.add(norm);
}

function isSeen(set, url) {
  if (!url) return true;
  if (set.has(url)) return true;
  const norm = mediaKey(url);
  return norm ? set.has(norm) : false;
}

function videoSrcKey(video) {
  if (!video) return "";
  const direct = video.currentSrc || video.src || "";
  if (direct) return direct;
  const attr = video.getAttribute("src");
  if (attr) {
    try {
      return new URL(attr, location.href).href;
    } catch (_) {
      return attr;
    }
  }
  const source = video.querySelector("source[src]");
  if (source) return source.src || source.getAttribute("src") || "";
  return "";
}

// Video trong lưới Google Flow đôi khi có opacity: 0 cho tới khi di chuột vào
function isVideoPresent(video) {
  if (!video) return false;
  const s = getComputedStyle(video);
  if (s.display === "none" || s.visibility === "hidden") return false;
  const r = video.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) || (video.videoWidth > 0 && video.videoHeight > 0);
}

// ---------- 1. Tìm ô nhập prompt ----------
// kiểm tra "đang hiện" kiểu lỏng hơn (Slate khi trống vẫn có client rect)
function isShown(el) {
  if (!el) return false;
  if (isVisible(el)) return true;
  return el.getClientRects().length > 0; // dự phòng
}

function findPromptInput() {
  if (CONFIG.promptSelector) {
    const e = document.querySelector(CONFIG.promptSelector);
    if (e) return e;
  }
  // Thử lần lượt các "địa chỉ" ổn định của ô prompt Flow (Slate.js)
  const selectors = [
    '[data-slate-editor="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][aria-multiline="true"]',
    'div[role="textbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    "textarea",
  ];
  for (const sel of selectors) {
    const all = [...document.querySelectorAll(sel)];
    if (!all.length) continue;
    const shown = all.filter(isShown);
    const list = shown.length ? shown : all; // ưu tiên cái đang hiện, không thì lấy đại
    const hint = /create|prompt|imagine|describe|tạo|生成|描述|생성|作成/i;
    const byText = list.find((e) =>
      hint.test(
        (e.getAttribute("placeholder") || "") +
          (e.getAttribute("aria-label") || "") +
          (e.dataset?.placeholder || "")
      )
    );
    if (byText) return byText;
    list.sort((a, b) => area(b) - area(a));
    return list[0];
  }
  return null;
}

// Đánh thức ô prompt: Slate chỉ "mọc" editor khi vùng prompt được click.
// Hàm này click vào vùng prompt (cạnh trái nút mũi tên) để editor xuất hiện.
async function wakePromptBox() {
  let ed = findPromptInput();
  if (ed) {
    clickFully(ed);
    ed.focus?.();
    await sleep(150);
    return findPromptInput();
  }
  // editor chưa mount -> click vào vùng ô prompt cạnh nút arrow_forward
  const arrow = [...document.querySelectorAll('button, [role="button"]')].find(
    (b) => /arrow_forward/i.test((b.getAttribute("aria-label") || "") + b.textContent)
  );
  if (arrow) {
    const r = arrow.getBoundingClientRect();
    const points = [
      [r.left - 150, r.top + r.height / 2],
      [r.left - 300, r.top + r.height / 2],
      [r.left - 80, r.top + r.height / 2],
    ];
    for (const [x, y] of points) {
      const t = document.elementFromPoint(x, y);
      if (!t) continue;
      ["mousedown", "mouseup", "click"].forEach((type) =>
        t.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
          })
        )
      );
      t.focus?.();
      await sleep(250);
      ed = findPromptInput();
      if (ed) {
        console.log("[h2dev_flow] ✓ Đánh thức được ô prompt bằng cú click.");
        return ed;
      }
    }
  }
  return findPromptInput();
}

// ---------- 2. Gõ prompt vào ô (xử lý cả React) ----------
function setNativeValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Đọc text THẬT của Slate (bỏ qua placeholder)
function slateText(el) {
  return [...el.querySelectorAll("[data-slate-string]")]
    .map((s) => s.textContent)
    .join("");
}
// Ô Slate có đang trống không (placeholder còn hiện = trống)
function slateEmpty(el) {
  return !!el.querySelector("[data-slate-placeholder]") || slateText(el).trim().length === 0;
}

// Đặt con trỏ vào giữa ô (Slate cần selection mới chèn được)
function focusEditor(el) {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  ["mousedown", "mouseup", "click"].forEach((t) => {
    (document.elementFromPoint(x, y) || el).dispatchEvent(
      new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
    );
  });
  el.focus();
}

// CHÈN CHỮ VÀO SLATE — dùng beforeinput insertText (đã test: Slate nhận cách này)
function slateInsert(el, text) {
  focusEditor(el);
  if (!slateEmpty(el)) {
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
    } catch (_) {}
  }
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
}

function setPromptText(el, text) {
  if (el.isContentEditable) {
    slateInsert(el, text);
    return;
  }
  const proto =
    el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(
    new InputEvent("input", { bubbles: true, composed: true, data: text, inputType: "insertText" })
  );
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// đọc nội dung hiện có trong ô prompt (Slate: đọc text thật, bỏ qua placeholder)
function inputText(el) {
  if (el.isContentEditable) {
    if (el.querySelector("[data-slate-string], [data-slate-placeholder]")) {
      return slateText(el);
    }
    return el.innerText || el.textContent || "";
  }
  return el.value || "";
}
function isBtnDisabled(b) {
  return b.disabled || b.getAttribute("aria-disabled") === "true";
}

// ---------- 3. Tìm & bấm nút Generate ----------
function findGenerateButton(input) {
  if (CONFIG.generateSelector) {
    const e = document.querySelector(CONFIG.generateSelector);
    if (e) return e;
  }
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (b) => isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true"
  );

  const label = (b) =>
    (
      (b.getAttribute("aria-label") || "") +
      " " +
      (b.title || "") +
      " " +
      b.textContent
    ).toLowerCase();

  // Nút KHÔNG được nhầm: tác nhân/agent, chọn model, xoá, đóng, thùng rác...
  const bad = /agent|tác nhân|delete|close|xoá|xóa|trash|thùng|panel|banana|model|setting/i;

  // 1) Ưu tiên tuyệt đối: nút mũi tên gửi của Flow (icon "arrow_forward")
  let b = buttons.find((x) => /arrow_forward/i.test(label(x)) && !bad.test(label(x)));
  if (b) return b;

  // 2) Các từ khoá gửi/tạo khác
  const wanted = /generate|create|submit|send|run|gửi|送信|生成|→|paper.?plane/i;
  b = buttons.find((x) => wanted.test(label(x)) && !bad.test(label(x)));
  if (b) return b;

  // 3) Nếu không thấy: chọn nút gần ô prompt nhất, BỎ QUA các nút sai
  if (input) {
    const ir = input.getBoundingClientRect();
    const near = buttons
      .filter((x) => !bad.test(label(x)))
      .map((x) => {
        const r = x.getBoundingClientRect();
        const dx = r.left - ir.right;
        const dy = r.top - ir.top;
        return { x, d: Math.hypot(dx, dy) };
      })
      .filter((o) => o.d < 600)
      .sort((a, b) => a.d - b.d);
    if (near[0]) return near[0].x;
  }
  return null;
}

function pressEnter(el) {
  el.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    const ev = new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      composed: true, // vượt qua shadow DOM nếu có
    });
    // FIX QUAN TRỌNG: KeyboardEvent thường để keyCode = 0, khiến Flow không
    // nhận ra phím Enter. Ghi đè lại thành 13 để giống Enter thật.
    Object.defineProperty(ev, "keyCode", { get: () => 13 });
    Object.defineProperty(ev, "which", { get: () => 13 });
    el.dispatchEvent(ev);
  }
}

function clickFully(el) {
  const r = el.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", base));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  } catch (_) {}
  el.click?.();
}

// ---------- 3a. Gắn ảnh tham chiếu từ thư viện Flow ----------
// Nút "+" bên trái ô prompt (mở hộp thoại chọn thành phần/ảnh)
function findRefAddButton(input) {
  const ir = input ? input.getBoundingClientRect() : null;
  const btns = [...document.querySelectorAll('button, [role="button"]')].filter(isVisible);
  const plusText = /^(?:add|add_2|add_circle|\+|add_photo_alternate|attach_file)$/i;
  const plusAria = /thêm nội dung|thêm tệp|thêm ảnh|add (?:media|content|asset|image|file)|^thêm$|^add$|^create$|^tạo$/i;

  let cands = btns.filter((b) => {
    if (b.closest("header, nav")) return false;
    const t = (b.textContent || "").replace(/\s+/g, " ").trim();
    const a = (b.getAttribute("aria-label") || "").trim();
    if (!(plusText.test(t) || plusAria.test(a))) return false;
    const r = b.getBoundingClientRect();
    if (r.top < 72 && ir && ir.top > 180) return false; // tránh nút "+" trên thanh header
    return r.width <= 90 && r.height <= 90;
  });
  if (ir) {
    // chỉ lấy các nút nằm gần vùng thanh prompt (tránh nút "+" ở đầu trang)
    const near = cands.filter((b) => {
      const r = b.getBoundingClientRect();
      return Math.abs(r.top + r.height / 2 - (ir.top + ir.height / 2)) < 260;
    });
    if (near.length) cands = near;
    else return null;

    const row = cands.filter((b) => {
      const r = b.getBoundingClientRect();
      const dy = Math.abs(r.top + r.height / 2 - (ir.top + ir.height / 2));
      return dy < 110 && r.left + r.width / 2 < ir.left + ir.width / 2;
    });
    if (row.length) cands = row;
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const da = Math.hypot(ra.right - ir.left, ra.top + ra.height / 2 - (ir.top + ir.height / 2));
      const db = Math.hypot(rb.right - ir.left, rb.top + rb.height / 2 - (ir.top + ir.height / 2));
      return da - db;
    });
  }
  return cands[0] || null;
}

// Danh sách input hiển thị (dùng để nhận diện ô tìm kiếm MỚI xuất hiện sau khi bấm "+")
const ASSET_INPUT_SEL =
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), [role="searchbox"], [role="combobox"]';

function getVisibleAssetInputs() {
  return [...document.querySelectorAll(ASSET_INPUT_SEL)].filter(isVisible);
}

// Tìm container của hộp thoại chọn ảnh dựa trên ô search (hoặc overlay đang mở)
function findAssetContainer() {
  const searchEl = window.__h2dev_flow_asset_search;
  if (searchEl && searchEl.isConnected && isVisible(searchEl)) {
    const dlg = searchEl.closest(
      '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [aria-modal="true"]'
    );
    if (dlg && isVisible(dlg)) return dlg;
    // Leo lên tìm popover fixed/absolute bao quanh ô search
    let cur = searchEl.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const pos = getComputedStyle(cur).position;
      const r = cur.getBoundingClientRect();
      if ((pos === "fixed" || pos === "absolute") && r.width > 180 && r.height > 140) {
        return cur;
      }
      cur = cur.parentElement;
    }
  }
  const overlays = [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [aria-modal="true"]'
    ),
  ].filter(isVisible);
  return overlays.length ? overlays[overlays.length - 1] : null;
}

// Tìm các thành phần của hộp thoại chọn thành phần
function findAssetUi(kind, name) {
  const visIn = (root, sel) => [...(root || document).querySelectorAll(sel)].filter(isVisible);
  const textOf = (el) => (cleanElementText(el) || el.textContent || "").replace(/\s+/g, " ").trim();

  if (kind === "search") {
    const pre = window.__h2dev_flow_pre_ref_inputs || new Set();
    const promptEd = findPromptInput();
    const allInputs = getVisibleAssetInputs().filter((i) => i !== promptEd);
    const meta = (i) =>
      ((i.placeholder || "") + " " + (i.getAttribute("aria-label") || "") + " " + (i.name || "")).trim();
    const isSearchLike = (i) => /tìm kiếm|search|thành phần|asset|tệp|library|filter|lọc/i.test(meta(i));
    const isAssetSpecific = (i) => /thành phần|assets?|thư viện|library|tệp|media/i.test(meta(i));

    // 1) Ưu tiên cao nhất: ô input MỚI xuất hiện sau khi bấm nút "+" (không phụ thuộc r.top hay role)
    const fresh = allInputs.filter((i) => !pre.has(i));
    const freshPick = fresh.find(isSearchLike) || fresh[fresh.length - 1];
    if (freshPick) {
      window.__h2dev_flow_asset_search = freshPick;
      return freshPick;
    }

    // 2) Ô có placeholder/aria nhắc rõ "thành phần / asset / thư viện"
    const specific = allInputs.find(isAssetSpecific);
    if (specific) {
      window.__h2dev_flow_asset_search = specific;
      return specific;
    }

    // 3) Ô tìm kiếm nằm trong dialog/popover đang mở
    const overlays = [
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [aria-modal="true"]'
      ),
    ].filter(isVisible);
    for (let k = overlays.length - 1; k >= 0; k--) {
      const inDlg = visIn(overlays[k], ASSET_INPUT_SEL).find((i) => i !== promptEd && isSearchLike(i));
      if (inDlg) {
        window.__h2dev_flow_asset_search = inDlg;
        return inDlg;
      }
    }

    return null;
  }

  const container = findAssetContainer();

  if (kind === "add") {
    const findAddIn = (root) =>
      visIn(root, 'button, [role="button"]').find((b) =>
        /thêm vào câu lệnh|add to prompt|add to command/i.test(textOf(b))
      ) || null;
    return (container && findAddIn(container)) || findAddIn(document);
  }
  if (kind === "menu") {
    const findMenuIn = (root) =>
      visIn(root, '[role="menuitem"], [role="option"], button, [role="button"]').find(
        (b) =>
          /thành phần|thư viện|assets?\b|library|chọn từ|choose from/i.test(textOf(b)) &&
          !/tải nội dung|upload/i.test(textOf(b))
      ) || null;
    return (container && findMenuIn(container)) || findMenuIn(document);
  }
  if (kind === "row") {
    const want = (name || "").toLowerCase().trim();
    if (!want) return null;
    const shortWant = want.length > 25 ? want.slice(0, 25) : want;
    const labelOf = (el) => {
      const parts = [
        textOf(el),
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.tagName === "IMG" ? el.getAttribute("alt") || "" : "",
      ];
      return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    };
    const searchIn = (root, strict) => {
      const matches = visIn(root, "*").filter((el) => {
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return false;
        if (el.querySelector("input, textarea")) return false;
        if (root === document && el.closest("header, nav")) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 12 || r.width * r.height > 150000) return false;
        const lbl = labelOf(el);
        return strict ? lbl.includes(want) : lbl.includes(shortWant);
      });
      const leaf = matches.filter((e) => !matches.some((o) => o !== e && e.contains(o)));
      const score = (e) => {
        const t = labelOf(e);
        if (t === want) return 0;
        if (t.startsWith(want)) return 1;
        if (t.includes(want)) return 2;
        if (t.startsWith(shortWant)) return 3;
        return 4;
      };
      leaf.sort((a, b) => score(a) - score(b) || a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      return leaf[0] || null;
    };
    return (
      (container && (searchIn(container, true) || searchIn(container, false))) ||
      searchIn(document, true) ||
      searchIn(document, false)
    );
  }
  return null;
}

// ---------- 3b. Tự động chuyển chế độ Ảnh ↔ Video trên thanh prompt ----------
function cleanElementText(el) {
  if (!el) return "";
  const clone = el.cloneNode(true);
  clone
    .querySelectorAll(
      '[aria-hidden="true"], .material-icons, .material-symbols, .material-symbols-outlined, .material-symbols-rounded, .google-symbols, svg, i'
    )
    .forEach((n) => n.remove());
  return (clone.textContent || "")
    .replace(/\b(?:videocam|movie|photo|smart_display|video_camera_back|image_search)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isVideoModeButtonText(text) {
  return /\bvideo\b|\bveo\b|\b720p\b|\b1080p\b|\b4k\b|\bgiây\b|\bsec\b/i.test(
    text || ""
  );
}

function findModeToggleButton(input) {
  if (CONFIG.modeButtonSelector) {
    const custom = document.querySelector(CONFIG.modeButtonSelector);
    if (custom && isVisible(custom)) return custom;
  }
  const ir = input ? input.getBoundingClientRect() : null;
  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (b) => isVisible(b)
  );

  // Nút pill chọn model/chế độ nằm ngay trên thanh prompt (VD: "Nano Banana 2.1 x1" hoặc "Video · 720p · 8 giây x1")
  const modeHint =
    /nano\s*banana|imagen|veo|video\s*[·•]|720p|1080p|\bx[1-4]\b|giây|hình ảnh|image/i;

  const candidates = buttons
    .filter((b) => {
      const txt = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim();
      if (!modeHint.test(txt)) return false;
      if (/arrow_forward/i.test(txt)) return false;
      if (ir) {
        const r = b.getBoundingClientRect();
        // cùng hàng ngang với ô prompt (lệch dọc < 140px)
        const dy = Math.abs(r.top + r.height / 2 - (ir.top + ir.height / 2));
        if (dy > 140) return false;
      }
      return true;
    })
    .map((b) => {
      const txt = (b.textContent || "").trim();
      let score = 0;
      if (/\bx[1-4]\b/i.test(txt)) score += 5;
      if (/nano\s*banana|imagen|veo|video\s*[·•]|720p|1080p/i.test(txt)) score += 5;
      if (b.getAttribute("aria-haspopup") || b.getAttribute("aria-expanded") != null) score += 3;
      return { b, score };
    })
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.b || null;
}

function findModeOptionInPopover(targetMode, triggerBtn) {
  const candidates = [
    ...document.querySelectorAll(
      '[role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], button, [role="button"], label'
    ),
  ].filter((el) => el !== triggerBtn && isVisible(el));

  const exactVideo = /^(?:video|videos|tạo video)$/i;
  const exactImage = /^(?:hình ảnh|ảnh|image|images|tạo ảnh|tạo hình ảnh)$/i;
  const looseVideo = /\b(?:video|tạo video)\b/i;
  const looseImage = /\b(?:hình ảnh|ảnh|image|images)\b/i;

  const scored = [];
  for (const el of candidates) {
    const clean = cleanElementText(el);
    const aria = (el.getAttribute("aria-label") || "").trim();
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    // Bỏ qua các nút hiển thị cấu hình kiểu "Video · 720p · 8 giây x1"
    if (/720p|1080p|\bx[1-4]\b|giây/i.test(raw)) continue;

    let score = 0;
    if (targetMode === "video") {
      if (exactVideo.test(clean) || exactVideo.test(aria)) score = 100;
      else if (looseVideo.test(clean) || looseVideo.test(aria)) score = 60;
    } else {
      if (exactImage.test(clean) || exactImage.test(aria)) score = 100;
      else if (looseImage.test(clean) || looseImage.test(aria)) score = 60;
    }
    if (score === 0) continue;

    // Ưu tiên phần tử nằm trong popover/dialog/menu hoặc phía trên nút trigger
    if (el.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="tablist"], [data-radix-popper-content-wrapper]')) {
      score += 20;
    }
    if (triggerBtn) {
      const tr = triggerBtn.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.bottom <= tr.top + 40 && Math.abs(er.left - tr.left) < 420) {
        score += 15;
      }
    }
    scored.push({ el, score, clean });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.el || null;
}

async function ensureMediaMode(targetMode, input) {
  if (targetMode !== "video" && targetMode !== "image") return { switched: false };
  const btn = findModeToggleButton(input);
  if (!btn) {
    console.warn("[h2dev_flow] Không tìm thấy nút chuyển chế độ Ảnh/Video trên thanh prompt.");
    return { switched: false, notFound: true };
  }

  const currentText = ((btn.getAttribute("aria-label") || "") + " " + (btn.textContent || "")).trim();
  const isVideo = isVideoModeButtonText(currentText);
  if ((targetMode === "video" && isVideo) || (targetMode === "image" && !isVideo)) {
    console.log(`[h2dev_flow] ✓ Đã ở sẵn chế độ ${targetMode.toUpperCase()} (${currentText.slice(0, 40)})`);
    return { switched: false, alreadyMatched: true };
  }

  console.log(`[h2dev_flow] Đang chuyển chế độ sang ${targetMode.toUpperCase()}... (hiện tại: ${currentText.slice(0, 40)})`);
  clickFully(btn);
  await sleep(350);

  let opt = findModeOptionInPopover(targetMode, btn);
  if (!opt) {
    await sleep(350);
    opt = findModeOptionInPopover(targetMode, btn);
  }

  if (!opt) {
    console.warn(`[h2dev_flow] ❌ Mở menu rồi nhưng không tìm thấy mục chọn ${targetMode.toUpperCase()}.`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(150);
    return { switched: false, optionNotFound: true };
  }

  clickFully(opt);
  await sleep(350);

  // Đóng popover nếu vẫn mở
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  await sleep(200);

  const afterBtn = findModeToggleButton(input) || btn;
  const afterText = ((afterBtn.getAttribute("aria-label") || "") + " " + (afterBtn.textContent || "")).trim();
  const okNow =
    targetMode === "video"
      ? isVideoModeButtonText(afterText)
      : !isVideoModeButtonText(afterText);
  console.log(`[h2dev_flow] ${okNow ? "✓" : "⚠"} Sau khi chuyển chế độ:`, afterText.slice(0, 50));
  return { switched: okNow };
}

// Gửi prompt CHẮC CHẮN: click nút gửi vừa được mở khoá + Enter, rồi
// xác nhận đã gửi bằng cách kiểm tra ô prompt đã trống chưa. Thử lại vài lần.
async function submitPromptReliably(input, disabledBefore) {
  const arrow = findGenerateButton(input);
  console.log(
    "[h2dev_flow] Nút gửi:",
    arrow
      ? arrow.getAttribute("aria-label") ||
          arrow.textContent.trim().slice(0, 15) ||
          arrow.tagName
      : "KHÔNG THẤY"
  );

  for (let i = 0; i < 10; i++) {
    if (STOP) return false;

    // 1) Ưu tiên Enter thật (giống đúng lúc bạn tự bấm Enter -> sinh được ảnh)
    input.focus?.();
    pressEnter(input);
    await sleep(700);
    if (inputText(input).trim().length < 3) {
      console.log("[h2dev_flow] ✓ Gửi bằng ENTER (lần", i + 1, ")");
      return true;
    }

    // 2) Enter chưa ăn -> thử click nút mũi tên
    if (arrow) {
      clickFully(arrow);
      await sleep(700);
      if (inputText(input).trim().length < 3) {
        console.log("[h2dev_flow] ✓ Gửi bằng CLICK nút (lần", i + 1, ")");
        return true;
      }
    }
  }
  return false;
}

// Tìm thẻ (card) chứa 1 <video>: leo lên tới tổ tiên lớn nhất còn chỉ chứa ≤ 2 ảnh và không chứa video khác
function videoCardRoot(video) {
  let best = video.parentElement || video;
  let el = video.parentElement;
  for (let depth = 0; depth < 10 && el && el !== document.body; depth++) {
    if (el.querySelectorAll("video").length > 1) break;
    if (el.querySelectorAll("img").length > 2) break;
    best = el;
    el = el.parentElement;
  }
  return best;
}

function getVideoRoots() {
  if (!window.__h2dev_flow_video_roots) window.__h2dev_flow_video_roots = new Set();
  return window.__h2dev_flow_video_roots;
}

// Ghi nhớ thẻ của video đã thấy: poster của nó sau này có đổi src cũng không bị nhận nhầm là ảnh mới
function registerVideoCard(video) {
  try {
    getVideoRoots().add(videoCardRoot(video));
  } catch (_) {}
}

// Kiểm tra xem <img> có nằm trong thẻ của một VIDEO (poster/thumbnail) không
function isInsideVideoCard(img) {
  // 1) thẻ của mọi <video> đang có + các thẻ video đã ghi nhớ
  try {
    const roots = getVideoRoots();
    for (const r of [...roots]) if (!r.isConnected) roots.delete(r);
    for (const v of document.querySelectorAll("video")) roots.add(videoCardRoot(v));
    for (const r of roots) if (r.contains(img)) return true;
  } catch (_) {}
  // 2) Ảnh poster/khung hình luôn nằm đè lên (hoặc cạnh) thẻ <video>: nếu tâm ảnh rơi vào vùng một <video> thì bỏ
  try {
    const ir = img.getBoundingClientRect();
    const cx = ir.left + ir.width / 2;
    const cy = ir.top + ir.height / 2;
    for (const v of document.querySelectorAll("video")) {
      const vr = v.getBoundingClientRect();
      if (vr.width < 2 || vr.height < 2) continue;
      if (cx >= vr.left && cx <= vr.right && cy >= vr.top && cy <= vr.bottom) return true;
    }
  } catch (_) {}
  let el = img.parentElement;
  for (let depth = 0; depth < 8 && el && el !== document.body; depth++) {
    // Dừng nếu đã leo lên tới container chứa nhiều thẻ (lưới)
    if (el.querySelectorAll("img").length > 3) break;
    if (el.querySelector("video")) return true;
    const txt = (el.textContent || "").trim();
    // Thẻ video trên Flow thường có badge thời lượng kiểu "0:08" hoặc icon videocam/play_arrow
    if (/\b\d:\d{2}\b/.test(txt) || /\b(?:videocam|play_arrow|movie)\b/i.test(txt)) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

// ---------- 4. Lấy danh sách ảnh / video đã hoàn thành ----------
function getAllLargeImages() {
  return [...document.querySelectorAll("img")].filter((img) => {
    if (!isVisible(img)) return false;
    if (!img.complete) return false;
    const src = srcKey(img);
    if (!/^https?:|^blob:/.test(src)) return false;
    // bỏ qua icon/avatar nhỏ
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w < CONFIG.minImageSize && h < CONFIG.minImageSize) return false;
    return true;
  });
}

function getCompletedImages() {
  return getAllLargeImages().filter((img) => !isInsideVideoCard(img));
}

function getCompletedVideos() {
  return [...document.querySelectorAll("video")].filter((video) => {
    if (!isVideoPresent(video)) return false;
    const src = videoSrcKey(video);
    if (!/^https?:|^blob:/.test(src)) return false;
    const r = video.getBoundingClientRect();
    const w = video.videoWidth || r.width;
    const h = video.videoHeight || r.height;
    if (w < CONFIG.minVideoSize && h < CONFIG.minVideoSize) return false;
    return true;
  });
}

function snapshotCurrentMedia() {
  const seenImgs = getSeenImages();
  const seenVids = getSeenVideos();
  for (const img of getAllLargeImages()) markSeen(seenImgs, srcKey(img));
  for (const vid of getCompletedVideos()) markSeen(seenVids, videoSrcKey(vid));
}

function triggerHover(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const base = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  try {
    el.dispatchEvent(new PointerEvent("pointerover", base));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...base, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...base, bubbles: false }));
  } catch (_) {}
}

// ---------- 5. Canh tới khi có ảnh / video MỚI xuất hiện ----------
// Trang đang hiện thông báo lỗi của Flow (thẻ thất bại, chờ người dùng bấm tải lại)?
function pageShowsFailure() {
  try {
    const t = (document.body.innerText || "").slice(0, 20000);
    return /không thành công|thất bại|đã xảy ra lỗi|something went wrong|generation failed|\bfailed\b|vi phạm|violat/i.test(t);
  } catch (_) {
    return false;
  }
}
const MAX_FAILURE_PAUSE_MS = 30 * 60 * 1000;

async function waitForNewImage(seenImages) {
  const start = Date.now();
  let pausedMs = 0;
  let lastTick = start;
  console.log("[h2dev_flow] Đang chờ ảnh mới... (đã ghi nhận:", seenImages.size, ")");
  let lastLog = 0;
  while (Date.now() - start - pausedMs < CONFIG.maxWaitMs) {
    if (STOP) return { stopped: true };
    // Khi Flow báo lỗi: không tính vào thời gian chờ để người dùng kịp bấm tải lại trên Flow
    const nowTick = Date.now();
    if (pausedMs < MAX_FAILURE_PAUSE_MS && pageShowsFailure()) {
      pausedMs += nowTick - lastTick;
      lastTick = nowTick;
      console.log("[h2dev_flow] ⚠ Flow đang báo lỗi — tạm dừng đếm giờ, chờ bạn bấm tải lại...");
    } else {
      lastTick = nowTick;
    }
    const elapsedMs = Date.now() - start - pausedMs;
    if (elapsedMs >= CONFIG.minGenerateImageMs) {
      const all = getCompletedImages();
      const fresh = all.filter((i) => !isSeen(seenImages, srcKey(i)));
      if (fresh.length) {
        const newest = fresh[0];
        const initialSrc = srcKey(newest);
        await sleep(CONFIG.settleMs); // chờ ảnh load đủ
        const finalSrc = srcKey(newest) || initialSrc;
        if (!isSeen(seenImages, finalSrc)) {
          markSeen(seenImages, initialSrc);
          markSeen(seenImages, finalSrc);
          console.log("[h2dev_flow] ✓✓ Thấy ảnh mới! Đang tải:", finalSrc.slice(0, 70));
          return { img: newest, src: finalSrc };
        }
      }
      const elapsed = Math.round(elapsedMs / 1000);
      if (elapsed - lastLog >= 10) {
        lastLog = elapsed;
        console.log("[h2dev_flow] ...vẫn đang chờ ảnh —", elapsed, "giây trôi qua. Số ảnh ≥256px hiện có:", all.length);
      }
    }
    await sleep(CONFIG.pollMs);
  }
  return { timeout: true };
}

async function waitForNewVideo(seenVideos, seenImages) {
  const start = Date.now();
  const imgSeen = seenImages || getSeenImages();
  const hovered = new WeakSet();
  let pausedMs = 0;
  let lastTick = start;
  console.log("[h2dev_flow] Đang chờ video mới... (đã ghi nhận:", seenVideos.size, ")");
  let lastLog = 0;
  while (Date.now() - start - pausedMs < CONFIG.maxWaitVideoMs) {
    if (STOP) return { stopped: true };
    const nowTick = Date.now();
    if (pausedMs < MAX_FAILURE_PAUSE_MS && pageShowsFailure()) {
      pausedMs += nowTick - lastTick;
      lastTick = nowTick;
      console.log("[h2dev_flow] ⚠ Flow đang báo lỗi — tạm dừng đếm giờ, chờ bạn bấm tải lại...");
    } else {
      lastTick = nowTick;
    }
    const elapsedMs = Date.now() - start - pausedMs;
    if (elapsedMs >= CONFIG.minGenerateVideoMs) {
      const all = getCompletedVideos();
      const fresh = all.filter((v) => !isSeen(seenVideos, videoSrcKey(v)));
      if (fresh.length) {
        const newest = fresh[0];
        const initialSrc = videoSrcKey(newest);
        await sleep(CONFIG.settleMs); // chờ video load đủ
        const finalSrc = videoSrcKey(newest) || initialSrc;
        if (!isSeen(seenVideos, finalSrc)) {
          markSeen(seenVideos, initialSrc);
          markSeen(seenVideos, finalSrc);
          // Đánh dấu luôn ảnh poster nằm cùng thẻ video này để prompt [IMAGE] sau không tải nhầm
          const card = newest.closest('[role="button"], a, article') || newest.parentElement;
          if (card) {
            card.querySelectorAll("img").forEach((img) => markSeen(imgSeen, srcKey(img)));
          }
          // Ghi nhận lại toàn bộ ảnh hiện có (poster/khung hình video có thể đổi src muộn) để KHÔNG tải nhầm thành ảnh
          snapshotCurrentMedia();
          registerVideoCard(newest);
          await sleep(1500);
          snapshotCurrentMedia();
          registerVideoCard(newest);
          console.log("[h2dev_flow] ✓✓ Thấy video mới! Đang tải:", finalSrc.slice(0, 70));
          return { video: newest, src: finalSrc };
        }
      }

      // Dự phòng: Google Flow chỉ gắn thẻ <video> hoặc nạp src khi di chuột vào thẻ poster mới tạo
      const newImgs = getAllLargeImages().filter((img) => !isSeen(imgSeen, srcKey(img)));
      for (const img of newImgs) {
        if (!hovered.has(img)) {
          hovered.add(img);
          triggerHover(img);
          const card = img.closest('[role="button"], a, article') || img.parentElement;
          if (card && card !== img) triggerHover(card);
        }
      }

      const elapsed = Math.round(elapsedMs / 1000);
      if (elapsed - lastLog >= 10) {
        lastLog = elapsed;
        const totalVideoTags = document.querySelectorAll("video").length;
        console.log(
          "[h2dev_flow] ...vẫn đang chờ video —",
          elapsed,
          "giây trôi qua. Video hợp lệ:",
          all.length,
          "| tổng thẻ <video>:",
          totalVideoTags
        );
      }
    }
    await sleep(CONFIG.pollMs);
  }
  return { timeout: true };
}

// ---------- 6. Chạy 1 prompt trọn vẹn ----------
async function runOne(prompt) {
  // đánh thức + tìm ô prompt (Slate mount khi được click)
  let input = await wakePromptBox();
  if (!input) {
    console.warn(
      "[h2dev_flow] ❌ KHÔNG tìm thấy ô prompt. Đếm phần tử trong DOM →",
      "slate:", document.querySelectorAll('[data-slate-editor="true"]').length,
      "| textbox:", document.querySelectorAll('[role="textbox"]').length,
      "| contenteditable:", document.querySelectorAll('[contenteditable="true"]').length,
      "| textarea:", document.querySelectorAll("textarea").length
    );
    return { ok: false, error: "Không tìm thấy ô prompt." };
  }
  console.log("[h2dev_flow] ✓ Ô prompt:", input.tagName, input.getAttribute("role"));

  const baseline = new Set(getCompletedImages().map(srcKey));
  const disabledBefore = new Set(
    [...document.querySelectorAll('button, [role="button"]')].filter((b) =>
      isBtnDisabled(b)
    )
  );

  // đảm bảo focus trước khi gõ
  clickFully(input);
  input.focus?.();
  await sleep(150);

  // gõ prompt
  setPromptText(input, prompt);
  await sleep(700);

  const got = inputText(input).trim();
  console.log("[h2dev_flow] Sau khi gõ, nội dung ô =", JSON.stringify(got.slice(0, 50)), "(", got.length, "ký tự )");
  if (got.length < 3) {
    console.warn("[h2dev_flow] ❌ Gõ chữ KHÔNG vào được ô (Slate không nhận).");
    return { ok: false, error: "Gõ chữ không vào được ô prompt (Slate)." };
  }

  // gửi + xác nhận đã gửi
  const sent = await submitPromptReliably(input, disabledBefore);
  if (STOP) return { ok: false, stopped: true };
  if (!sent) {
    console.warn("[h2dev_flow] ❌ Gõ được nhưng KHÔNG gửi được.");
    return {
      ok: false,
      error: "Đã gõ prompt nhưng KHÔNG gửi được (nút gửi không phản hồi).",
    };
  }

  // chờ ảnh mới
  const res = await waitForNewImage(baseline);
  if (res.stopped) return { ok: false, stopped: true };
  if (res.timeout) return { ok: false, timeout: true };
  return { ok: true, src: res.src };
}

// ---------- 7. Đổi ảnh/video sang dataURL (dùng cho blob:) ----------
async function toDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
  return { dataUrl, mimeType: blob.type || "" };
}

// ---------- 8. Nhận lệnh từ side panel ----------
// Chống đăng ký listener 2 lần (khi vừa tiêm khai báo vừa tiêm tay)
if (!window.__H2DEV_FLOW_LISTENER__) {
  window.__H2DEV_FLOW_LISTENER__ = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "PING") {
      let hasInput = false;
      try {
        hasInput = !!findPromptInput();
      } catch (_) {}
      sendResponse({ ok: true, hasInput });
      return; // đồng bộ
    }

    if (msg.type === "STOP") {
      STOP = true;
      sendResponse({ ok: true });
      return;
    }

    // Khởi tạo bộ nhớ đã thấy cho 1 phiên chạy mới (tránh tải trùng media cũ khi DOM unmount/remount)
    if (msg.type === "RESET_RUN") {
      STOP = false;
      window.__h2dev_flow_seen_images = new Set();
      window.__h2dev_flow_seen_videos = new Set();
      window.__h2dev_flow_video_roots = new Set();
      snapshotCurrentMedia();
      sendResponse({ ok: true });
      return;
    }

    // Toạ độ nút "+" thêm ảnh tham chiếu cạnh ô prompt
    if (msg.type === "GET_REF_BTN") {
      (async () => {
        try {
          const input = await wakePromptBox();
          const btn = findRefAddButton(input);
          if (!btn) {
            sendResponse({ ok: false, notFound: true });
            return;
          }
          // Ghi nhận các ô input đã có sẵn trước khi bấm "+" để nhận diện chính xác ô tìm kiếm mới mở
          window.__h2dev_flow_pre_ref_inputs = new Set(getVisibleAssetInputs());
          window.__h2dev_flow_asset_search = null;
          const r = btn.getBoundingClientRect();
          sendResponse({
            ok: true,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    // Toạ độ các phần tử trong hộp thoại chọn thành phần (search / row / add / menu)
    if (msg.type === "GET_ASSET_UI") {
      try {
        const el = findAssetUi(msg.kind, msg.name);
        if (!el) {
          sendResponse({ ok: false, notFound: true });
          return;
        }
        const r = el.getBoundingClientRect();
        sendResponse({
          ok: true,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

    // Kiểm tra chế độ Ảnh/Video hiện tại và trả về toạ độ nút mở menu nếu cần chuyển
    if (msg.type === "GET_MODE_BTN") {
      (async () => {
        try {
          const input = await wakePromptBox();
          const btn = findModeToggleButton(input);
          if (!btn) {
            sendResponse({ ok: false, notFound: true });
            return;
          }
          const txt = ((btn.getAttribute("aria-label") || "") + " " + (btn.textContent || "")).trim();
          const isVideo = isVideoModeButtonText(txt);
          const targetMode = msg.mediaType === "video" ? "video" : "image";
          if ((targetMode === "video" && isVideo) || (targetMode === "image" && !isVideo)) {
            console.log(`[h2dev_flow] ✓ Đã ở sẵn chế độ ${targetMode.toUpperCase()} (${txt.slice(0, 40)})`);
            sendResponse({ ok: true, alreadyMatched: true });
            return;
          }
          const r = btn.getBoundingClientRect();
          window.__h2dev_flow_mode_btn = btn;
          console.log(`[h2dev_flow] Cần chuyển sang ${targetMode.toUpperCase()} (hiện tại: ${txt.slice(0, 40)})`);
          sendResponse({
            ok: true,
            needSwitch: true,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    // Sau khi background click thật để mở menu, tìm toạ độ tab "Hình ảnh" / "Video"
    if (msg.type === "GET_MODE_OPTION") {
      try {
        const targetMode = msg.mediaType === "video" ? "video" : "image";
        const triggerBtn = window.__h2dev_flow_mode_btn || findModeToggleButton(findPromptInput());
        const opt = findModeOptionInPopover(targetMode, triggerBtn);
        if (!opt) {
          sendResponse({ ok: false, notFound: true });
          return;
        }
        const r = opt.getBoundingClientRect();
        console.log(`[h2dev_flow] ✓ Tìm thấy tab ${targetMode.toUpperCase()}:`, cleanElementText(opt));
        sendResponse({
          ok: true,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

    // Trả về toạ độ tâm ô prompt (để background click + gõ qua debugger),
    // và cộng dồn ảnh/video hiện có vào bộ nhớ đã thấy để không bao giờ tải lại file cũ.
    if (msg.type === "GET_BOX") {
      STOP = false;
      (async () => {
        try {
          const input = await wakePromptBox();
          if (!input) {
            sendResponse({ ok: false, error: "Không tìm thấy ô prompt." });
            return;
          }
          const r = input.getBoundingClientRect();
          snapshotCurrentMedia();
          sendResponse({
            ok: true,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }

    // Chờ ảnh hoặc video mới (so với bộ nhớ đã thấy cộng dồn) rồi trả src
    if (msg.type === "WAIT_MEDIA" || msg.type === "WAIT_IMAGE") {
      const mediaType = msg.mediaType === "video" ? "video" : "image";
      const waiter =
        mediaType === "video"
          ? waitForNewVideo(getSeenVideos(), getSeenImages())
          : waitForNewImage(getSeenImages());
      waiter
        .then((res) => {
          if (res.stopped) sendResponse({ ok: false, stopped: true });
          else if (res.timeout) sendResponse({ ok: false, timeout: true });
          else sendResponse({ ok: true, src: res.src, mediaType });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    if (msg.type === "TODATAURL") {
      toDataUrl(msg.src)
        .then((r) => sendResponse({ dataUrl: r.dataUrl, mimeType: r.mimeType }))
        .catch((e) => sendResponse({ error: String(e) }));
      return true;
    }
  });

  console.log("[h2dev_flow] content script đã sẵn sàng trên Google Flow.");
}
