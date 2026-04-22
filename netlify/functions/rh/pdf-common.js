// Shared PDF chrome (header + footer) for all RH generators.
// Centralized here so a layout tweak (margins, font, position) happens once.

function drawHeader(doc) {
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#1a1a1a").text("IziShip", 50, 50);
  doc.moveTo(50, 85).lineTo(545, 85).lineWidth(1).strokeColor("#1a1a1a").stroke();
}

function drawFooter(doc) {
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#666")
    .text("Document généré automatiquement — IziShip RH", 50, 760, { width: 495, align: "center" });
}

module.exports = { drawHeader: drawHeader, drawFooter: drawFooter };
