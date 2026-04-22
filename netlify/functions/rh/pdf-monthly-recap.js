var PDFDocument = require("pdfkit");
var D = require("./data");
var slug = require("./slug").slugify;
var C = require("./constants");
var common = require("./pdf-common");
var drawHeader = common.drawHeader;
var drawFooter = common.drawFooter;

function drawCard(doc, x, y, w, h, label, value) {
  doc.rect(x, y, w, h).lineWidth(0.5).strokeColor("#e5e5e5").stroke();
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#666").text(label.toUpperCase(), x + 12, y + 12, { width: w - 24 });
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#1a1a1a").text(value, x + 12, y + 34, { width: w - 24 });
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
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#1a1a1a").text("RÉCAPITULATIF MENSUEL — " + monthLabel, 50, 120, { width: 495, align: "center" });
      doc.font("Helvetica").fontSize(13).fillColor("#444").text(worker.name || "—", 50, 152, { width: 495, align: "center" });

      if (records.length === 0) {
        doc.font("Helvetica-Oblique").fontSize(13).fillColor("#888").text("Aucune donnée pour ce mois", 50, 380, { width: 495, align: "center" });
        drawFooter(doc);
        doc.end();
        return;
      }

      // 2x3 grid of KPI cards
      var cardW = 240, cardH = 80;
      var gapX = 15, gapY = 15;
      var startX = 50, startY = 200;
      var cards = [
        { label: "Jours présents", value: String(stats.days) },
        { label: "Heures travaillées", value: D.minToHhMmLabel(stats.totalWorkedMin) },
        { label: "Heures supplémentaires", value: D.minToHhMmLabel(stats.overtimeMin) },
        { label: "Retards", value: String(stats.lateCount) },
        { label: "Pause moyenne / jour", value: stats.avgBreakMin + " min" },
        { label: "Heure moyenne d'arrivée", value: stats.avgArrivalMin != null ? D.minToHhmm(stats.avgArrivalMin) : "—" }
      ];
      for (var i = 0; i < cards.length; i++) {
        var col = i % 2;
        var row = Math.floor(i / 2);
        var x = startX + col * (cardW + gapX);
        var y = startY + row * (cardH + gapY);
        drawCard(doc, x, y, cardW, cardH, cards[i].label, cards[i].value);
      }

      // Seuil heures sup note
      doc.font("Helvetica-Oblique").fontSize(9).fillColor("#888")
        .text("Seuil heures supplémentaires : " + (C.OVERTIME_THRESHOLD_MIN / 60) + "h par jour", 50, 520, { width: 495, align: "center" });

      drawFooter(doc);
      doc.end();
    } catch (e) { reject(e); }
  }).then(function (buffer) {
    return {
      filename: "recap-mensuel-" + slug(worker.name) + "-" + periodInfo.period + ".pdf",
      contentType: "application/pdf",
      body: buffer
    };
  });
}

module.exports = { build: build };
