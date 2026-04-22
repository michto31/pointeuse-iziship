var data = require("./data");
var pdfProfile = require("./pdf-profile");
var pdfMonthlyRecap = require("./pdf-monthly-recap");
var pdfBreaksHistory = require("./pdf-breaks-history");
var excelHours = require("./excel-hours");

var DOC_TYPES = ["worker_profile", "monthly_recap", "breaks_history", "hours_excel"];
var NEEDS_PERIOD = { monthly_recap: true, breaks_history: true, hours_excel: true };

function errResp(status, message) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({ error: message })
  };
}

function binaryResp(result) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": 'attachment; filename="' + result.filename + '"',
      "Access-Control-Allow-Origin": "*"
    },
    body: result.body.toString("base64"),
    isBase64Encoded: true
  };
}

async function handle(event, body, sql) {
  var workerId = parseInt(body && body.worker_id, 10);
  if (!workerId || workerId <= 0) return errResp(400, "worker_id requis (entier positif)");

  var docType = body && body.doc_type;
  if (DOC_TYPES.indexOf(docType) < 0) return errResp(400, "doc_type invalide (attendu: " + DOC_TYPES.join(", ") + ")");

  var worker = await data.getWorker(sql, workerId);
  if (!worker) return errResp(404, "Worker not found");

  try {
    if (docType === "worker_profile") {
      var r1 = await pdfProfile.build(worker);
      return binaryResp(r1);
    }

    if (!body.period) return errResp(400, "period requis (format YYYY-MM)");
    var periodInfo;
    try { periodInfo = data.validatePeriod(body.period); }
    catch (e) { return errResp(400, e.message); }

    var records = await data.getRecordsForPeriod(sql, workerId, periodInfo.firstDay, periodInfo.lastDay);

    if (docType === "monthly_recap") return binaryResp(await pdfMonthlyRecap.build(worker, records, periodInfo));
    if (docType === "breaks_history") return binaryResp(await pdfBreaksHistory.build(worker, records, periodInfo));
    if (docType === "hours_excel")    return binaryResp(excelHours.build(worker, records, periodInfo));
    return errResp(500, "Dispatch failure");
  } catch (e) {
    console.error("rh/generate error:", e);
    return errResp(500, e.message || "Unknown error");
  }
}

module.exports = { handle: handle };
