/* Closeout PDF + Excel exporters */
(function (global) {
  function findObs(data, woNo) {
    return (data.observations || []).find((o) => String(o.woNo) === String(woNo));
  }

  function loadImageAsDataURL(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          resolve(c.toDataURL("image/png"));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function buildCloseoutHtml(data, woNo, logos) {
    const obs = findObs(data, woNo);
    if (!obs) throw new Error("WO not in register");
    const p = (data.photos || {})[String(woNo)] || {};
    if (!p.before || !p.during || !p.after) throw new Error("Missing photos");

    const logoKz = logos.kz || (global.HSE_LOGOS && global.HSE_LOGOS.kz) || "assets/logo-kz.png";
    const logoKh = logos.kh || (global.HSE_LOGOS && global.HSE_LOGOS.kh) || "assets/logo-khansaheb.jpeg";

    return `
      <div style="font-family:Segoe UI,Arial,sans-serif;color:#1a2332;padding:24px;width:740px;box-sizing:border-box">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #f36c21;padding-bottom:12px;margin-bottom:16px">
          <img src="${logoKz}" style="height:48px;background:#fff" />
          <div style="text-align:center">
            <div style="font-size:18px;font-weight:800;color:#0b2a4a">HSE OBSERVATION CLOSEOUT</div>
            <div style="font-size:12px;color:#5b6b7c">KFM / Khansaheb · KEZAD / Al Ma'Mourah</div>
          </div>
          <img src="${logoKh}" style="height:44px;background:#fff" />
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px">
          <tr>
            <td style="padding:6px;border:1px solid #d9e1ea;width:25%"><b>WO No</b><br>${esc(obs.woNo)}</td>
            <td style="padding:6px;border:1px solid #d9e1ea;width:25%"><b>SR No</b><br>${esc(obs.srNo || "—")}</td>
            <td style="padding:6px;border:1px solid #d9e1ea;width:25%"><b>Date</b><br>${esc(obs.date || "—")}</td>
            <td style="padding:6px;border:1px solid #d9e1ea;width:25%"><b>Risk</b><br>${esc(obs.riskLevel || "—")}</td>
          </tr>
          <tr>
            <td style="padding:6px;border:1px solid #d9e1ea" colspan="2"><b>Zone</b><br>${esc(obs.zone || "—")}</td>
            <td style="padding:6px;border:1px solid #d9e1ea" colspan="2"><b>Category</b><br>${esc(obs.category || "—")}</td>
          </tr>
          <tr>
            <td style="padding:6px;border:1px solid #d9e1ea" colspan="4"><b>Location</b><br>${esc(obs.location || "—")}</td>
          </tr>
          <tr>
            <td style="padding:6px;border:1px solid #d9e1ea" colspan="4"><b>Observation</b><br>${esc(obs.observation || "—")}</td>
          </tr>
          <tr>
            <td style="padding:6px;border:1px solid #d9e1ea" colspan="4"><b>Proposed Corrective Action</b><br>${esc(obs.correctiveAction || "—")}</td>
          </tr>
          <tr>
            <td style="padding:6px;border:1px solid #d9e1ea" colspan="2"><b>Status</b><br>${esc(obs.status || "—")}</td>
            <td style="padding:6px;border:1px solid #d9e1ea"><b>Assigned To</b><br>${esc(obs.assignedTo || "—")}</td>
            <td style="padding:6px;border:1px solid #d9e1ea"><b>Actual Close</b><br>${esc(obs.actualCloseDate || "—")}</td>
          </tr>
        </table>
        <div style="display:flex;gap:10px;justify-content:space-between">
          ${photoBlock("Before", p.before)}
          ${photoBlock("During", p.during)}
          ${photoBlock("After", p.after)}
        </div>
        <div style="margin-top:16px;font-size:10px;color:#5b6b7c;border-top:1px solid #d9e1ea;padding-top:8px">
          Generated ${new Date().toISOString().slice(0, 19)}Z · For Maximo WO attachment · Photos stored locally in app
        </div>
      </div>`;
  }

  function photoBlock(title, src) {
    return `<div style="flex:1;text-align:center">
      <div style="font-weight:800;color:#0b2a4a;font-size:12px;margin-bottom:6px">${title}</div>
      <img src="${src}" style="width:100%;height:180px;object-fit:cover;border:1px solid #d9e1ea;border-radius:6px" />
    </div>`;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function exportPdf(data, woNo) {
    if (!global.HSEStore.isCloseoutReady(data, woNo)) {
      throw new Error("WO is not closeout ready (need 3 photos + register entry)");
    }
    const host = document.getElementById("printHost");
    const html = await buildCloseoutHtml(data, woNo, global.HSE_LOGOS || {});
    host.innerHTML = html;

    // Wait for images
    await Promise.all(
      Array.from(host.querySelectorAll("img")).map(
        (img) =>
          new Promise((res) => {
            if (img.complete) return res();
            img.onload = img.onerror = () => res();
          })
      )
    );

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const el = host.firstElementChild;
    const canvas = await htmlToCanvas(el);
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const imgW = pageW - margin * 2;
    const imgH = (canvas.height * imgW) / canvas.width;
    let y = margin;
    let remaining = imgH;
    let srcY = 0;
    const pageContentH = pageH - margin * 2;

    // Simple single/multi page draw
    const scale = imgW / canvas.width;
    if (imgH <= pageContentH) {
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, imgW, imgH);
    } else {
      // Multi-page slice
      let offset = 0;
      while (offset < canvas.height) {
        if (offset > 0) pdf.addPage();
        const sliceH = Math.min(canvas.height - offset, pageContentH / scale);
        const sliceCanvas = document.createElement("canvas");
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = sliceH;
        sliceCanvas.getContext("2d").drawImage(canvas, 0, offset, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        const h = sliceH * scale;
        pdf.addImage(sliceCanvas.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, imgW, h);
        offset += sliceH;
      }
    }
    pdf.save(`HSE_Closeout_WO_${woNo}.pdf`);
    host.innerHTML = "";
  }

  function htmlToCanvas(el) {
    return new Promise((resolve, reject) => {
      // Lightweight canvas render via foreignObject SVG (works for our simple HTML)
      const w = el.scrollWidth || 740;
      const h = el.scrollHeight || 1000;
      const data = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml">${el.outerHTML}</div>
          </foreignObject>
        </svg>`;
      // foreignObject with external/data images often fails; use manual draw instead
      drawHtmlManually(el).then(resolve).catch(reject);
    });
  }

  async function drawHtmlManually(el) {
    // Render closeout by composing canvases from known structure
    const w = 794;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    // Estimate height
    canvas.width = w;
    canvas.height = 1120;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, canvas.height);

    const imgs = el.querySelectorAll("img");
    const loaded = [];
    for (const img of imgs) {
      loaded.push(await loadImg(img.src));
    }

    let y = 28;
    // logos: first two are brands, last three are photos typically
    const logoH = 48;
    if (loaded[0]) ctx.drawImage(loaded[0], 28, y, (loaded[0].width / loaded[0].height) * logoH, logoH);
    if (loaded[1]) {
      const lw = (loaded[1].width / loaded[1].height) * 44;
      ctx.drawImage(loaded[1], w - 28 - lw, y, lw, 44);
    }
    ctx.fillStyle = "#0b2a4a";
    ctx.font = "bold 18px Segoe UI, Arial";
    ctx.textAlign = "center";
    ctx.fillText("HSE OBSERVATION CLOSEOUT", w / 2, y + 22);
    ctx.font = "12px Segoe UI, Arial";
    ctx.fillStyle = "#5b6b7c";
    ctx.fillText("KFM / Khansaheb · KEZAD / Al Ma'Mourah", w / 2, y + 40);
    ctx.textAlign = "left";
    y += 70;
    ctx.strokeStyle = "#f36c21";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(w - 28, y);
    ctx.stroke();
    y += 18;

    // Pull text from obs via data attributes — re-read from table cells
    const cells = Array.from(el.querySelectorAll("td"));
    ctx.fillStyle = "#1a2332";
    ctx.font = "12px Segoe UI, Arial";
    for (const td of cells) {
      const text = td.innerText.replace(/\s+/g, " ").trim();
      const lines = wrapText(ctx, text, w - 70);
      const boxH = Math.max(36, lines.length * 15 + 12);
      ctx.strokeStyle = "#d9e1ea";
      ctx.lineWidth = 1;
      ctx.strokeRect(28, y, w - 56, boxH);
      let ty = y + 16;
      for (const line of lines) {
        ctx.fillText(line, 36, ty);
        ty += 15;
      }
      y += boxH;
      if (y > 700) break;
    }

    y += 16;
    const photoImgs = loaded.slice(-3);
    const titles = ["Before", "During", "After"];
    const gap = 12;
    const pw = (w - 56 - gap * 2) / 3;
    const ph = 180;
    photoImgs.forEach((img, i) => {
      const x = 28 + i * (pw + gap);
      ctx.fillStyle = "#0b2a4a";
      ctx.font = "bold 12px Segoe UI, Arial";
      ctx.textAlign = "center";
      ctx.fillText(titles[i], x + pw / 2, y);
      ctx.textAlign = "left";
      if (img) {
        // cover fit
        const scale = Math.max(pw / img.width, ph / img.height);
        const sw = pw / scale;
        const sh = ph / scale;
        const sx = (img.width - sw) / 2;
        const sy = (img.height - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh, x, y + 8, pw, ph);
      }
      ctx.strokeStyle = "#d9e1ea";
      ctx.strokeRect(x, y + 8, pw, ph);
    });
    y += ph + 40;
    ctx.fillStyle = "#5b6b7c";
    ctx.font = "10px Segoe UI, Arial";
    ctx.fillText("Generated " + new Date().toISOString().slice(0, 19) + "Z · For Maximo WO attachment", 28, y);

    // Crop canvas to used height
    const out = document.createElement("canvas");
    out.width = w;
    out.height = Math.min(canvas.height, y + 30);
    out.getContext("2d").drawImage(canvas, 0, 0);
    return out;
  }

  function wrapText(ctx, text, maxW) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  function loadImg(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function exportExcel(data, woNo) {
    if (!global.HSEStore.isCloseoutReady(data, woNo)) {
      throw new Error("WO is not closeout ready (need 3 photos + register entry)");
    }
    const obs = findObs(data, woNo);
    const p = (data.photos || {})[String(woNo)] || {};
    const ExcelJS = global.ExcelJS;
    const wb = new ExcelJS.Workbook();
    wb.creator = "KFM HSE Dashboard";
    const ws = wb.addWorksheet("Closeout");

    ws.mergeCells("A1:F1");
    ws.getCell("A1").value = "HSE OBSERVATION CLOSEOUT — KFM / Khansaheb · KEZAD / Al Ma'Mourah";
    ws.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF0B2A4A" } };
    ws.getCell("A1").alignment = { vertical: "middle" };
    ws.getRow(1).height = 28;

    // Try embed logos
    try {
      let kz, kh;
      if (global.HSE_LOGOS && global.HSE_LOGOS.kz) {
        kz = dataUrlToArrayBuffer(global.HSE_LOGOS.kz);
        kh = dataUrlToArrayBuffer(global.HSE_LOGOS.kh);
      } else {
        kz = await fetchBinary("assets/logo-kz.png");
        kh = await fetchBinary("assets/logo-khansaheb.jpeg");
      }
      const kzId = wb.addImage({ buffer: kz, extension: "png" });
      const khId = wb.addImage({ buffer: kh, extension: "jpeg" });
      ws.addImage(kzId, { tl: { col: 0, row: 1 }, ext: { width: 160, height: 45 } });
      ws.addImage(khId, { tl: { col: 4, row: 1 }, ext: { width: 150, height: 42 } });
      ws.getRow(2).height = 50;
    } catch (e) {
      console.warn("Logo embed skipped", e);
    }

    const fields = [
      ["Work Order Number", obs.woNo],
      ["SR Number", obs.srNo || ""],
      ["Date", obs.date || ""],
      ["Zone", obs.zone || ""],
      ["Location", obs.location || ""],
      ["Latitude", obs.lat ?? ""],
      ["Longitude", obs.lng ?? ""],
      ["Observation", obs.observation || ""],
      ["Category", obs.category || ""],
      ["Risk Level", obs.riskLevel || ""],
      ["Proposed Corrective Action", obs.correctiveAction || ""],
      ["Status", obs.status || ""],
      ["Raised By", obs.raisedBy || ""],
      ["Assigned To", obs.assignedTo || ""],
      ["Target Close Date", obs.targetCloseDate || ""],
      ["Actual Close Date", obs.actualCloseDate || ""],
      ["Remarks", obs.remarks || ""],
    ];
    let row = 4;
    ws.getColumn(1).width = 28;
    ws.getColumn(2).width = 70;
    for (const [k, v] of fields) {
      ws.getCell(row, 1).value = k;
      ws.getCell(row, 1).font = { bold: true, color: { argb: "FF0B2A4A" } };
      ws.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4F8" } };
      ws.mergeCells(row, 2, row, 6);
      ws.getCell(row, 2).value = v;
      ws.getCell(row, 2).alignment = { wrapText: true };
      row++;
    }

    row += 1;
    ws.getCell(row, 1).value = "Closeout Photographs";
    ws.getCell(row, 1).font = { bold: true, size: 12, color: { argb: "FFF36C21" } };
    row += 1;
    ws.getCell(row, 1).value = "Before";
    ws.getCell(row, 3).value = "During";
    ws.getCell(row, 5).value = "After";
    ["A", "C", "E"].forEach((c) => {
      ws.getCell(`${c}${row}`).font = { bold: true };
    });
    row += 1;

    const slots = [
      { key: "before", col: 0 },
      { key: "during", col: 2 },
      { key: "after", col: 4 },
    ];
    for (const s of slots) {
      const buf = dataUrlToArrayBuffer(p[s.key]);
      const ext = p[s.key].startsWith("data:image/png") ? "png" : "jpeg";
      const id = wb.addImage({ buffer: buf, extension: ext });
      ws.addImage(id, {
        tl: { col: s.col, row: row - 1 },
        ext: { width: 220, height: 160 },
      });
    }
    ws.getRow(row).height = 130;
    row += 2;
    ws.getCell(row, 1).value = "Generated " + new Date().toISOString() + " · Attach to Maximo WO";
    ws.getCell(row, 1).font = { size: 9, color: { argb: "FF5B6B7C" } };

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `HSE_Closeout_WO_${woNo}.xlsx`);
  }

  async function fetchBinary(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch " + url);
    return await res.arrayBuffer();
  }

  function dataUrlToArrayBuffer(dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error("Invalid data URL");
    const bin = atob(m[2]);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  }

  async function batchExportReady(data) {
    const wos = (data.observations || [])
      .map((o) => String(o.woNo))
      .filter((wo, i, arr) => wo && arr.indexOf(wo) === i && global.HSEStore.isCloseoutReady(data, wo));
    if (!wos.length) throw new Error("No closeout-ready WOs");
    for (const wo of wos) {
      await exportPdf(data, wo);
      await exportExcel(data, wo);
      await delay(400);
    }
    return wos.length;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  global.HSEExport = { exportPdf, exportExcel, batchExportReady, findObs };
})(window);
