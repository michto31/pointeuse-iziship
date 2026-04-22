var PDFDocument = require("pdfkit");
var D = require("./data");
var slug = require("./slug").slugify;
var common = require("./pdf-common");
var drawHeader = common.drawHeader;
var drawFooter = common.drawFooter;

async function build(worker) {
  return new Promise(function (resolve, reject) {
    try {
      var doc = new PDFDocument({ size: "A4", margin: 50 });
      var chunks = [];
      doc.on("data", function (c) { chunks.push(c); });
      doc.on("end", function () { resolve(Buffer.concat(chunks)); });
      doc.on("error", reject);

      drawHeader(doc);

      doc.font("Helvetica-Bold").fontSize(20).fillColor("#1a1a1a").text("FICHE SALARIÉ", 50, 120, { width: 495, align: "center" });
      var today = new Date();
      var todayFr = String(today.getDate()).padStart(2, "0") + "/" + String(today.getMonth() + 1).padStart(2, "0") + "/" + today.getFullYear();
      doc.font("Helvetica").fontSize(11).fillColor("#666").text("Généré le " + todayFr, 50, 150, { width: 495, align: "center" });

      var rows = [
        ["Nom complet", worker.name || "—"],
        ["ID badge", worker.badge || "—"],
        ["Agence", worker.agency || "—"],
        ["Horaires prévus", (worker.sched_in || "—") + " – " + (worker.sched_out || "—")],
        ["Date de création", D.formatDateFr(worker.created_at)]
      ];

      var y = 210;
      for (var i = 0; i < rows.length; i++) {
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#666").text(rows[i][0].toUpperCase(), 70, y);
        doc.font("Helvetica").fontSize(14).fillColor("#1a1a1a").text(rows[i][1], 70, y + 14);
        y += 50;
        doc.moveTo(70, y - 8).lineTo(525, y - 8).lineWidth(0.5).strokeColor("#e5e5e5").stroke();
      }

      drawFooter(doc);
      doc.end();
    } catch (e) { reject(e); }
  }).then(function (buffer) {
    return {
      filename: "fiche-salarie-" + slug(worker.name) + "-" + new Date().toISOString().slice(0, 10) + ".pdf",
      contentType: "application/pdf",
      body: buffer
    };
  });
}

module.exports = { build: build };
