var C = require("./constants");

function validatePeriod(period) {
  if (typeof period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    var e = new Error("period doit être au format YYYY-MM (ex: 2026-03)");
    e.status = 400;
    throw e;
  }
  var parts = period.split("-");
  var year = parseInt(parts[0], 10);
  var monthIndex = parseInt(parts[1], 10) - 1; // 0-based
  var firstDay = period + "-01";
  // last day of month: new Date(y, m+1, 0)
  var lastDate = new Date(Date.UTC(year, monthIndex + 1, 0));
  var lastDay = period + "-" + String(lastDate.getUTCDate()).padStart(2, "0");
  return { firstDay: firstDay, lastDay: lastDay, year: year, monthIndex: monthIndex, period: period };
}

async function getWorker(sql, id) {
  var rows = await sql("SELECT * FROM workers WHERE id=$1", [id]);
  return rows[0] || null;
}

async function getRecordsForPeriod(sql, workerId, firstDay, lastDay) {
  var rows = await sql(
    "SELECT r.*, w.sched_in, w.sched_out FROM records r JOIN workers w ON r.worker_id=w.id " +
    "WHERE r.worker_id=$1 AND r.date>=$2 AND r.date<=$3 ORDER BY r.date, r.arrival",
    [workerId, firstDay, lastDay]
  );
  return rows.map(function (r) {
    var breaks = r.breaks;
    if (typeof breaks === "string") { try { breaks = JSON.parse(breaks); } catch (e) { breaks = []; } }
    if (!Array.isArray(breaks)) breaks = [];
    return {
      id: r.id,
      date: typeof r.date === "string" ? r.date.substring(0, 10) : r.date,
      arrival: r.arrival,
      departure: r.departure,
      breaks: breaks,
      sched_in: r.sched_in || "08:00",
      sched_out: r.sched_out || "16:00"
    };
  });
}

function hhmmToMin(s) {
  if (!s || typeof s !== "string") return null;
  var parts = s.split(":");
  if (parts.length !== 2) return null;
  var h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function minToHhmm(min) {
  if (min == null || isNaN(min)) return "00:00";
  min = Math.max(0, Math.round(min));
  var h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function minToHhMmLabel(min) {
  if (min == null || isNaN(min)) return "0h 00min";
  min = Math.max(0, Math.round(min));
  var h = Math.floor(min / 60), m = min % 60;
  return h + "h " + String(m).padStart(2, "0") + "min";
}

function breakMinutesClosed(breaks) {
  var total = 0;
  for (var i = 0; i < breaks.length; i++) {
    var b = breaks[i];
    if (b && b.start && b.end) {
      var s = hhmmToMin(b.start), e = hhmmToMin(b.end);
      if (s != null && e != null && e >= s) total += e - s;
    }
  }
  return total;
}

function computeStats(worker, records) {
  var daysSet = {};
  var totalWorkedMin = 0;
  var overtimeMin = 0;
  var lateCount = 0;
  var totalBreakMin = 0;
  var arrivalMinSum = 0, arrivalCount = 0;
  var breakList = [];
  var lateList = [];

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    daysSet[r.date] = true;

    var arr = hhmmToMin(r.arrival);
    var dep = hhmmToMin(r.departure);
    var schedIn = hhmmToMin(r.sched_in);

    if (arr != null) { arrivalMinSum += arr; arrivalCount++; }

    // Tardiness
    if (arr != null && schedIn != null && arr > schedIn + C.TARDINESS_TOLERANCE_MIN) {
      lateCount++;
      lateList.push({
        date: r.date,
        arrival: r.arrival,
        sched_in: r.sched_in,
        late_min: arr - schedIn
      });
    }

    // Breaks: collect all (open + closed) for breakList
    for (var j = 0; j < r.breaks.length; j++) {
      var b = r.breaks[j];
      if (!b || !b.start) continue;
      var bs = hhmmToMin(b.start);
      var be = b.end ? hhmmToMin(b.end) : null;
      var duration = (bs != null && be != null && be >= bs) ? (be - bs) : null;
      breakList.push({
        date: r.date,
        start: b.start,
        end: b.end || null,
        duration_min: duration
      });
    }

    // Worked time: only if departure is present (ignore open records)
    if (arr != null && dep != null && dep >= arr) {
      var closedBreakMin = breakMinutesClosed(r.breaks);
      var worked = dep - arr - closedBreakMin;
      if (worked < 0) worked = 0;
      totalWorkedMin += worked;
      totalBreakMin += closedBreakMin;
      if (worked > C.OVERTIME_THRESHOLD_MIN) overtimeMin += worked - C.OVERTIME_THRESHOLD_MIN;
    }
  }

  var days = Object.keys(daysSet).length;
  var avgBreakMin = days > 0 ? Math.round(totalBreakMin / days) : 0;
  var avgArrivalMin = arrivalCount > 0 ? Math.round(arrivalMinSum / arrivalCount) : null;

  // sort output lists
  breakList.sort(function (a, b) { return a.date.localeCompare(b.date) || (a.start || "").localeCompare(b.start || ""); });
  lateList.sort(function (a, b) { return a.date.localeCompare(b.date); });

  return {
    days: days,
    totalWorkedMin: totalWorkedMin,
    overtimeMin: overtimeMin,
    lateCount: lateCount,
    totalBreakMin: totalBreakMin,
    avgBreakMin: avgBreakMin,
    avgArrivalMin: avgArrivalMin,
    breakList: breakList,
    lateList: lateList
  };
}

function formatDateFr(isoDateOrString) {
  if (!isoDateOrString) return "—";
  var s = String(isoDateOrString).substring(0, 10);
  var parts = s.split("-");
  if (parts.length !== 3) return s;
  return parts[2] + "/" + parts[1] + "/" + parts[0];
}

module.exports = {
  validatePeriod: validatePeriod,
  getWorker: getWorker,
  getRecordsForPeriod: getRecordsForPeriod,
  computeStats: computeStats,
  hhmmToMin: hhmmToMin,
  minToHhmm: minToHhmm,
  minToHhMmLabel: minToHhMmLabel,
  formatDateFr: formatDateFr,
  breakMinutesClosed: breakMinutesClosed
};
