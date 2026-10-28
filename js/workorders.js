/* PDF work orders tab: upload, per-field comments, preview, save/submit.
 * Backed by /api/work-orders (Netlify Function + Database + Blobs).
 * All user-provided text is rendered with textContent — never innerHTML. */
(function () {
  const API = "/api/work-orders";
  const MAX_BYTES = 20 * 1024 * 1024;
  const SIZE_MSG = "Only PDF files up to 20 MB are supported.";
  const MAX_COMMENT_CHARS = 4000;
  const MAX_SCAN_PAGES = 50;
  const MAX_PDF_FIELDS = 80;
  const MAX_PREVIEW_PAGES = 20;
  const SECTIONS = [
    { key: "section:scope", label: "Scope of Work", hint: "Clarifications or changes to the scope" },
    { key: "section:safety", label: "Safety / HSE Notes", hint: "Permits, PPE, hazards, isolations" },
    { key: "section:materials", label: "Materials & Parts", hint: "Parts used, shortages, specifications" },
    { key: "section:completion", label: "Completion Remarks", hint: "Outcome and follow-up actions" },
  ];

  const state = {
    loaded: false,
    loading: false,
    loadError: "",
    items: [], // work orders from the API (saved state)
    selectedId: null,
    drafts: new Map(), // id -> { woNo, values: { fieldKey: text } } (unsaved edits)
    fields: new Map(), // id -> detected PDF form text fields
    fieldScan: new Map(), // id -> "scanning" | "done" | "error"
    docs: new Map(), // id -> Promise<PDFDocumentProxy>
    localFiles: new Map(), // id -> File uploaded in this session
    page: 1,
    showOverlay: true,
    renderToken: 0,
    uploads: [],
    uploading: false,
    preview: null, // { id, returnFocus, saving }
  };

  const $ = (sel, el = document) => el.querySelector(sel);

  /* ---------- DOM helpers (text-only, XSS-safe) ---------- */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => t.classList.remove("show"), 3200);
  }
  function announce(msg) {
    const live = $("#woLive");
    live.textContent = "";
    setTimeout(() => (live.textContent = msg), 30);
  }
  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function fmtDate(s) {
    const d = new Date(s);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }
  function quote(s, max = 140) {
    s = String(s || "").replace(/\s+/g, " ");
    return "“" + (s.length > max ? s.slice(0, max - 1) + "…" : s) + "”";
  }

  /* ---------- API ---------- */
  const UNAVAILABLE =
    "Couldn't reach the work order service. Check your connection — this tab needs the hosted (Netlify) version of the app.";

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        ...opts,
        headers: typeof opts.body === "string" ? { "Content-Type": "application/json" } : undefined,
      });
    } catch (e) {
      throw new Error(UNAVAILABLE);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (!data && res.status === 404) throw new Error(UNAVAILABLE);
      throw new Error((data && data.error) || `Request failed (${res.status}).`);
    }
    if (!data) throw new Error("Unexpected response from the server.");
    return data;
  }

  function putChunk(url, blob, onProgress) {
    const attempt = () =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.timeout = 120000;
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress(blob.size);
            return resolve();
          }
          let msg = "";
          try {
            msg = JSON.parse(xhr.responseText).error;
          } catch (e) {}
          const err = new Error(msg || `Upload failed (${xhr.status}).`);
          err.fatal = xhr.status >= 400 && xhr.status < 500;
          reject(err);
        };
        xhr.onerror = () => reject(new Error("Network error during upload. Check your connection and retry."));
        xhr.ontimeout = () => reject(new Error("The upload timed out. Please retry."));
        xhr.send(blob);
      });
    // One automatic retry for transient (network / 5xx) failures.
    return attempt().catch((err) => {
      if (err.fatal) throw err;
      onProgress(0);
      return attempt();
    });
  }

  /* ---------- Draft / change model ---------- */
  const current = () => state.items.find((w) => w.id === state.selectedId) || null;

  function savedValues(wo) {
    const v = {};
    wo.comments.forEach((c) => (v[c.field] = c.text));
    return v;
  }
  function getDraft(wo) {
    let d = state.drafts.get(wo.id);
    if (!d) {
      d = { woNo: wo.woNo || "", values: savedValues(wo) };
      state.drafts.set(wo.id, d);
    }
    return d;
  }
  function draftValues(wo) {
    const d = getDraft(wo);
    const out = {};
    Object.entries(d.values).forEach(([k, v]) => {
      if ((v || "").trim()) out[k] = v.trim();
    });
    return out;
  }

  function fieldDefs(wo) {
    const defs = SECTIONS.map((s) => ({ ...s, group: "section", page: null }));
    (state.fields.get(wo.id) || []).forEach((f) => defs.push({ ...f, group: "pdf" }));
    const known = new Set(defs.map((d) => d.key));
    // Saved comments whose field isn't currently known (e.g. PDF not scanned yet).
    wo.comments.forEach((c) => {
      if (known.has(c.field)) return;
      known.add(c.field);
      defs.push({ key: c.field, label: c.label, page: c.page, group: "other" });
    });
    return defs;
  }
  function fieldLabel(wo, key) {
    const d = fieldDefs(wo).find((f) => f.key === key);
    return d ? d.label : key;
  }

  function changesFor(wo) {
    const d = state.drafts.get(wo.id);
    if (!d) return [];
    const saved = savedValues(wo);
    const out = [];
    if (d.woNo.trim() !== (wo.woNo || "")) {
      out.push({ kind: "wo", label: "Work order no.", before: wo.woNo || "", after: d.woNo.trim() });
    }
    const keys = new Set([...Object.keys(saved), ...Object.keys(d.values)]);
    fieldDefs(wo).forEach((f) => {
      if (!keys.has(f.key)) return;
      const a = (saved[f.key] || "").trim();
      const b = (d.values[f.key] || "").trim();
      if (a === b) return;
      out.push({ kind: !a ? "added" : !b ? "removed" : "changed", field: f.key, label: f.label, before: a, after: b });
    });
    return out;
  }
  const dirtyItems = () => state.items.filter((wo) => changesFor(wo).length);

  function payloadFor(wo, submit) {
    const d = getDraft(wo);
    const values = draftValues(wo);
    return {
      workOrderId: wo.id,
      woNo: d.woNo.trim(),
      pdfFileName: wo.fileName,
      submit,
      comments: fieldDefs(wo)
        .filter((f) => values[f.key])
        .map((f) => ({ field: f.key, label: f.label, page: f.page || null, text: values[f.key] })),
    };
  }

  /* ---------- Register lookup ---------- */
  function registerObservations() {
    try {
      return (window.HSEStore && HSEStore.load().observations) || [];
    } catch (e) {
      return [];
    }
  }
  function refreshRegisterList() {
    const list = $("#woRegisterList");
    list.replaceChildren();
    const seen = new Set();
    registerObservations().forEach((o) => {
      const wo = String(o.woNo || "");
      if (!wo || seen.has(wo)) return;
      seen.add(wo);
      list.append(h("option", { value: wo }, o.location || ""));
    });
  }
  function guessWoNo(fileName) {
    const nums = String(fileName).match(/\d{6,9}/g) || [];
    const reg = new Set(registerObservations().map((o) => String(o.woNo)));
    return nums.find((n) => reg.has(n)) || nums[0] || "";
  }

  /* ---------- List ---------- */
  async function loadList() {
    state.loading = true;
    state.loadError = "";
    renderList();
    try {
      const data = await api("");
      state.items = data.workOrders;
      state.loaded = true;
      if (state.selectedId && !current()) state.selectedId = null;
      if (!state.selectedId && state.items.length) state.selectedId = state.items[0].id;
    } catch (e) {
      state.loadError = e.message;
    }
    state.loading = false;
    renderList();
    renderEditor();
  }

  function statusBadge(wo) {
    return wo.status === "submitted"
      ? h("span", { class: "badge ok" }, "Submitted")
      : h("span", { class: "badge open" }, "Draft");
  }

  function renderList() {
    const status = $("#woListStatus");
    const list = $("#woList");
    status.replaceChildren();
    list.replaceChildren();
    $("#woListRefresh").disabled = state.loading;
    if (state.loading) {
      status.append(h("p", { class: "wo-state" }, spinner(), "Loading work orders…"));
    } else if (state.loadError) {
      status.append(
        h(
          "div",
          { class: "wo-alert", role: "alert" },
          h("p", null, state.loadError),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: loadList }, "Retry")
        )
      );
    } else if (!state.items.length) {
      status.append(h("p", { class: "wo-state" }, "No work orders yet. Upload a PDF to get started."));
    }
    state.items.forEach((wo) => {
      const pending = changesFor(wo).length;
      const selected = wo.id === state.selectedId;
      list.append(
        h(
          "li",
          null,
          h(
            "button",
            {
              type: "button",
              class: "wo-item" + (selected ? " selected" : ""),
              "aria-current": selected ? "true" : null,
              onclick: () => select(wo.id),
            },
            h("span", { class: "wo-item-title" }, wo.woNo ? `WO ${wo.woNo}` : "No WO number"),
            h("span", { class: "wo-item-file" }, wo.fileName),
            h(
              "span",
              { class: "wo-item-meta" },
              statusBadge(wo),
              pending ? h("span", { class: "badge warn" }, `${pending} unsaved`) : null,
              h("span", null, plural(wo.comments.length, "comment"))
            )
          )
        )
      );
    });
  }

  function select(id) {
    if (id === state.selectedId) return;
    state.selectedId = id;
    state.page = 1;
    renderList();
    renderEditor();
  }

  /* ---------- Editor ---------- */
  let fieldSeq = 0;

  function renderEditor() {
    const host = $("#woEditor");
    host.replaceChildren();
    const wo = current();
    if (!wo) {
      host.append(
        h(
          "div",
          { class: "wo-empty" },
          h("h3", null, "No work order selected"),
          h(
            "p",
            null,
            state.items.length
              ? "Select a work order from the list to add comments."
              : "Upload a PDF work order to add comments and preview changes before saving."
          )
        )
      );
      return;
    }
    const d = getDraft(wo);

    host.append(
      h(
        "header",
        { class: "wo-editor-head" },
        h(
          "div",
          { class: "wo-editor-title" },
          h("h3", { id: "woEditorTitle" }, wo.fileName),
          h(
            "p",
            { class: "wo-sub" },
            statusBadge(wo),
            ` ${formatBytes(wo.fileSize)} · uploaded ${fmtDate(wo.createdAt)}`,
            wo.submittedAt ? ` · submitted ${fmtDate(wo.submittedAt)}` : ""
          )
        ),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => deleteWo(wo) }, "Delete work order")
      )
    );

    const woInput = h("input", {
      id: "woNoInput",
      list: "woRegisterList",
      autocomplete: "off",
      maxlength: "50",
      inputmode: "numeric",
      "aria-describedby": "woNoHint",
    });
    woInput.value = d.woNo;
    woInput.addEventListener("input", () => {
      d.woNo = woInput.value;
      updateWoHint(d.woNo);
      onDraftChange(wo);
    });
    host.append(
      h(
        "div",
        { class: "field wo-no-field" },
        h("label", { for: "woNoInput" }, "Work order no."),
        woInput,
        h("small", { id: "woNoHint", class: "wo-hint" })
      )
    );
    updateWoHint(d.woNo);

    const prev = h("button", { type: "button", class: "btn btn-ghost btn-sm", id: "woPrevPage", onclick: () => goPage(-1) }, "‹ Prev");
    const next = h("button", { type: "button", class: "btn btn-ghost btn-sm", id: "woNextPage", onclick: () => goPage(1) }, "Next ›");
    const toggle = h("input", { type: "checkbox", id: "woOverlayToggle" });
    toggle.checked = state.showOverlay;
    toggle.addEventListener("change", () => {
      state.showOverlay = toggle.checked;
      refreshOverlay();
    });
    const viewer = h(
      "section",
      { class: "wo-viewer", "aria-labelledby": "woViewerHeading" },
      h("h4", { id: "woViewerHeading", class: "sr-only" }, "PDF viewer"),
      h(
        "div",
        { class: "wo-viewer-bar" },
        prev,
        h("span", { id: "woPageLabel", "aria-live": "polite" }, "Page –"),
        next,
        h("span", { class: "spacer" }),
        h("label", { class: "wo-toggle", for: "woOverlayToggle" }, toggle, " Show comments on PDF")
      ),
      h("div", { id: "woPageHost", class: "wo-page-host" })
    );

    const form = h(
      "form",
      { class: "wo-comments", id: "woCommentsForm", novalidate: true, "aria-labelledby": "woCommentsHeading" },
      h("h4", { id: "woCommentsHeading" }, "Comments"),
      h(
        "fieldset",
        null,
        h("legend", null, "Work order sections"),
        SECTIONS.map((s) => commentField(wo, { ...s, group: "section" }))
      ),
      h("fieldset", { id: "woPdfFields" }),
      h("fieldset", { id: "woOtherFields", hidden: true }),
      h(
        "div",
        { class: "wo-actions" },
        h("span", { id: "woPendingLabel", class: "wo-pending", role: "status" }),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "btn btn-ghost", id: "woDiscard", onclick: () => discard(wo) }, "Discard changes"),
        h("button", { type: "submit", class: "btn btn-primary", id: "woPreviewBtn" }, "Preview changes")
      )
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      openPreview(wo);
    });

    host.append(h("div", { class: "wo-editor-grid" }, viewer, form));
    renderFieldGroups(wo);
    updatePending(wo);
    renderViewer(wo);
  }

  function updateWoHint(value) {
    const hint = $("#woNoHint");
    if (!hint) return;
    const v = value.trim();
    const match = v && registerObservations().find((o) => String(o.woNo) === v);
    hint.className = "wo-hint" + (v && !match ? " warn" : "");
    hint.textContent = !v
      ? "Optional — links this PDF to a WO in the Observations register."
      : match
      ? `Matches register: ${match.location || "observation"}`
      : "Not found in the Observations register.";
  }

  function commentField(wo, def) {
    const d = getDraft(wo);
    const id = "woc-" + ++fieldSeq;
    const ta = h("textarea", {
      id,
      name: def.key,
      rows: "3",
      maxlength: String(MAX_COMMENT_CHARS),
      placeholder: def.hint || "",
      "aria-describedby": id + "-hint",
    });
    ta.value = d.values[def.key] || "";
    const hint = h("small", { id: id + "-hint", class: "wo-hint" });
    const wrap = h(
      "div",
      { class: "field wo-field", "data-field": def.key },
      h("label", { for: id }, def.label, def.page ? h("span", { class: "wo-page-tag" }, `page ${def.page}`) : null),
      ta,
      hint
    );
    const update = () => {
      const changed = ta.value.trim() !== (savedValues(wo)[def.key] || "").trim();
      wrap.classList.toggle("changed", changed);
      const parts = [`${ta.value.length}/${MAX_COMMENT_CHARS}`];
      if (def.pdfValue) parts.push(`PDF value: ${quote(def.pdfValue, 60)}`);
      if (changed) parts.push("unsaved change");
      hint.textContent = parts.join(" · ");
    };
    ta.addEventListener("input", () => {
      d.values[def.key] = ta.value;
      update();
      onDraftChange(wo);
    });
    update();
    return wrap;
  }

  function renderFieldGroups(wo) {
    const pdfSet = $("#woPdfFields");
    const otherSet = $("#woOtherFields");
    if (!pdfSet) return;
    const scan = state.fieldScan.get(wo.id);
    const pdfFields = state.fields.get(wo.id) || [];
    pdfSet.replaceChildren(h("legend", null, "PDF form fields"));
    if (!scan || scan === "scanning") {
      pdfSet.append(h("p", { class: "wo-state" }, spinner(), "Scanning the PDF for fillable text fields…"));
    } else if (scan === "error") {
      pdfSet.append(h("p", { class: "wo-state" }, "Couldn't read form fields from this PDF. Use the sections above."));
    } else if (!pdfFields.length) {
      pdfSet.append(h("p", { class: "wo-state" }, "This PDF has no fillable text fields. Use the sections above."));
    } else {
      pdfFields.forEach((f) => pdfSet.append(commentField(wo, { ...f, group: "pdf" })));
    }
    const others = fieldDefs(wo).filter((f) => f.group === "other");
    otherSet.hidden = !others.length;
    otherSet.replaceChildren(h("legend", null, "Other saved comments"));
    others.forEach((f) => otherSet.append(commentField(wo, f)));
  }

  function updatePending(wo) {
    const n = changesFor(wo).length;
    const label = $("#woPendingLabel");
    if (label) label.textContent = n ? `${plural(n, "change")} pending` : "No unsaved changes";
    const discardBtn = $("#woDiscard");
    if (discardBtn) discardBtn.disabled = !n;
  }

  let draftTimer = null;
  function onDraftChange(wo) {
    updatePending(wo);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      renderList();
      refreshOverlay();
    }, 200);
  }

  function discard(wo) {
    const n = changesFor(wo).length;
    if (!n) return;
    if (!confirm(`Discard ${plural(n, "unsaved change")} to this work order? This can't be undone.`)) return;
    state.drafts.delete(wo.id);
    renderList();
    renderEditor();
    announce("Changes discarded.");
  }

  async function deleteWo(wo) {
    const pending = changesFor(wo).length;
    const msg =
      `Delete "${wo.fileName}"? This permanently removes the PDF and all its saved comments.` +
      (pending ? `\n\n${plural(pending, "unsaved change")} will also be lost.` : "");
    if (!confirm(msg)) return;
    try {
      await api(`/${wo.id}`, { method: "DELETE" });
    } catch (e) {
      toast("Delete failed: " + e.message);
      return;
    }
    const idx = state.items.findIndex((w) => w.id === wo.id);
    state.items = state.items.filter((w) => w.id !== wo.id);
    [state.drafts, state.fields, state.fieldScan, state.docs, state.localFiles].forEach((m) => m.delete(wo.id));
    const nextWo = state.items[Math.min(idx, state.items.length - 1)];
    state.selectedId = nextWo ? nextWo.id : null;
    state.page = 1;
    renderList();
    renderEditor();
    toast(`Deleted ${wo.fileName}`);
  }

  /* ---------- PDF loading & rendering ---------- */
  async function loadBytes(wo) {
    const local = state.localFiles.get(wo.id);
    if (local) return new Uint8Array(await local.arrayBuffer());
    const out = new Uint8Array(wo.fileSize);
    let offset = 0;
    for (let n = 0; n < wo.partCount; n++) {
      let res;
      try {
        res = await fetch(`${API}/${wo.id}/parts/${n}`);
      } catch (e) {
        throw new Error("Network error while downloading the PDF.");
      }
      if (!res.ok) throw new Error(`Download failed (${res.status}).`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (offset + buf.length > out.length) throw new Error("Downloaded PDF data is corrupted.");
      out.set(buf, offset);
      offset += buf.length;
    }
    if (offset !== out.length) throw new Error("Downloaded PDF data is incomplete.");
    return out;
  }

  function getDoc(wo) {
    if (!state.docs.has(wo.id)) {
      const p = loadBytes(wo)
        .then((data) => {
          if (!window.pdfjsLib) throw new Error("The PDF viewer library failed to load.");
          // isEvalSupported:false hardens pdf.js against font-based script injection.
          return pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
        })
        .then((doc) => {
          detectFields(wo, doc);
          return doc;
        });
      p.catch(() => {
        state.docs.delete(wo.id);
        if (!state.fieldScan.has(wo.id) || state.fieldScan.get(wo.id) === "scanning") {
          state.fieldScan.set(wo.id, "error");
          if (current() && current().id === wo.id) renderFieldGroups(wo);
        }
      });
      state.docs.set(wo.id, p);
      if (!state.fieldScan.has(wo.id)) state.fieldScan.set(wo.id, "scanning");
    }
    return state.docs.get(wo.id);
  }

  function prettifyField(name) {
    const last = String(name).split(".").pop().replace(/\[\d+\]/g, "");
    return (
      last
        .replace(/[_-]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .trim() || String(name)
    ).slice(0, 200);
  }

  async function detectFields(wo, doc) {
    if (state.fieldScan.get(wo.id) === "done") return;
    const found = [];
    const seen = new Set();
    try {
      for (let n = 1; n <= Math.min(doc.numPages, MAX_SCAN_PAGES) && found.length < MAX_PDF_FIELDS; n++) {
        const page = await doc.getPage(n);
        const annots = await page.getAnnotations({ intent: "display" });
        annots.forEach((a) => {
          if (a.subtype !== "Widget" || a.fieldType !== "Tx" || !a.fieldName || a.hidden) return;
          const key = ("pdf:" + a.fieldName).slice(0, 200);
          if (seen.has(key) || found.length >= MAX_PDF_FIELDS) return;
          seen.add(key);
          found.push({
            key,
            label: (a.alternativeText || prettifyField(a.fieldName)).slice(0, 200),
            page: n,
            rect: a.rect,
            pdfValue: typeof a.fieldValue === "string" ? a.fieldValue : "",
          });
        });
      }
      state.fields.set(wo.id, found);
      state.fieldScan.set(wo.id, "done");
    } catch (e) {
      console.warn("PDF field scan failed", e);
      state.fieldScan.set(wo.id, "error");
    }
    if (current() && current().id === wo.id) {
      renderFieldGroups(wo);
      updatePending(wo);
      refreshOverlay();
    }
  }

  async function renderPage(doc, n, width, wo, values) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(width / base.width, 2.5) });
    const dpr = window.devicePixelRatio || 1;
    const canvas = h("canvas", { "aria-hidden": "true" });
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + "px";
    canvas.style.height = vp.height + "px";
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    const layer = h("div", { class: "wo-overlay" });
    const fig = h(
      "figure",
      { class: "wo-page" },
      h("figcaption", { class: "sr-only" }, `Page ${n} of ${doc.numPages}`),
      canvas,
      layer
    );
    fig.style.width = vp.width + "px";
    fig.style.height = vp.height + "px";
    fig._vp = vp;
    fig._page = n;
    if (values) drawOverlay(layer, wo, n, vp, values);
    return fig;
  }

  function drawOverlay(layer, wo, n, vp, values) {
    layer.replaceChildren();
    const saved = savedValues(wo);
    const isChanged = (k) => (values[k] || "") !== (saved[k] || "").trim();
    (state.fields.get(wo.id) || [])
      .filter((f) => f.page === n && values[f.key])
      .forEach((f) => {
        const [x1, y1, x2, y2] = vp.convertToViewportRectangle(f.rect);
        const box = h(
          "div",
          { class: "wo-ov-field" + (isChanged(f.key) ? " changed" : ""), title: f.label },
          values[f.key]
        );
        Object.assign(box.style, {
          left: Math.min(x1, x2) + "px",
          top: Math.min(y1, y2) + "px",
          minWidth: Math.abs(x2 - x1) + "px",
          minHeight: Math.abs(y2 - y1) + "px",
          maxWidth: Math.max(vp.width - Math.min(x1, x2), 40) + "px",
        });
        layer.append(box);
      });
    const notes = fieldDefs(wo).filter((f) => f.group !== "pdf" && values[f.key] && (f.page || 1) === n);
    if (notes.length) {
      layer.append(
        h(
          "aside",
          { class: "wo-ov-notes", "aria-label": `Comments on page ${n}` },
          h("strong", null, "Comments"),
          notes.map((f) =>
            h("div", { class: "wo-ov-note" + (isChanged(f.key) ? " changed" : "") }, h("b", null, f.label + ": "), values[f.key])
          )
        )
      );
    }
  }

  function refreshOverlay() {
    const wo = current();
    const fig = $("#woPageHost .wo-page");
    if (!wo || !fig) return;
    const layer = $(".wo-overlay", fig);
    if (state.showOverlay) drawOverlay(layer, wo, fig._page, fig._vp, draftValues(wo));
    else layer.replaceChildren();
  }

  function errorBox(msg, retry) {
    return h(
      "div",
      { class: "wo-alert", role: "alert" },
      h("p", null, msg),
      retry ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: retry }, "Retry") : null
    );
  }

  async function renderViewer(wo) {
    const host = $("#woPageHost");
    if (!host || !$("#panel-workorders").classList.contains("active")) return;
    const token = ++state.renderToken;
    const label = $("#woPageLabel");
    $("#woPrevPage").disabled = $("#woNextPage").disabled = true;
    host.replaceChildren(h("p", { class: "wo-state" }, spinner(), "Loading PDF…"));
    try {
      const doc = await getDoc(wo);
      if (token !== state.renderToken) return;
      state.page = Math.min(Math.max(1, state.page), doc.numPages);
      const fig = await renderPage(doc, state.page, host.clientWidth || 600, wo, state.showOverlay ? draftValues(wo) : null);
      if (token !== state.renderToken) return;
      host.replaceChildren(fig);
      label.textContent = `Page ${state.page} of ${doc.numPages}`;
      $("#woPrevPage").disabled = state.page <= 1;
      $("#woNextPage").disabled = state.page >= doc.numPages;
    } catch (e) {
      if (token !== state.renderToken) return;
      label.textContent = "Page –";
      host.replaceChildren(errorBox("Couldn't display this PDF: " + e.message, () => renderViewer(wo)));
    }
  }

  function goPage(delta) {
    const wo = current();
    if (!wo) return;
    state.page += delta;
    renderViewer(wo);
  }

  /* ---------- Preview & save ---------- */
  function describeChange(c) {
    if (c.kind === "wo") {
      return h(
        "li",
        { class: "wo-change changed" },
        c.before ? `Work order no. changed from ${c.before} to ${c.after || "(none)"}` : `Work order no. set to ${c.after}`
      );
    }
    if (c.kind === "added") {
      return h("li", { class: "wo-change added" }, `Comment added to ‘${c.label}’: `, h("ins", null, quote(c.after)));
    }
    if (c.kind === "removed") {
      return h("li", { class: "wo-change removed" }, `Comment removed from ‘${c.label}’: `, h("del", null, quote(c.before)));
    }
    return h(
      "li",
      { class: "wo-change changed" },
      `Comment changed in ‘${c.label}’: `,
      h("del", null, quote(c.before)),
      " → ",
      h("ins", null, quote(c.after))
    );
  }

  function openPreview(wo) {
    const modal = $("#woPreviewModal");
    const changes = changesFor(wo);
    const d = getDraft(wo);
    const woLabel = d.woNo.trim() ? `Work Order #${d.woNo.trim()}` : `Work order “${wo.fileName}”`;
    const commentCount = Object.keys(draftValues(wo)).length;
    state.preview = { id: wo.id, returnFocus: document.activeElement, saving: false };

    $("#woPreviewSummary").textContent = changes.length
      ? `${woLabel} — ${plural(changes.length, "change")} pending · ${plural(commentCount, "comment")} after saving.`
      : `${woLabel} — no pending changes. ${plural(commentCount, "comment")} will be ${
          wo.status === "submitted" ? "kept (already submitted)" : "submitted as they are"
        }.`;
    const list = $("#woPreviewChanges");
    list.replaceChildren(...(changes.length ? changes.map(describeChange) : [h("li", { class: "wo-change" }, "No changes since the last save.")]));
    $("#woPreviewError").replaceChildren();
    $("#woSaveDraft").disabled = !changes.length;
    $("#woSubmit").disabled = !changes.length && wo.status === "submitted";

    modal.classList.add("open");
    $("#woPreviewTitle").focus();
    renderPreviewPages(wo);
  }

  async function renderPreviewPages(wo) {
    const host = $("#woPreviewPages");
    host.replaceChildren(h("p", { class: "wo-state" }, spinner(), "Rendering annotated PDF…"));
    try {
      const doc = await getDoc(wo);
      const values = draftValues(wo);
      const total = Math.min(doc.numPages, MAX_PREVIEW_PAGES);
      const width = Math.max(host.clientWidth - 4, 280);
      const pages = [];
      for (let n = 1; n <= total; n++) {
        if (!state.preview || state.preview.id !== wo.id) return;
        pages.push(await renderPage(doc, n, width, wo, values));
      }
      if (!state.preview || state.preview.id !== wo.id) return;
      host.replaceChildren(...pages);
      if (doc.numPages > total) {
        host.append(h("p", { class: "wo-state" }, `Showing the first ${total} of ${doc.numPages} pages.`));
      }
    } catch (e) {
      if (!state.preview || state.preview.id !== wo.id) return;
      host.replaceChildren(
        errorBox(`PDF preview unavailable: ${e.message} The change summary is still accurate and can be saved.`, () =>
          renderPreviewPages(wo)
        )
      );
    }
  }

  function closePreview() {
    if (!state.preview || state.preview.saving) return;
    const { returnFocus } = state.preview;
    state.preview = null;
    $("#woPreviewModal").classList.remove("open");
    $("#woPreviewPages").replaceChildren();
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }

  async function save(submit) {
    const p = state.preview;
    const wo = p && state.items.find((w) => w.id === p.id);
    if (!wo || p.saving) return;
    const buttons = [$("#woSaveDraft"), $("#woSubmit"), $("#woPreviewBack"), $("#woPreviewClose")];
    const states = buttons.map((b) => b.disabled);
    const target = submit ? $("#woSubmit") : $("#woSaveDraft");
    const original = target.textContent;
    p.saving = true;
    buttons.forEach((b) => (b.disabled = true));
    target.textContent = submit ? "Submitting…" : "Saving…";
    $("#woPreviewModal .modal").setAttribute("aria-busy", "true");
    $("#woPreviewError").replaceChildren();
    try {
      const updated = await api(`/${wo.id}`, { method: "PUT", body: JSON.stringify(payloadFor(wo, submit)) });
      state.items = state.items.map((w) => (w.id === updated.id ? updated : w));
      state.drafts.delete(updated.id);
      p.saving = false;
      closePreview();
      renderList();
      renderEditor();
      const name = updated.woNo ? `WO ${updated.woNo}` : updated.fileName;
      toast(submit ? `Submitted ${name}` : `Draft saved for ${name}`);
      announce(submit ? `${name} submitted.` : `Draft saved for ${name}.`);
    } catch (e) {
      p.saving = false;
      buttons.forEach((b, i) => (b.disabled = states[i]));
      $("#woPreviewError").replaceChildren(
        h("div", { class: "wo-alert" }, h("p", null, `${submit ? "Submit" : "Save"} failed: ${e.message} Your changes are still here.`))
      );
    } finally {
      target.textContent = original;
      $("#woPreviewModal .modal").removeAttribute("aria-busy");
    }
  }

  function bindPreview() {
    const modal = $("#woPreviewModal");
    $("#woPreviewClose").addEventListener("click", closePreview);
    $("#woPreviewBack").addEventListener("click", closePreview);
    $("#woSaveDraft").addEventListener("click", () => save(false));
    $("#woSubmit").addEventListener("click", () => save(true));
    modal.addEventListener("click", (e) => e.target === modal && closePreview());
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return closePreview();
      if (e.key !== "Tab") return;
      const focusable = [...modal.querySelectorAll("button:not([disabled]), [href], input, textarea, select")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === $("#woPreviewTitle"))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  /* ---------- Upload ---------- */
  let uploadSeq = 0;

  async function validateFile(file) {
    if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
      return `“${file.name}” isn't a PDF. ${SIZE_MSG}`;
    }
    if (file.size === 0) return "This file is empty.";
    if (file.size > MAX_BYTES) return `This file is ${formatBytes(file.size)}. ${SIZE_MSG}`;
    const head = await file
      .slice(0, 1024)
      .text()
      .catch(() => "");
    if (!head.includes("%PDF-")) return "This file doesn't look like a valid PDF.";
    return "";
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const file of files) {
      const entry = { uid: ++uploadSeq, file, status: "queued", progress: 0, error: "", retryable: true };
      entry.el = buildEntryEl(entry);
      $("#woUploadQueue").append(entry.el.li);
      state.uploads.push(entry);
      const err = await validateFile(file);
      if (err) {
        entry.status = "error";
        entry.error = err;
        entry.retryable = false;
      }
      updateEntry(entry);
    }
    const bad = files.length - state.uploads.filter((u) => files.includes(u.file) && u.status === "queued").length;
    announce(`${plural(files.length - bad, "file")} queued for upload${bad ? `, ${bad} rejected` : ""}.`);
    processQueue();
  }

  function buildEntryEl(entry) {
    const bar = h("span");
    const progress = h(
      "div",
      { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": `Upload progress for ${entry.file.name}` },
      bar
    );
    const status = h("span", { class: "wo-upload-status" });
    const error = h("p", { class: "wo-upload-error", role: "alert" });
    const actions = h("span", { class: "wo-upload-actions" });
    const li = h(
      "li",
      { class: "wo-upload" },
      h("div", { class: "wo-upload-head" }, h("span", { class: "wo-upload-name" }, entry.file.name), h("span", { class: "wo-upload-size" }, formatBytes(entry.file.size))),
      progress,
      h("div", { class: "wo-upload-foot" }, status, actions),
      error
    );
    return { li, bar, progress, status, error, actions };
  }

  function updateEntry(entry) {
    const { li, bar, progress, status, error, actions } = entry.el;
    const pct = Math.round(entry.progress * 100);
    li.className = "wo-upload " + entry.status;
    bar.style.width = pct + "%";
    progress.setAttribute("aria-valuenow", String(pct));
    progress.hidden = entry.status === "error" && !entry.retryable;
    status.textContent = {
      queued: "Waiting…",
      uploading: `Uploading… ${pct}%`,
      done: "Uploaded",
      error: "Not uploaded",
    }[entry.status];
    error.textContent = entry.error;
    error.hidden = !entry.error;
    actions.replaceChildren();
    if (entry.status === "error" && entry.retryable) {
      actions.append(
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            "aria-label": `Retry upload of ${entry.file.name}`,
            onclick: () => {
              entry.status = "queued";
              entry.error = "";
              entry.progress = 0;
              updateEntry(entry);
              processQueue();
            },
          },
          "Retry"
        )
      );
    }
    if (entry.status === "done" || entry.status === "error") {
      actions.append(
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            "aria-label": `Dismiss ${entry.file.name}`,
            onclick: () => {
              state.uploads = state.uploads.filter((u) => u !== entry);
              li.remove();
              $("#woDropzone").focus();
            },
          },
          "Dismiss"
        )
      );
    }
  }

  async function processQueue() {
    if (state.uploading) return;
    state.uploading = true;
    let entry;
    while ((entry = state.uploads.find((u) => u.status === "queued"))) {
      await uploadEntry(entry);
    }
    state.uploading = false;
  }

  async function uploadEntry(entry) {
    const file = entry.file;
    entry.status = "uploading";
    entry.progress = 0;
    entry.error = "";
    updateEntry(entry);
    let created = null;
    try {
      created = await api("", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, fileSize: file.size, woNo: guessWoNo(file.name) }),
      });
      const { id, chunkSize, partCount } = created;
      for (let n = 0; n < partCount; n++) {
        const start = n * chunkSize;
        await putChunk(`${API}/${id}/parts/${n}`, file.slice(start, Math.min(start + chunkSize, file.size)), (loaded) => {
          entry.progress = Math.min((start + loaded) / file.size, 0.99);
          updateEntry(entry);
        });
      }
      const wo = await api(`/${id}/complete`, { method: "POST" });
      state.localFiles.set(wo.id, file);
      state.items = [wo, ...state.items.filter((w) => w.id !== wo.id)];
      entry.status = "done";
      entry.progress = 1;
      updateEntry(entry);
      announce(`${file.name} uploaded.`);
      if (!state.selectedId) {
        state.selectedId = wo.id;
        state.page = 1;
        renderEditor();
      }
      state.loadError = state.loaded ? state.loadError : "";
      renderList();
    } catch (e) {
      // Clean up the half-created record so it doesn't linger server-side.
      if (created) fetch(`${API}/${created.id}`, { method: "DELETE" }).catch(() => {});
      entry.status = "error";
      entry.error = e.message;
      updateEntry(entry);
    }
  }

  function bindUpload() {
    const zone = $("#woDropzone");
    const input = $("#woFileInput");
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", () => {
      addFiles(input.files);
      input.value = "";
    });
    let depth = 0;
    zone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      depth++;
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    zone.addEventListener("dragleave", () => {
      if (--depth <= 0) {
        depth = 0;
        zone.classList.remove("dragover");
      }
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove("dragover");
      addFiles(e.dataTransfer.files);
    });
    // A PDF dropped outside the zone would make the browser navigate to it and lose unsaved work.
    ["dragover", "drop"].forEach((type) =>
      window.addEventListener(type, (e) => {
        if ($("#panel-workorders").classList.contains("active") && !zone.contains(e.target)) {
          e.preventDefault();
          if (type === "drop" && e.dataTransfer.files.length) toast("Drop PDFs onto the upload area to add them.");
        }
      })
    );
  }

  /* ---------- Navigation guard & tab lifecycle ---------- */
  function onShow() {
    refreshRegisterList();
    if (!state.loaded && !state.loading) loadList();
    else {
      const wo = current();
      if (wo) {
        updateWoHint(getDraft(wo).woNo);
        renderViewer(wo);
      }
    }
  }

  function bindGuards() {
    // Capture phase: runs before app.js switches panels, so cancelling keeps the user here.
    $("#mainNav").addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest("button[data-panel]");
        if (!btn) return;
        const active = $("#panel-workorders").classList.contains("active");
        if (btn.dataset.panel === "workorders") {
          if (!active) setTimeout(onShow, 0);
          return;
        }
        if (!active) return;
        const dirty = dirtyItems().length;
        if (!dirty) return;
        const ok = confirm(
          `You have unsaved comments on ${plural(dirty, "work order")}.\n\n` +
            "They stay in this browser tab until you reload or close it, but they are not saved yet. Leave the Work Orders tab?"
        );
        if (!ok) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    window.addEventListener("beforeunload", (e) => {
      if (dirtyItems().length || state.uploading) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const wo = current();
        if (wo && $("#panel-workorders").classList.contains("active")) renderViewer(wo);
      }, 250);
    });
  }

  function init() {
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
    $("#woListRefresh").addEventListener("click", loadList);
    bindUpload();
    bindPreview();
    bindGuards();
    renderList();
    renderEditor();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
