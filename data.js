/* Reference tuning data for the A Scow rig.
   New profiles are created by deep-cloning REFERENCE_DATA so the original stays pristine. */
const REFERENCE_DATA = {
  schema: "rig-tuning/v1",
  meta: {
    boat: "Catapult IV",
    class: "A Scow",
    rig: "swept spreader",
    tensionUnit: "lbf",
    gauge: "Loos Model A",
    lengthUnit: "in",
    notes: [
      "Tension values may carry an absolute load (lbs) and/or the corresponding Loos Model A gauge reading (loos).",
      "turns = turns counted from that setup's own base setting.",
      "sameAsBase=true means the cell was blank on the card, i.e. no change from base."
    ]
  },
  terminology: {
    convention: "North Sails",
    // Descriptions are keyed by internal data key; the UI shows them under the
    // North Sails labels (key "intermediates" -> "Uppers", key "uppers" -> "Intermediates").
    intermediates: "Uppers — cap shroud running to the top of the mast. 1/8\" wire. Sets mast pre-bend (see prebend); Loos-tensioned, adjusted by wind.",
    uppers: "Intermediates — run only to the upper spreaders, not the masthead. 5/32\" wire. Loos-tensioned, adjusted by wind.",
    lowers: "Lowers — below the spreaders to the chainplate. 5/32\" wire. Loos-tensioned, adjusted by wind.",
    forestay: "Rake, measured in inches from the deck plate.",
    northSailsWarning: "Wires use North Sails naming: Uppers run to the masthead, Intermediates to the upper spreaders, Lowers below the spreaders."
  },
  validations: [
    {
      id: "lowers-half-intermediates",
      expr: "lowers.lbs ~= 0.5 * intermediates.lbs",
      severity: "warn",
      note: "Rule of thumb: lowers ~= 1/2 intermediates. Data does NOT satisfy this everywhere. Surface violations to re-verify; do not auto-correct."
    }
  ],
  windRanges: [
    { id: "0-6", knots: [0, 6], band: "light", tape: "yellow" },
    { id: "6-12", knots: [6, 12], band: "medium", tape: "blue" },
    { id: "12-18", knots: [12, 18], band: "medium", tape: "blue" },
    { id: "18-25", knots: [18, 25], band: "heavy", tape: "red" }
  ],
  prebend: {
    wire: "intermediates",
    unit: "in",
    source: "North Sails A Scow guide (reference — replace with your measured targets)",
    confirmed: false,
    measurement: "string down the back of the tunnel, read at the spar midpoint",
    adjustsWithWind: true,
    byBand: { light: [4, 4.5], allPurpose: 5, heavy: [5, 5.5] },
    note: "More bend as breeze builds to flatten/depower. Some skippers move it with the wind; others hold one value."
  },
  hull: {
    asymmetry_in: 0.625,
    higherSide: "starboard",
    note: "Legacy mold runs ~5/8 in higher to starboard. Tune to a centered masthead; expect uneven port/stbd turnbuckle counts. Tool should support per-side values."
  },
  setups: [
    {
      id: "andy",
      label: "Andy",
      base: {
        uppers: { lbs: 300, loos: 37 },
        lowers: { note: "hand tight" },
        forestay: { in: 16 }
      },
      byWind: {
        "0-6": { uppers: { lbs: 300, loos: 37 }, lowers: { lbs: 200, loos: 32 }, forestay: { in: 15.5 } },
        "6-12": { uppers: { sameAsBase: true }, lowers: { sameAsBase: true }, forestay: { in: 16 } },
        "12-18": { uppers: { turns: 6, lbs: 500, loos: 43 }, lowers: { turns: 6, lbs: 300, loos: 35 }, forestay: { in: 17 } },
        "18-25": { uppers: { turns: 10, lbs: 600, loos: 45 }, lowers: { turns: 10, lbs: 520, loos: 43 }, forestay: { in: 17 } }
      },
      notes: [
        "Main traveler up 3 in at 0-6, main eased for twist.",
        "Keep traveler centered until everyone is on the rail."
      ]
    },
    {
      id: "buddy",
      label: "Buddy",
      base: {
        uppers: { lbs: 450, loos: 42 },
        lowers: { lbs: 200, loos: 32 },
        forestay: { in: 16 }
      },
      byWind: {
        "0-6": { uppers: { lbs: 450, loos: 42 }, lowers: { lbs: 200, loos: 32 }, forestay: { in: 16 } },
        "6-12": { uppers: { sameAsBase: true }, lowers: { sameAsBase: true }, forestay: { in: 16 } },
        "12-18": { uppers: { turns: 6, lbs: 600, loos: 45 }, lowers: { turns: 6, lbs: 500, loos: 43 }, forestay: { in: 16 } },
        "18-25": { uppers: { turns: 12, lbs: 1000, loos: 49 }, lowers: { turns: 9, lbs: 600, loos: 45 }, forestay: { in: 16 } }
      },
      notes: [
        "Too much mast bend above 18 kn - tighten lowers 2 turns."
      ]
    },
    {
      id: "c4",
      label: "C4",
      base: {
        uppers: { lbs: 300, loos: 37 },
        lowers: { note: "hand tight" },
        forestay: { in: 16 }
      },
      byWind: {
        "0-6": { uppers: { lbs: 300, loos: 37 }, lowers: { lbs: 200, loos: 32 }, forestay: { in: 15.5 } },
        "6-12": { uppers: { turns: 3, lbs: 360, loos: 40 }, lowers: { turns: 2, lbs: 360, loos: 40, verify: true, verifyNote: "360 violates lowers~=1/2 uppers; likely a misread (260? 180?). Confirm against your source." }, forestay: { in: 16 } },
        "12-18": { uppers: { turns: 5, lbs: 520, loos: 44 }, lowers: { turns: 5, lbs: 520, loos: 44 }, forestay: { in: 16 } },
        "18-25": { uppers: { turns: 11, lbs: 700, loos: 46 }, lowers: { turns: 10, lbs: 700, loos: 46 }, forestay: { in: 17 } }
      },
      notes: []
    }
  ],
  globalNotes: [
    "Depowering priority: 1) vang, 2) fine tune, 3) traveler down.",
    "Return to base at the end of the racing day."
  ]
};
