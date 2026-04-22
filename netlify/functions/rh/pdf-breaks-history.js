var PDFDocument = require("pdfkit");
var D = require("./data");
var slug = require("./slug").slugify;
var C = require("./constants");
var common = require("./pdf-common");
var drawHeader = common.drawHeader;
var drawFooter = common.drawFooter;

function drawTableHeader(doc, y, cols) {
  var x = 50;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#666");
  for (var i = 0; i < cols.length; i++) {
    doc.text(cols[i].label.toUpperCase(), x, y, { width: cols[i].width });
    x += cols[i].width;
  }
  doc.moveTo(50, y + 16).lineTo(545, y + 16).lineWidth(0.5).strokeColor("#1a1a1a").stroke();
  return y + 22;
}

function drawRow(doc, y, cols, values) {
  var x = 50;
  doc.font("Helvetica").fontSize(11).fillColor("#1a1a1a");
  for (var i = 0; i < cols.length; i++) {
    doc.text(values[i] != null ? String(values[i]) : "—", x, y, { width: cols[i].width });
    x += cols[i].width;
  }
  doc.moveTo(50, y + 16).lineTo(545, y + 16).lineWidth(0.25).strokeColor("#e5e5e5").stroke();
  return y + 20;
}

async function build(worker, records, periodInfo) {
  var stats = D.computeStats(worker, records);
  return new Promise(function (resolve, reject) {
    try {
      var doc = new PDFDocument({ size: "A4", margin: 50 });
      var chunks = [];
      doc.on("data", function (c) { chunks.push(c); });
      doc.on("end", function () { resolve(Buffer.concat(chunks)); });
      doc.on("error", reject);

      drawHeader(doc);

      var monthLabel = C.MONTHS_FR[periodInfo.monthIndex] + " " + periodInfo.year;
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#1a1a1a").text("PAUSES & RETARDS — " + monthLabel, 50, 120, { width: 495, align: "center" });
      doc.font("Helvetica").fontSize(13).fillColor("#444").text(worker.name || "—", 50, 152, { width: 495, align: "center" });

      // Section 1: Pauses
      var y = 200;
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#1a1a1a").text("Pauses prises", 50, y);
      y += 24;

      if (stats.breakList.length === 0) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#888").text("Aucune pause enregistrée pour ce mois", 50, y);
        y += 30;
      } else {
        var pauseCols = [
          { label: "Date", width: 120 },
          { label: "Début", width: 100 },
          { label: "Fin", width: 100 },
          { label: "Durée", width: 175 }
        ];
        y = drawTableHeader(doc, y, pauseCols);
        for (var i = 0; i < stats.breakList.length; i++) {
          if (y > 720) { doc.addPage(); drawHeader(doc); y = 120; y = drawTableHeader(doc, y, pauseCols); }
          var b = stats.breakList[i];
          var durLabel = b.duration_min != null ? D.minToHhmm(b.duration_min) : "en cours";
          var endLabel = b.end || "en cours";
          y = drawRow(doc, y, pauseCols, [D.formatDateFr(b.date), b.start, endLabel, durLabel]);
        }
        y += 10;
      }

      // Section 2: Retards
      if (y > 660) { doc.addPage(); drawHeader(doc); y = 120; }
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#1a1a1a").text("Retards", 50, y);
      y += 24;

      if (stats.lateList.length === 0) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#888").text("Aucun retard enregistré pour ce mois", 50, y);
      } else {
        var lateCols = [
          { label: "Date", width: 120 },
          { label: "Arrivée", width: 100 },
          { label: "Prévue", width: 100 },
          { label: "Retard (min)", width: 175 }
        ];
        y = drawTableHeader(doc, y, lateCols);
        for (var j = 0; j < stats.lateList.length; j++) {
          if (y > 720) { doc.addPage(); drawHeader(doc); y = 120; y = drawTableHeader(doc, y, lateCols); }
          var l = stats.lateList[j];
          y = drawRow(doc, y, lateCols, [D.formatDateFr(l.date), l.arrival, l.sched_in, String(l.late_min)]);
        }
      }

      drawFooter(doc);
      doc.end();
    } catch (e) { reject(e); }
  }).then(function (buffer) {
    return {
      filename: "pauses-retards-" + slug(worker.name) + "-" + periodInfo.period + ".pdf",
      contentType: "application/pdf",
      body: buffer
    };
  });
}

module.exports = { build: build };
