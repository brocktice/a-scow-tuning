/* Loos gauge <-> tension conversion (from Loos INST-07 calibration tables).
   Wire sizes for this boat: uppers & lowers = 5/32", diamonds = 1/8".

   PT-1 scale -> lbs is taken directly from the PT-1 calibration plate (authoritative).
   Model A scale -> lbs is derived via the "Scale Readings For Equal Tension" chart
   (Model A scale -> equivalent PT-1 scale) composed with the PT-1 lbs table, so it is
   approximate near the ends of its range. lbs is treated as the gauge-neutral anchor. */
"use strict";

const LOOS_TABLES = {
  "PT-1": {
    "1/8":  { 12:100,13:110,14:125,15:135,16:150,17:165,18:180,19:200,20:220,21:240,22:260,23:280,24:300,25:320,26:345,27:370,28:390,29:420,30:450,31:475,32:500 },
    "5/32": { 20:140,21:155,22:170,23:185,24:200,25:220,26:245,27:265,28:300,29:320,30:335,31:360,32:390,33:420,34:450,35:480,36:520,37:560,38:610,39:700,40:800 }
  },
  "Model A": {
    // derived: Model A scale -> PT-1 equivalent scale -> lbs
    "1/8":  { 15:125,20:150,25:200,28:240,30:260,35:370,38:450,40:520 },
    "5/32": { 35:220,38:300,40:335,42:420,44:520,45:610,46:700,47:800 }
  }
};

// which wire size each tuning row / log wire uses
const WIRE_SIZE = { uppers: "5/32", lowers: "5/32", intermediates: "1/8" };

const GAUGES = ["Model A", "PT-1"];

function _points(table) {
  return Object.keys(table).map(Number).sort((a, b) => a - b).map((k) => [k, table[k]]);
}

// piecewise-linear interpolation with linear extrapolation past the ends
function _interp(points, x) {
  if (!points.length) return null;
  if (points.length === 1) return points[0][1];
  let i = 0;
  if (x <= points[0][0]) i = 0;
  else if (x >= points[points.length - 1][0]) i = points.length - 2;
  else { while (i < points.length - 2 && x > points[i + 1][0]) i++; }
  const [x0, y0] = points[i], [x1, y1] = points[i + 1];
  if (x1 === x0) return y0;
  return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
}

function _round(v, step) {
  if (v == null || isNaN(v)) return null;
  return Math.round(v / step) * step;
}

// gauge reading -> tension (lbs)
function gaugeToLbs(gauge, wire, reading) {
  const t = LOOS_TABLES[gauge]?.[wire];
  reading = parseFloat(reading);
  if (!t || isNaN(reading)) return null;
  return _round(_interp(_points(t), reading), 5);
}

// tension (lbs) -> gauge reading
function lbsToGauge(gauge, wire, lbs) {
  const t = LOOS_TABLES[gauge]?.[wire];
  lbs = parseFloat(lbs);
  if (!t || isNaN(lbs)) return null;
  const inv = _points(t).map(([s, l]) => [l, s]).sort((a, b) => a[0] - b[0]);
  return _round(_interp(inv, lbs), 0.5);
}

// convert a reading between gauges (via lbs)
function convertReading(fromGauge, toGauge, wire, reading) {
  if (fromGauge === toGauge) return parseFloat(reading);
  const lbs = gaugeToLbs(fromGauge, wire, reading);
  if (lbs == null) return null;
  return lbsToGauge(toGauge, wire, lbs);
}
