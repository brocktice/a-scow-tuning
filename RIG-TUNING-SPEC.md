# A Scow Rig Tuning — Data Handoff

Structured tuning data transcribed from Louis Hill's "Catapult IV" swept-rig card (6/8/08), packaged for building a rig-configuration tracking tool in Claude Code.

## Files
- `rig-tuning-data.json` — canonical reference data: setups, wind ranges, pre-bend, hull note, validations.

## Domain model
- **Setup** — a named tuning column (`andy`, `buddy`, `c4`). `c4` = Catapult IV; the other two are reference setups from other sailors. Each setup has a `base` (the turn-counting reference) and `byWind` settings keyed by wind range.
- **Wires** (fleet convention — see `terminology` in the JSON):
  - `uppers` — masthead to chainplate; Loos-tensioned, wind-adjusted.
  - `lowers` — below the spreaders to chainplate; Loos-tensioned, wind-adjusted.
  - `intermediates` — the pre-bend / diamond wire, expressed as inches of bend (see `prebend`), not a Loos tension.
  - `forestay` — rake, inches from the deck plate.
- **Tension value** — `{ turns?, lbs?, loos?, sameAsBase?, note?, verify?, verifyNote? }`. `turns` is counted from that setup's own `base`; `lbs` is load; `loos` is the Loos Model A reading.
- **Wind range** — knots band plus the forestay tape color (yellow = light, blue = medium, red = heavy).

## Caveats to carry into the tool
- **Terminology**: North Sails' guide swaps "uppers"/"intermediates" vs this fleet convention. This data uses the fleet convention; flag the difference if importing North numbers.
- **Pre-bend is a placeholder**: `prebend.byBand` values are North's reference, `confirmed: false`. The user will supply Louis's actual targets and whether he adjusts per wind or fixes one value.
- **Validation rule** `lowers-half-uppers`: Louis's rule of thumb that lowers ≈ ½ uppers. The transcribed data does **not** satisfy it everywhere — compute and surface violations for the user to verify rather than auto-correcting.
- **Known-suspect cell**: `c4.byWind["6-12"].lowers` carries `verify: true` (reads 360, which breaks the rule — possible misread of 260 or 180).
- **Hull asymmetry**: starboard ~5/8" high (`hull`). Port/stbd turnbuckle counts will differ by design — the tool should support per-side values and tuning to a centered masthead, not matched numbers.

## Suggested tool capabilities
- Log actual on-water settings per race/day against the reference, and track drift over time.
- Run the `validations` on any entry and warn on violations (don't block).
- Store per-side (port/stbd) values to accommodate the hull asymmetry.
- Let the user confirm/replace the pre-bend targets and resolve the flagged C4 cell.
- Treat `base` as the zero point for `turns`; resolve `sameAsBase` to the base value at read time.
