/* KFM HSE Observations — main app */
(function () {
  const state = {
    data: null,
    map: null,
    markers: [],
    charts: {},
    mapReady: false,
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => t.classList.remove("show"), 3200);
  }

  function persist() {
    const ok = HSEStore.save(state.data);
    if (!ok) toast("Could not save — browser storage may be full (large photos). Export JSON backup.");
    return ok;
  }

  function init() {
    state.data = HSEStore.load();
    bindNav();
    bindHeader();
    bindRegister();
    bindPhotos();
    bindDashboard();
    renderAll();
  }

  function renderAll() {
    renderDashboard();
    renderRegister();
    renderWoSelect();
    renderPhotoPanel();
    renderWoPhotoList();
    if ($("#panel-map").classList.contains("active")) renderMap();
  }

  /* ---------- Nav ---------- */
  function bindNav() {
    $$("#mainNav button").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$("#mainNav button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        $$(".panel").forEach((p) => p.classList.remove("active"));
        const id = "panel-" + btn.dataset.panel;
        $("#" + id).classList.add("active");
        if (btn.dataset.panel === "map") {
          setTimeout(renderMap, 50);
        }
        if (btn.dataset.panel === "dashboard") {
          setTimeout(() => {
            Object.values(state.charts).forEach((c) => c.resize());
          }, 50);
        }
      });
    });
  }

  function bindHeader() {
    $("#btnResetSeed").addEventListener("click", () => {
      if (!confirm("Reset to seed data? This clears all edits and uploaded photos in this browser.")) return;
      state.data = HSEStore.reset();
      renderAll();
      toast("Reset to seed (20 observations, target 40).");
    });
    $("#btnExportData").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "hse-observations-backup.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  /* ---------- Dashboard ---------- */
  function bindDashboard() {
    $("#targetInput").value = state.data.target || 40;
    $("#btnSaveTarget").addEventListener("click", () => {
      const v = parseInt($("#targetInput").value, 10);
      if (!v || v < 1) return toast("Enter a valid target");
      state.data.target = v;
      persist();
      renderDashboard();
      toast("Target saved: " + v);
    });
  }

  function daysBetween(a, b) {
    const ms = b - a;
    return Math.floor(ms / 86400000);
  }

  function renderDashboard() {
    const obs = state.data.observations || [];
    const target = state.data.target || 40;
    $("#targetInput").value = target;
    const total = obs.length;
    const pct = target ? Math.round((total / target) * 1000) / 10 : 0;
    const achieved = total >= target;
    const statusCounts = countBy(obs, (o) => o.status || "Open");
    const riskCounts = countBy(obs, (o) => o.riskLevel || "Unknown");
    const catCounts = countBy(obs, (o) => o.category || "Uncategorised");
    const zoneCounts = countBy(obs, (o) => o.zone || "Unknown");

    const ready = uniqueWos(obs).filter((wo) => HSEStore.isCloseoutReady(state.data, wo)).length;
    const openHigh = obs.filter(
      (o) => o.riskLevel === "High" && (o.status === "Open" || o.status === "In Progress")
    );
    const missingGps = obs.filter((o) => o.lat == null || o.lng == null).length;
    const missingWo = obs.filter((o) => !o.woNo).length;
    const missingDates = obs.filter((o) => !o.date).length;

    const today = new Date();
    const ageing = obs
      .filter((o) => o.date && (o.status === "Open" || o.status === "In Progress"))
      .map((o) => ({ o, age: daysBetween(new Date(o.date), today) }))
      .sort((a, b) => b.age - a.age)
      .slice(0, 8);

    $("#kpiRow").innerHTML = `
      <div class="card kpi accent">
        <div class="label">Observations raised</div>
        <div class="value">${total}</div>
        <div class="sub">Seed / register total</div>
      </div>
      <div class="card kpi accent">
        <div class="label">Target</div>
        <div class="value">${target}</div>
        <div class="sub">Cumulative</div>
      </div>
      <div class="card kpi accent">
        <div class="label">% of target</div>
        <div class="value">${pct}%</div>
        <div class="progress ${achieved ? "" : "below"}"><span style="width:${Math.min(pct, 100)}%"></span></div>
        <div class="sub"><span class="badge ${achieved ? "ok" : "warn"}">${achieved ? "Achieved" : "Below target"}</span></div>
      </div>
      <div class="card kpi">
        <div class="label">Closeout ready</div>
        <div class="value">${ready}</div>
        <div class="sub">WOs with 3 photos</div>
      </div>
      <div class="card kpi">
        <div class="label">Open high-risk</div>
        <div class="value">${openHigh.length}</div>
        <div class="sub">Open / In Progress</div>
      </div>
      <div class="card kpi">
        <div class="label">With GPS</div>
        <div class="value">${total - missingGps}</div>
        <div class="sub">${missingGps} off map</div>
      </div>`;

    $("#openHighList").innerHTML = openHigh.length
      ? openHigh
          .map(
            (o) =>
              `<li><strong>WO ${esc(o.woNo)}</strong> · ${esc(o.zone)} · ${esc(trunc(o.observation, 90))}</li>`
          )
          .join("")
      : "<li>None</li>";

    $("#closeoutReadySummary").innerHTML = `<strong>${ready}</strong> of ${uniqueWos(obs).length} unique WOs are closeout ready.`;

    const flags = [];
    if (total < target) flags.push(`<span class="badge warn">Below target (${total}/${target})</span>`);
    else flags.push(`<span class="badge ok">Target met</span>`);
    if (missingGps) flags.push(`<span class="badge warn">${missingGps} missing GPS</span>`);
    if (missingWo) flags.push(`<span class="badge bad">${missingWo} missing WO</span>`);
    if (missingDates) flags.push(`<span class="badge warn">${missingDates} missing date</span>`);
    if (ready === 0) flags.push(`<span class="badge warn">0 closeouts ready — upload photos</span>`);
    $("#dqFlags").innerHTML = flags.join("");

    $("#ageingList").innerHTML = ageing.length
      ? ageing
          .map(
            (x) =>
              `<li><strong>WO ${esc(x.o.woNo)}</strong> · ${x.age} day(s) · ${esc(x.o.status)} · ${esc(x.o.riskLevel)}</li>`
          )
          .join("")
      : "<li>No dated open items</li>";

    renderCharts(statusCounts, riskCounts, catCounts, zoneCounts);
  }

  function renderCharts(statusCounts, riskCounts, catCounts, zoneCounts) {
    const mk = (id, type, labels, values, colors) => {
      const ctx = $("#" + id);
      if (state.charts[id]) state.charts[id].destroy();
      state.charts[id] = new Chart(ctx, {
        type,
        data: {
          labels,
          datasets: [
            {
              data: values,
              backgroundColor: colors,
              borderWidth: type === "bar" ? 0 : 2,
              borderColor: "#fff",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: type === "doughnut" || type === "pie", position: "bottom" } },
          scales:
            type === "bar"
              ? {
                  x: { ticks: { maxRotation: 45, minRotation: 0, font: { size: 10 } } },
                  y: { beginAtZero: true, ticks: { precision: 0 } },
                }
              : undefined,
        },
      });
    };

    mk(
      "chartStatus",
      "doughnut",
      Object.keys(statusCounts),
      Object.values(statusCounts),
      ["#1565c0", "#f9a825", "#2e7d32", "#607d8b", "#90a4ae"]
    );
    mk(
      "chartRisk",
      "pie",
      Object.keys(riskCounts),
      Object.values(riskCounts),
      Object.keys(riskCounts).map((k) =>
        k === "High" ? "#c62828" : k === "Medium" ? "#ef6c00" : k === "Low" ? "#2e7d32" : "#90a4ae"
      )
    );
    const cats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
    mk(
      "chartCategory",
      "bar",
      cats.map((c) => trunc(c[0], 28)),
      cats.map((c) => c[1]),
      cats.map(() => "#123a62")
    );
    const zones = Object.entries(zoneCounts).sort((a, b) => a[0].localeCompare(b[0]));
    mk(
      "chartZone",
      "bar",
      zones.map((z) => z[0]),
      zones.map((z) => z[1]),
      zones.map(() => "#f36c21")
    );
  }

  /* ---------- Register ---------- */
  function bindRegister() {
    $("#btnAddObs").addEventListener("click", () => openObsModal(null));
    $("#btnCloseModal").addEventListener("click", closeObsModal);
    $("#btnCancelObs").addEventListener("click", closeObsModal);
    $("#obsModal").addEventListener("click", (e) => {
      if (e.target === $("#obsModal")) closeObsModal();
    });
    $("#obsForm").addEventListener("submit", onSaveObs);
    $("#btnDeleteObs").addEventListener("click", onDeleteObs);
    ["searchObs", "filterStatus", "filterRisk", "filterZone"].forEach((id) => {
      $("#" + id).addEventListener("input", renderRegister);
      $("#" + id).addEventListener("change", renderRegister);
    });
  }

  function renderRegister() {
    const zones = [...new Set((state.data.observations || []).map((o) => o.zone).filter(Boolean))].sort();
    const fz = $("#filterZone");
    const cur = fz.value;
    fz.innerHTML = '<option value="">All zones</option>' + zones.map((z) => `<option>${esc(z)}</option>`).join("");
    fz.value = cur;

    const q = ($("#searchObs").value || "").toLowerCase().trim();
    const st = $("#filterStatus").value;
    const rk = $("#filterRisk").value;
    const zn = $("#filterZone").value;

    let rows = state.data.observations || [];
    rows = rows.filter((o) => {
      if (st && o.status !== st) return false;
      if (rk && o.riskLevel !== rk) return false;
      if (zn && o.zone !== zn) return false;
      if (q) {
        const hay = [o.woNo, o.srNo, o.location, o.observation, o.category, o.zone].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(a.woNo).localeCompare(String(b.woNo)));

    const tb = $("#obsTable tbody");
    tb.innerHTML = rows
      .map((o) => {
        const gps = o.lat != null && o.lng != null ? `${o.lat}, ${o.lng}` : "—";
        return `<tr>
          <td>${esc(o.date || "")}</td>
          <td>${esc(o.zone || "")}</td>
          <td><strong>${esc(o.woNo || "")}</strong></td>
          <td>${esc(o.srNo || "")}</td>
          <td>${esc(trunc(o.location, 48))}</td>
          <td>${esc(trunc(o.category, 32))}</td>
          <td><span class="badge ${esc((o.riskLevel || "").toLowerCase())}">${esc(o.riskLevel || "")}</span></td>
          <td><span class="badge ${statusClass(o.status)}">${esc(o.status || "")}</span></td>
          <td>${esc(gps)}</td>
          <td class="actions">
            <button class="btn btn-ghost btn-sm" data-edit="${esc(o.id)}">Edit</button>
          </td>
        </tr>`;
      })
      .join("");

    $$("[data-edit]", tb).forEach((btn) => {
      btn.addEventListener("click", () => {
        const o = state.data.observations.find((x) => x.id === btn.dataset.edit);
        openObsModal(o);
      });
    });
  }

  function statusClass(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s+/g, "");
  }

  function openObsModal(obs) {
    $("#obsModalTitle").textContent = obs ? "Edit observation" : "Add observation";
    $("#btnDeleteObs").style.display = obs ? "inline-flex" : "none";
    const f = {
      id: obs?.id || "",
      date: obs?.date || new Date().toISOString().slice(0, 10),
      zone: obs?.zone || "",
      woNo: obs?.woNo || "",
      srNo: obs?.srNo || "",
      location: obs?.location || "",
      lat: obs?.lat ?? "",
      lng: obs?.lng ?? "",
      observation: obs?.observation || "",
      category: obs?.category || "",
      riskLevel: obs?.riskLevel || "Medium",
      correctiveAction: obs?.correctiveAction || "",
      status: obs?.status || "Open",
      raisedBy: obs?.raisedBy || "",
      assignedTo: obs?.assignedTo || "",
      targetCloseDate: obs?.targetCloseDate || "",
      actualCloseDate: obs?.actualCloseDate || "",
      remarks: obs?.remarks || "",
    };
    Object.keys(f).forEach((k) => {
      const el = $("#f_" + k);
      if (el) el.value = f[k];
    });
    $("#obsModal").classList.add("open");
  }

  function closeObsModal() {
    $("#obsModal").classList.remove("open");
  }

  function onSaveObs(e) {
    e.preventDefault();
    const id = $("#f_id").value || "obs-" + Date.now();
    const latRaw = $("#f_lat").value;
    const lngRaw = $("#f_lng").value;
    const row = {
      id,
      sno: null,
      date: $("#f_date").value,
      zone: $("#f_zone").value,
      location: $("#f_location").value.trim(),
      lat: latRaw === "" ? null : Number(latRaw),
      lng: lngRaw === "" ? null : Number(lngRaw),
      observation: $("#f_observation").value.trim(),
      category: $("#f_category").value.trim(),
      riskLevel: $("#f_riskLevel").value,
      correctiveAction: $("#f_correctiveAction").value.trim(),
      srNo: $("#f_srNo").value.trim(),
      woNo: $("#f_woNo").value.trim(),
      status: $("#f_status").value,
      raisedBy: $("#f_raisedBy").value.trim(),
      assignedTo: $("#f_assignedTo").value.trim(),
      targetCloseDate: $("#f_targetCloseDate").value,
      actualCloseDate: $("#f_actualCloseDate").value,
      remarks: $("#f_remarks").value.trim(),
    };
    if (Number.isNaN(row.lat)) row.lat = null;
    if (Number.isNaN(row.lng)) row.lng = null;

    const idx = state.data.observations.findIndex((o) => o.id === id);
    if (idx >= 0) state.data.observations[idx] = { ...state.data.observations[idx], ...row };
    else {
      row.sno = state.data.observations.length + 1;
      state.data.observations.push(row);
    }
    persist();
    closeObsModal();
    renderAll();
    toast("Observation saved");
  }

  function onDeleteObs() {
    const id = $("#f_id").value;
    if (!id) return;
    if (!confirm("Delete this observation?")) return;
    state.data.observations = state.data.observations.filter((o) => o.id !== id);
    persist();
    closeObsModal();
    renderAll();
    toast("Deleted");
  }

  /* ---------- Map ---------- */
  function renderMap() {
    const withGps = (state.data.observations || []).filter((o) => o.lat != null && o.lng != null);
    if (!state.map) {
      // Fix default icon paths for local leaflet
      delete L.Icon.Default.prototype._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "lib/images/marker-icon-2x.png",
        iconUrl: "lib/images/marker-icon.png",
        shadowUrl: "lib/images/marker-shadow.png",
      });
      state.map = L.map("map");
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }).addTo(state.map);
      state.mapReady = true;
    }
    state.markers.forEach((m) => state.map.removeLayer(m));
    state.markers = [];

    const riskColor = { High: "#c62828", Medium: "#ef6c00", Low: "#2e7d32" };
    withGps.forEach((o) => {
      const color = riskColor[o.riskLevel] || "#1565c0";
      const marker = L.circleMarker([o.lat, o.lng], {
        radius: 9,
        color: "#fff",
        weight: 2,
        fillColor: color,
        fillOpacity: 0.92,
      }).addTo(state.map);
      marker.bindPopup(
        `<strong>WO ${esc(o.woNo)}</strong><br>${esc(o.location)}<br>Status: ${esc(o.status)}<br>Risk: ${esc(o.riskLevel)}`
      );
      state.markers.push(marker);
    });

    if (withGps.length) {
      const g = L.featureGroup(state.markers);
      state.map.fitBounds(g.getBounds().pad(0.2));
    } else {
      state.map.setView([24.74, 54.74], 12);
    }
    setTimeout(() => state.map.invalidateSize(), 100);

    $("#gmapsLinks").innerHTML = withGps.length
      ? withGps
          .map((o) => {
            const url = `https://www.google.com/maps?q=${o.lat},${o.lng}`;
            return `<a href="${url}" target="_blank" rel="noopener">WO ${esc(o.woNo)} · ${esc(o.zone)} · ${o.lat}, ${o.lng} ↗</a>`;
          })
          .join("")
      : "<p style='color:var(--muted)'>No GPS pins yet.</p>";
  }

  /* ---------- Photos ---------- */
  function bindPhotos() {
    $("#woSelect").addEventListener("change", renderPhotoPanel);
    ["before", "during", "after"].forEach((slot) => {
      $("#file-" + slot).addEventListener("change", (e) => onPhotoFile(slot, e));
      $$(`[data-clear="${slot}"]`).forEach((btn) =>
        btn.addEventListener("click", () => {
          const wo = $("#woSelect").value;
          if (!wo) return;
          if (!state.data.photos[wo]) state.data.photos[wo] = {};
          delete state.data.photos[wo][slot];
          persist();
          renderPhotoPanel();
          renderWoPhotoList();
          renderDashboard();
          toast("Cleared " + slot);
        })
      );
    });
    $("#btnExportPdf").addEventListener("click", async () => {
      const wo = $("#woSelect").value;
      try {
        await HSEExport.exportPdf(state.data, wo);
        toast("PDF downloaded for WO " + wo);
      } catch (err) {
        toast(String(err.message || err));
      }
    });
    $("#btnExportXlsx").addEventListener("click", async () => {
      const wo = $("#woSelect").value;
      try {
        await HSEExport.exportExcel(state.data, wo);
        toast("Excel downloaded for WO " + wo);
      } catch (err) {
        toast(String(err.message || err));
      }
    });
    $("#btnBatchExport").addEventListener("click", async () => {
      try {
        const n = await HSEExport.batchExportReady(state.data);
        toast("Batch exported " + n + " WO(s)");
      } catch (err) {
        toast(String(err.message || err));
      }
    });
  }

  function renderWoSelect() {
    const wos = uniqueWos(state.data.observations || []);
    const sel = $("#woSelect");
    const cur = sel.value;
    sel.innerHTML = wos.map((w) => `<option value="${esc(w)}">WO ${esc(w)}</option>`).join("");
    if (cur && wos.includes(cur)) sel.value = cur;
    else if (wos.includes("2933872")) sel.value = "2933872";
  }

  function renderPhotoPanel() {
    const wo = $("#woSelect").value;
    const obs = (state.data.observations || []).find((o) => String(o.woNo) === String(wo));
    const p = (state.data.photos || {})[wo] || {};
    const ready = HSEStore.isCloseoutReady(state.data, wo);

    $("#woMeta").innerHTML = obs
      ? `<div><strong>WO ${esc(obs.woNo)}</strong> · SR ${esc(obs.srNo || "—")} · ${esc(obs.zone)} · 
         <span class="badge ${esc((obs.riskLevel || "").toLowerCase())}">${esc(obs.riskLevel)}</span>
         <span class="badge ${statusClass(obs.status)}">${esc(obs.status)}</span></div>
         <div style="margin-top:.35rem;color:var(--muted);font-size:.9rem">${esc(obs.location)}</div>
         <div style="margin-top:.35rem;font-size:.9rem">${esc(trunc(obs.observation, 160))}</div>`
      : "<em>Select a WO</em>";

    const badge = $("#readyBadge");
    badge.textContent = ready ? "Closeout Ready" : "Not closeout ready";
    badge.className = "ready-pill " + (ready ? "yes" : "no");

    ["before", "during", "after"].forEach((slot) => {
      const img = $("#img-" + slot);
      const slotEl = $(`.photo-slot[data-slot="${slot}"]`);
      if (p[slot]) {
        img.src = p[slot];
        img.style.display = "block";
        slotEl.classList.add("has-image");
      } else {
        img.removeAttribute("src");
        img.style.display = "none";
        slotEl.classList.remove("has-image");
      }
    });

    $("#btnExportPdf").disabled = !ready;
    $("#btnExportXlsx").disabled = !ready;
    const anyReady = uniqueWos(state.data.observations || []).some((w) => HSEStore.isCloseoutReady(state.data, w));
    $("#btnBatchExport").disabled = !anyReady;
  }

  function renderWoPhotoList() {
    const wos = uniqueWos(state.data.observations || []);
    $("#woPhotoList").innerHTML = wos
      .map((wo) => {
        const st = HSEStore.photoStatus(state.data, wo);
        const obs = state.data.observations.find((o) => String(o.woNo) === wo);
        return `<div class="wo-card">
          <header>
            <div><strong>WO ${esc(wo)}</strong> · ${esc(obs?.zone || "")} · ${esc(obs?.riskLevel || "")}</div>
            <span class="ready-pill ${st.ready ? "yes" : "no"}">${st.ready ? "Ready" : "Incomplete"}</span>
          </header>
          <div style="font-size:.85rem;color:var(--muted)">
            Before: ${st.before ? "✓" : "—"} · During: ${st.during ? "✓" : "—"} · After: ${st.after ? "✓" : "—"}
            ${wo === "2933872" || wo === "2933877" ? " · <em>had CONTROL photo paths (not bundled)</em>" : ""}
          </div>
        </div>`;
      })
      .join("");
  }

  function onPhotoFile(slot, e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    const wo = $("#woSelect").value;
    if (!file || !wo) return;
    if (!file.type.startsWith("image/")) return toast("Please select an image file");
    const reader = new FileReader();
    reader.onload = () => {
      resizeDataUrl(reader.result, 1600, 0.82).then((dataUrl) => {
        if (!state.data.photos[wo]) state.data.photos[wo] = {};
        state.data.photos[wo][slot] = dataUrl;
        const ok = persist();
        renderPhotoPanel();
        renderWoPhotoList();
        renderDashboard();
        toast(ok ? `Saved ${slot} photo for WO ${wo}` : "Saved in memory but storage may be full");
      });
    };
    reader.readAsDataURL(file);
  }

  function resizeDataUrl(dataUrl, maxSide, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  /* ---------- helpers ---------- */
  function countBy(arr, fn) {
    const o = {};
    arr.forEach((x) => {
      const k = fn(x) || "Unknown";
      o[k] = (o[k] || 0) + 1;
    });
    return o;
  }
  function uniqueWos(obs) {
    return [...new Set(obs.map((o) => String(o.woNo)).filter(Boolean))];
  }
  function trunc(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
