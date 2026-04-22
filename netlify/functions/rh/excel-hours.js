var XLSX = require("xlsx");
var D = require("./data");
var slug = require("./slug").slugify;

function build(worker, records, periodInfo) {
  // Group records by date (one row per date with any record)
  var byDate = {};
  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }
  var dates = Object.keys(byDate).sort();

  var rows = [["Date", "Arrivée", "Départ", "Nb pauses", "Temps pause total", "Temps travaillé"]];
  var totalBreak = 0, totalWorked = 0, totalPauses = 0;

  for (var d = 0; d < dates.length; d++) {
    var dayRecords = byDate[dates[d]];
    // Aggregate across any records on the same date (typically 1)
    var firstArrival = null, lastDeparture = null;
    var dayBreakMin = 0, dayPauseCount = 0;
    var dayWorkedMin = 0;
    for (var k = 0; k < dayRecords.length; k++) {
      var rec = dayRecords[k];
      var arrMin = D.hhmmToMin(rec.arrival);
      var depMin = D.hhmmToMin(rec.departure);
      if (arrMin != null && (firstArrival == null || arrMin < firstArrival)) firstArrival = arrMin;
      if (depMin != null && (lastDeparture == null || depMin > lastDeparture)) lastDeparture = depMin;
      dayPauseCount += (rec.breaks || []).filter(function (b) { return b && b.start; }).length;
      dayBreakMin += D.breakMinutesClosed(rec.breaks);
      if (arrMin != null && depMin != null && depMin >= arrMin) {
        var closed = D.breakMinutesClosed(rec.breaks);
        var w = depMin - arrMin - closed;
        if (w < 0) w = 0;
        dayWorkedMin += w;
      }
    }
    rows.push([
      dates[d],
      firstArrival != null ? D.minToHhmm(firstArrival) : "",
      lastDeparture != null ? D.minToHhmm(lastDeparture) : "",
      dayPauseCount,
      D.minToHhmm(dayBreakMin),
      D.minToHhmm(dayWorkedMin)
    ]);
    totalBreak += dayBreakMin;
    totalWorked += dayWorkedMin;
    totalPauses += dayPauseCount;
  }

  rows.push(["TOTAL", "", "", totalPauses, D.minToHhmm(totalBreak), D.minToHhmm(totalWorked)]);

  var sheet = XLSX.utils.aoa_to_sheet(rows);
  // Column widths (hints only; respected by most viewers)
  sheet["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 18 }];

  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, periodInfo.period);
  var buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return {
    filename: "heures-" + slug(worker.name) + "-" + periodInfo.period + ".xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: buffer
  };
}

module.exports = { build: build };
