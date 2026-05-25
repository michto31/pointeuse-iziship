// Reports module — agrégats workers × période, export XLSX + PDF.
// Endpoints exposés via api.js : GET /api/reports/data | /export/xlsx | /export/pdf
//
// Logique de calcul d'un record (jour, worker) :
//   brut_min   = max(0, departure - arrival) si departure renseigné
//                  sinon (sched_out - arrival) wrap 1440 (auto-clos legacy V1)
//   pauses_min = somme des breaks {start,end} closes (breakMinutesClosed)
//   forfait    = 60 si pauses_min === 0 ET brut_min > 0, sinon 0
//   net_min    = max(0, brut_min - pauses_min - forfait)
//
// Cohérent avec borne POST /api/clock (total_worked_minutes) et la page front
// (cBM/cBrutM/cWM/appliedForfaitM).

var XLSX = require("xlsx");
var PDFDocument = require("pdfkit");
var D = require("./data");
var slug = require("./slug").slugify;
var pdfCommon = require("./pdf-common");

var H_JSON = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

function jsonResp(obj, status) {
  return { statusCode: status || 200, headers: H_JSON, body: JSON.stringify(obj) };
}
function errResp(status, message) {
  return jsonResp({ error: message }, status);
}
function binaryResp(contentType, filename, buffer) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": 'attachment; filename="' + filename + '"',
      "Access-Control-Allow-Origin": "*"
    },
    body: buffer.toString("base64"),
    isBase64Encoded: true
  };
}

// ─── Validation params ──────────────────────────────────────────────────

function validateParams(qs) {
  var start = String(qs.start || "").trim();
  var end = String(qs.end || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    var e = new Error("start et end requis (format YYYY-MM-DD)");
    e.status = 400; throw e;
  }
  if (start > end) {
    var e2 = new Error("Plage invalide (start > end)");
    e2.status = 400; throw e2;
  }
  var typeRaw = String(qs.type || "all").toLowerCase();
  var type = (typeRaw === "cdi" || typeRaw === "cdd" || typeRaw === "interim") ? typeRaw : "all";
  var agency = qs.agency ? String(qs.agency).trim() : null;
  var workerId = qs.worker_id ? parseInt(qs.worker_id, 10) : null;
  if (workerId !== null && (isNaN(workerId) || workerId <= 0)) workerId = null;
  var groupByAgency = String(qs.group_by_agency || "false").toLowerCase() === "true";
  return { start: start, end: end, type: type, agency: agency, workerId: workerId, groupByAgency: groupByAgency };
}

// ─── Fetch + aggregate ─────────────────────────────────────────────────

async function fetchData(sql, params) {
  var where = ["r.date >= $1", "r.date <= $2"];
  var sqlParams = [params.start, params.end];
  var pi = 3;
  if (params.type !== "all") { where.push("w.type = $" + pi++); sqlParams.push(params.type); }
  if (params.agency) { where.push("w.agency = $" + pi++); sqlParams.push(params.agency); }
  if (params.workerId) { where.push("r.worker_id = $" + pi++); sqlParams.push(params.workerId); }
  var rows = await sql(
    "SELECT r.id, r.worker_id, r.date, r.arrival, r.departure, r.breaks, " +
    "w.name AS worker_name, w.type AS worker_type, w.agency AS worker_agency, " +
    "w.sched_in, w.sched_out " +
    "FROM records r JOIN workers w ON r.worker_id = w.id " +
    "WHERE " + where.join(" AND ") + " " +
    "ORDER BY w.name, r.date",
    sqlParams
  );
  // Normalize date + breaks
  return rows.map(function (r) {
    var date = typeof r.date === "string" ? r.date.substring(0, 10) : r.date;
    var brks = r.breaks;
    if (typeof brks === "string") { try { brks = JSON.parse(brks); } catch (_e) { brks = []; } }
    if (!Array.isArray(brks)) brks = [];
    return {
      id: r.id, worker_id: r.worker_id, worker_name: r.worker_name,
      worker_type: r.worker_type, worker_agency: r.worker_agency || "",
      date: date, arrival: r.arrival, departure: r.departure, breaks: brks,
      sched_in: r.sched_in || "08:00", sched_out: r.sched_out || "16:00"
    };
  });
}

function computeDayStats(record) {
  var arrMin = D.hhmmToMin(record.arrival);
  if (arrMin == null) return { brut_min: 0, pauses_min: 0, forfait_min: 0, net_min: 0, has_departure: false };
  var depMin = D.hhmmToMin(record.departure);
  var hasDeparture = (depMin != null);
  if (!hasDeparture) {
    // Auto-close à sched_out (legacy V1) si manquant
    var schedOut = D.hhmmToMin(record.sched_out);
    depMin = (schedOut != null && schedOut > arrMin) ? schedOut : (arrMin + 480);
  }
  var brut = Math.max(0, depMin - arrMin);
  var pauses = D.breakMinutesClosed(record.breaks);
  var forfait = (pauses === 0 && brut > 0) ? 60 : 0;
  var net = Math.max(0, brut - pauses - forfait);
  return { brut_min: brut, pauses_min: pauses, forfait_min: forfait, net_min: net, has_departure: hasDeparture };
}

function aggregateWorkers(records) {
  var byWorker = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (!byWorker[r.worker_id]) {
      byWorker[r.worker_id] = {
        id: r.worker_id, name: r.worker_name, type: r.worker_type, agency: r.worker_agency || "",
        brut_minutes: 0, pauses_minutes: 0, net_minutes: 0, days_worked: 0,
        days: []
      };
    }
    var w = byWorker[r.worker_id];
    var s = computeDayStats(r);
    w.brut_minutes += s.brut_min;
    w.pauses_minutes += s.pauses_min;
    w.net_minutes += s.net_min;
    if (s.has_departure) w.days_worked++;
    w.days.push({
      date: r.date, arrival: r.arrival, departure: r.departure || null,
      pauses: r.breaks,
      brut_min: s.brut_min, pauses_min: s.pauses_min, forfait_min: s.forfait_min, net_min: s.net_min,
      auto_closed: !s.has_departure
    });
  }
  // Sort workers : net desc
  var list = Object.keys(byWorker).map(function (k) { return byWorker[k]; });
  list.sort(function (a, b) { return b.net_minutes - a.net_minutes; });
  return list;
}

function computeTotals(workers) {
  var brut = 0, pauses = 0, net = 0, days = 0;
  for (var i = 0; i < workers.length; i++) {
    brut += workers[i].brut_minutes;
    pauses += workers[i].pauses_minutes;
    net += workers[i].net_minutes;
    days += workers[i].days_worked;
  }
  return {
    brut_minutes: brut, pauses_minutes: pauses, net_minutes: net,
    workers_count: workers.length, days_count: days
  };
}

function distinctAgencies(workers) {
  var seen = {};
  var out = [];
  for (var i = 0; i < workers.length; i++) {
    var a = workers[i].agency || "";
    if (!(a in seen)) { seen[a] = true; out.push(a); }
  }
  out.sort();
  return out;
}

// ─── Handler GET /api/reports/data ─────────────────────────────────────

async function handleData(event, qs, sql) {
  var params;
  try { params = validateParams(qs); } catch (e) { return errResp(e.status || 400, e.message); }
  var records = await fetchData(sql, params);
  var workers = aggregateWorkers(records);
  var totals = computeTotals(workers);
  var agencies = distinctAgencies(workers);
  return jsonResp({ workers: workers, totals: totals, agencies: agencies });
}

// ─── Helpers exports ───────────────────────────────────────────────────

function formatHM(min) {
  if (min == null || isNaN(min)) return "0h00";
  min = Math.max(0, Math.round(min));
  return Math.floor(min / 60) + "h" + String(min % 60).padStart(2, "0");
}

function exportFilenameBase(params, label) {
  var s = String(params.start).replace(/-/g, "");
  var e = String(params.end).replace(/-/g, "");
  var lbl = label ? "-" + slug(label) : "";
  return "rapport" + lbl + "-" + s + "-" + e;
}

function groupWorkersByAgency(workers) {
  // Retourne [{agencyLabel, slugLabel, workers: [...]}] avec un bucket spécial
  // "salaries-cdi-cdd" pour workers sans agence (CDI/CDD).
  var buckets = {};
  for (var i = 0; i < workers.length; i++) {
    var w = workers[i];
    var key, label;
    if (w.agency) { key = w.agency; label = w.agency; }
    else { key = "__no_agency__"; label = "Salariés CDI/CDD"; }
    if (!buckets[key]) buckets[key] = { agencyLabel: label, workers: [] };
    buckets[key].workers.push(w);
  }
  var keys = Object.keys(buckets);
  keys.sort(function (a, b) {
    // Sans agence à la fin
    if (a === "__no_agency__") return 1;
    if (b === "__no_agency__") return -1;
    return buckets[a].agencyLabel.localeCompare(buckets[b].agencyLabel);
  });
  return keys.map(function (k) { return buckets[k]; });
}

// ─── Export XLSX ───────────────────────────────────────────────────────

function buildXlsxSheet(workers, periodLabel, agencyLabel) {
  var totals = computeTotals(workers);
  var rows = [];
  rows.push(["Rapport heures — " + (agencyLabel || "Toutes agences") + " — " + periodLabel]);
  rows.push([]);
  rows.push(["RÉCAP"]);
  rows.push(["Total brut", "Total pauses", "Total net", "Workers", "Jours travaillés"]);
  rows.push([formatHM(totals.brut_minutes), formatHM(totals.pauses_minutes), formatHM(totals.net_minutes), totals.workers_count, totals.days_count]);
  rows.push([]);
  rows.push(["DÉTAILS"]);
  rows.push(["Worker", "Type", "Agence", "Brut", "Pauses", "Net", "Jours"]);
  for (var i = 0; i < workers.length; i++) {
    var w = workers[i];
    rows.push([w.name, w.type, w.agency || "", formatHM(w.brut_minutes), formatHM(w.pauses_minutes), formatHM(w.net_minutes), w.days_worked]);
    rows.push(["  Date", "Arrivée", "Départ", "Pauses (HHmm)", "Net jour"]);
    for (var d = 0; d < w.days.length; d++) {
      var day = w.days[d];
      var brks = (day.pauses || []).map(function (b) {
        if (!b || !b.start) return "";
        return b.start + (b.end ? ("→" + b.end) : "→?");
      }).filter(function (s) { return s; }).join(" / ");
      rows.push(["  " + day.date, day.arrival || "", day.departure || (day.auto_closed ? "(auto-clos)" : ""), brks || "—", formatHM(day.net_min)]);
    }
    rows.push([]);
  }
  var sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 10 }];
  return sheet;
}

async function handleXlsx(event, qs, sql) {
  var params;
  try { params = validateParams(qs); } catch (e) { return errResp(e.status || 400, e.message); }
  var records = await fetchData(sql, params);
  var workers = aggregateWorkers(records);
  if (!workers.length) return errResp(400, "Aucune donnée à exporter pour cette plage");

  var periodLabel = "du " + params.start + " au " + params.end;
  var wb = XLSX.utils.book_new();

  if (params.groupByAgency && !params.agency) {
    var buckets = groupWorkersByAgency(workers);
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      if (!b.workers.length) continue;
      var sheet = buildXlsxSheet(b.workers, periodLabel, b.agencyLabel);
      var sheetName = (slug(b.agencyLabel) || "agence").substring(0, 31);
      XLSX.utils.book_append_sheet(wb, sheet, sheetName);
    }
    var bufA = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    return binaryResp(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      exportFilenameBase(params, "toutes-agences") + ".xlsx",
      bufA
    );
  }

  var label = params.agency || (params.type !== "all" ? params.type : "");
  var sheetUnique = buildXlsxSheet(workers, periodLabel, label || null);
  XLSX.utils.book_append_sheet(wb, sheetUnique, "Rapport");
  var buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return binaryResp(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    exportFilenameBase(params, label) + ".xlsx",
    buf
  );
}

// ─── Export PDF ────────────────────────────────────────────────────────

function pdfRenderSection(doc, workers, periodLabel, agencyLabel) {
  var totals = computeTotals(workers);
  pdfCommon.drawHeader(doc);
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#1a1a1a")
    .text("Rapport heures — " + (agencyLabel || "Toutes agences"), 50, 100);
  doc.font("Helvetica").fontSize(11).fillColor("#555")
    .text(periodLabel, 50, 120);

  // Récap encadré
  var rcY = 145;
  doc.lineWidth(0.5).strokeColor("#cccccc").rect(50, rcY, 495, 60).stroke();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#1a1a1a").text("RÉCAP", 60, rcY + 8);
  doc.font("Helvetica").fontSize(10).fillColor("#333")
    .text("Brut : " + formatHM(totals.brut_minutes), 60, rcY + 26)
    .text("Pauses : " + formatHM(totals.pauses_minutes), 200, rcY + 26)
    .text("Net : " + formatHM(totals.net_minutes), 340, rcY + 26)
    .text("Workers : " + totals.workers_count + "    Jours : " + totals.days_count, 60, rcY + 44);

  var y = rcY + 80;
  doc.font("Helvetica-Bold").fontSize(11).text("DÉTAILS", 50, y);
  y += 18;

  for (var i = 0; i < workers.length; i++) {
    var w = workers[i];
    if (y > 720) { doc.addPage(); pdfCommon.drawHeader(doc); y = 100; }
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#1a1a1a")
      .text(w.name + " (" + w.type + ")" + (w.agency ? " — " + w.agency : ""), 50, y);
    y += 14;
    doc.font("Helvetica").fontSize(9).fillColor("#555")
      .text("Brut " + formatHM(w.brut_minutes) + "  •  Pauses " + formatHM(w.pauses_minutes) + "  •  Net " + formatHM(w.net_minutes) + "  •  " + w.days_worked + " j", 50, y);
    y += 16;
    // Day rows
    doc.font("Helvetica").fontSize(8).fillColor("#333");
    for (var d = 0; d < w.days.length; d++) {
      if (y > 740) { doc.addPage(); pdfCommon.drawHeader(doc); y = 100; }
      var day = w.days[d];
      var brks = (day.pauses || []).map(function (b) {
        if (!b || !b.start) return "";
        return b.start + (b.end ? ("→" + b.end) : "→?");
      }).filter(function (s) { return s; }).join(" / ") || "—";
      var depStr = day.departure || (day.auto_closed ? "(auto-clos)" : "");
      doc.text(day.date + "   " + (day.arrival || "—") + " → " + depStr + "   pauses: " + brks + "   net: " + formatHM(day.net_min), 60, y);
      y += 11;
    }
    y += 8;
  }
  pdfCommon.drawFooter(doc);
}

function streamPdf(doc) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    doc.on("data", function (c) { chunks.push(c); });
    doc.on("end", function () { resolve(Buffer.concat(chunks)); });
    doc.on("error", reject);
    doc.end();
  });
}

async function handlePdf(event, qs, sql) {
  var params;
  try { params = validateParams(qs); } catch (e) { return errResp(e.status || 400, e.message); }
  var records = await fetchData(sql, params);
  var workers = aggregateWorkers(records);
  if (!workers.length) return errResp(400, "Aucune donnée à exporter pour cette plage");

  var periodLabel = "du " + params.start + " au " + params.end;
  var doc = new PDFDocument({ size: "A4", margin: 50 });

  if (params.groupByAgency && !params.agency) {
    var buckets = groupWorkersByAgency(workers);
    for (var i = 0; i < buckets.length; i++) {
      var b = buckets[i];
      if (!b.workers.length) continue;
      if (i > 0) doc.addPage();
      pdfRenderSection(doc, b.workers, periodLabel, b.agencyLabel);
    }
    var buf = await streamPdf(doc);
    return binaryResp("application/pdf", exportFilenameBase(params, "toutes-agences") + ".pdf", buf);
  }

  var label = params.agency || (params.type !== "all" ? params.type : "");
  pdfRenderSection(doc, workers, periodLabel, label || null);
  var buf2 = await streamPdf(doc);
  return binaryResp("application/pdf", exportFilenameBase(params, label) + ".pdf", buf2);
}

module.exports = { handleData: handleData, handleXlsx: handleXlsx, handlePdf: handlePdf };
