// No database or application imports: exercise the production comparator against
// already classified rows, separately from validation, timezone conversion and SQL.
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import ts from "typescript";

const source = readFileSync("src/lib/bookings/activity-service.ts", "utf8");
const helpers = source.slice(source.indexOf("function compareValue("), source.indexOf("export async function listOwnCourtActivity"));
const { outputText } = ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
const compare = new Function("courtActivityType", `${outputText}; return compareActivity;`)(
  row => row.kind === "reservation" ? "reservation" : row.includes_coaching ? "coaching" : "court",
);
const sorts = ["datetime", "location", "court", "type", "duration", "status"];
const scenarios = {
  all: { eligible: () => true, matches: () => true, court: false },
  selective: { eligible: i => i % 2 === 0, matches: i => i % 10 === 0, court: false },
  rejected_batches: { eligible: i => Math.floor(i / 1000) % 2 === 0, matches: i => i % 4 === 0, court: false },
  court_all: { eligible: () => true, matches: () => true, court: true },
  court_selective: { eligible: i => i % 2 === 0, matches: i => i % 4 === 0, court: true },
};

function fixture(count) {
  // Four source/lifecycle streams, each in UUID order; public keys deliberately
  // disagree with that order. Equal starts exercise type and UUID tie-breakers.
  return Array.from({ length: 4 }, (_, stream) => Array.from({ length: Math.floor(count / 4) }, (_, n) => {
    const i = stream * Math.floor(count / 4) + n;
    const day = 1 + ((i * 7919) % 28);
    return { i, id: `ca000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      kind: stream < 2 ? "booking" : "reservation", includes_coaching: i % 3 === 0,
      status: stream % 2 ? "cancelled" : "confirmed",
      starts_at_instant: `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`,
      location_name: `Club ${i % 5}`, court_name: `Court ${i % 7}`,
      starts_at_minute: 600, ends_at_minute: 660 + 30 * (i % 4),
      // Retain realistic private snapshot payload (shared strings, distinct rows).
      customer_name: "Historic customer", customer_email: "snapshot@example.test",
      customer_phone: "0123456789", reason: "Staff practice", updated_at: "2026-10-01T00:00:00.123456Z",
    };
  }));
}

function select(streams, query, scenario, mode, sampleHeap = false) {
  const needed = query.page * 20 + 1;
  let candidates = [], courtCandidates = [];
  let operations = 0, peak = 0;
  let dirty = false, courtDirty = false;
  const heapStart = sampleHeap ? process.memoryUsage().heapUsed : 0;
  let heapPeak = heapStart;
  const comparator = (a, b) => compare(a, b, "history", query);
  const sort = rows => { operations++; rows.sort(comparator); return rows.slice(0, needed); };
  const started = performance.now();
  for (const stream of streams) {
    for (let offset = 0; offset < stream.length; offset += 1000) {
      let added = false, courtAdded = false;
      for (let n = offset; n < Math.min(offset + 1000, stream.length); n++) {
        const row = stream[n];
        if (!scenario.eligible(row.i) || !scenario.matches(row.i)) continue;
        candidates.push(row); added = dirty = true;
        if (scenario.court && (scenario === scenarios.court_all || row.i % 8 === 0)) {
          courtCandidates.push(row); courtAdded = courtDirty = true;
        }
      }
      peak = Math.max(peak, candidates.length + courtCandidates.length);
      if (added && (mode === "before" || candidates.length > needed)) { candidates = sort(candidates); dirty = false; }
      if (courtAdded && (mode === "before" || courtCandidates.length > needed)) { courtCandidates = sort(courtCandidates); courtDirty = false; }
      if (sampleHeap) heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    }
  }
  if (scenario.court) { candidates = courtCandidates; dirty = courtDirty; }
  if (mode === "deferred" && dirty) candidates = sort(candidates);
  const rows = candidates.slice((query.page - 1) * 20, query.page * 20);
  if (sampleHeap) heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  const ms = performance.now() - started;
  return { ms, peak, operations, rows: rows.map(row => row.id),
    retained: candidates.map(row => row.id), heapDelta: heapPeak - heapStart,
    hasNext: candidates.length > query.page * 20 };
}

const results = [];
const repeats = Number(process.env.ACTIVITY_SELECTION_REPEATS ?? 3);
for (const count of process.env.ACTIVITY_SELECTION_MEMORY_ONLY ? [] : [1000, 10000, 30000]) {
  const streams = fixture(count);
  for (const [scenarioName, scenario] of Object.entries(scenarios)) {
    const eligible = streams.flat().filter(row => scenario.eligible(row.i) && scenario.matches(row.i)
      && (!scenario.court || scenario === scenarios.court_all || row.i % 8 === 0));
    const pages = [...new Set([1, 10, 100, Math.max(1, Math.ceil(eligible.length / 20))])];
    for (const sort of sorts) for (const direction of ["asc", "desc"]) {
      const ordered = [...eligible].sort((a, b) => compare(a, b, "history", { sort, direction }));
      for (const page of pages) {
        const query = { page, sort, direction };
        const samples = { before: [], deferred: [] };
        for (let repeat = -1; repeat < repeats; repeat++) {
          // Alternate order to reduce systematic JIT/cache bias; first pair warms up.
          for (const mode of repeat % 2 ? ["before", "deferred"] : ["deferred", "before"]) {
            const result = select(streams, query, scenario, mode);
            assert.deepEqual(result.rows, ordered.slice((page - 1) * 20, page * 20).map(row => row.id));
            assert.deepEqual(result.retained, ordered.slice(0, page * 20 + 1).map(row => row.id));
            assert.equal(result.hasNext, eligible.length > page * 20);
            if (repeat >= 0) samples[mode].push(result);
          }
        }
        const record = { count, scenario: scenarioName, sort, direction, page, eligible: eligible.length };
        for (const mode of ["before", "deferred"]) {
          const runs = samples[mode].sort((a, b) => a.ms - b.ms);
          record[mode] = { ms: runs[Math.floor(runs.length / 2)].ms, peak: runs[0].peak, operations: runs[0].operations };
        }
        results.push(record);
      }
    }
  }
  console.log(`Completed ${count} rows (${results.length} cases so far)`);
}
const output = process.env.ACTIVITY_SELECTION_OUTPUT ?? "/tmp/activity-selection.json";
const memory = [];
if (global.gc) {
  const streams = fixture(30000);
  for (const page of [1, 1500]) for (const mode of ["before", "deferred"]) {
    global.gc();
    const { heapDelta, peak } = select(streams, { page, sort: "datetime", direction: "desc" }, scenarios.court_all, mode, true);
    memory.push({ page, mode, heapDelta, peak });
  }
}
writeFileSync(output, JSON.stringify({ node: process.version, repeats, memory, results }, null, 2) + "\n");
console.log(`Saved ${results.length} verified cases to ${output}`);
