// Opt-in instrumentation of the real service, applied only by this Vitest config.
import { mergeConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import base from "../vitest.config.mjs";

export default mergeConfig(base, {
  // Baseline source and instrumentation depend on invocation environment values.
  // Never reuse persisted transforms from a different profiling invocation.
  test: { fsModuleCache: false },
  plugins: [{
    name: "activity-cpu-stages",
    enforce: "pre",
    transform(source: string, id: string) {
      if (id.endsWith("/src/lib/courts/local-time.ts")) {
        return { code: source.replaceAll("new Intl.DateTimeFormat(", "countedFormatter(") + `
function countedFormatter(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
  const metrics = Reflect.get(globalThis, "activityProfile");
  if (metrics) metrics.formatters++;
  return new Intl.DateTimeFormat(...args);
}`, map: null };
      }
      if (!id.endsWith("/src/lib/bookings/activity-service.ts")) return;
      if (process.env.ACTIVITY_SERVICE_BASELINE) source = readFileSync(process.env.ACTIVITY_SERVICE_BASELINE, "utf8");
      const resolver = source.includes("const resolveStartInstant =") ? "resolveStartInstant" : "localStartInstant";
      const replace = (before: string, after: string) => {
        if (source.split(before).length !== 2) throw new Error(`Activity profiling marker changed: ${before}`);
        source = source.replace(before, after);
      };
      replace('  const supabase = client ?? await createClient();', `
  const metrics = { retrieval: 0, validation: 0, timezone: 0, business: 0, selection: 0, page: 0,
    classification: 0, conversions: 0, formatters: 0, peakHeap: process.memoryUsage().heapUsed };
  Reflect.set(globalThis, "activityProfile", metrics);
  const measure = <T,>(stage: "validation" | "timezone" | "selection" | "page", fn: () => T): T => {
    const start = performance.now();
    try { return fn(); } finally { metrics[stage] += performance.now() - start; }
  };
  const timezoneInstant = (...args: Parameters<typeof localStartInstant>) => {
    metrics.conversions++;
    return measure("timezone", () => ${resolver}(...args));
  };
  const retrieve = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await fn(); } finally { metrics.retrieval += performance.now() - start; }
  };
  const supabase = client ?? await createClient();`);
      replace('data = await listOwnerActivityBatch(manager, {', 'data = await retrieve(() => listOwnerActivityBatch(manager, {');
      replace('afterId, limit: batchSize });', 'afterId, limit: batchSize }));');
      replace('const parsed = kind ===', 'const parsed = measure("validation", () => kind ===');
      replace(': z.array(reservationSelectSchema).safeParse(data);', ': z.array(reservationSelectSchema).safeParse(data));');
      replace('new Set(await listSucceededPaymentBookingIds(manager, onlineBookingIds))', 'new Set(await retrieve(() => listSucceededPaymentBookingIds(manager, onlineBookingIds)))');
      replace('for (const source of parsed.data) {', `for (const source of parsed.data) {
          const start = performance.now(), timezoneBefore = metrics.timezone, selectionBefore = metrics.selection;
          try {`);
      // Classification overlaps the exclusive timezone/business stages. This
      // additional inclusive CPU-bound wall timer is not added to stage totals.
      if (source.includes('let end: string | undefined;')) {
        replace('let end: string | undefined;', 'let end: string | undefined; const classificationStarted = performance.now(); try {');
        replace('          locations.set(court.location_id,', '          } finally { metrics.classification += performance.now() - classificationStarted; }\n          locations.set(court.location_id,');
      } else {
        replace(`const end = ${resolver}(court.location.timezone`, `let end: string; const classificationStarted = performance.now(); try { end = ${resolver}(court.location.timezone`);
        replace('          const common =', '          } finally { metrics.classification += performance.now() - classificationStarted; }\n          const common =');
      }
      // Only instrument the list; notification-target conversion remains untouched.
      const listEnd = source.indexOf("export async function listOwnUpcomingActivity");
      source = source.slice(0, listEnd).replaceAll(`${resolver}(court.location.timezone`, 'timezoneInstant(court.location.timezone')
        .replaceAll(`${resolver}(row.location_timezone`, 'timezoneInstant(row.location_timezone') + source.slice(listEnd);
      replace('          candidates.push(row);', '          measure("selection", () => { candidates.push(row);');
      replace('            addedCourtCandidates = true;\n          }\n        }', `            addedCourtCandidates = true;
          } });
          } finally { metrics.business += performance.now() - start - (metrics.timezone - timezoneBefore) - (metrics.selection - selectionBefore); }
        }
        metrics.peakHeap = Math.max(metrics.peakHeap, process.memoryUsage().heapUsed);`);
      replace('          candidates.sort((a, b) => compareActivity(a, b, scope, query));\n          candidates = candidates.slice(0, needed);', '          measure("selection", () => { candidates.sort((a, b) => compareActivity(a, b, scope, query));\n          candidates = candidates.slice(0, needed); });');
      replace('          courtCandidates.sort((a, b) => compareActivity(a, b, scope, query));\n          courtCandidates = courtCandidates.slice(0, needed);', '          measure("selection", () => { courtCandidates.sort((a, b) => compareActivity(a, b, scope, query));\n          courtCandidates = courtCandidates.slice(0, needed); });');
      replace('if (candidatesNeedSort) candidates.sort((a, b) => compareActivity(a, b, scope, query));', 'if (candidatesNeedSort) measure("selection", () => candidates.sort((a, b) => compareActivity(a, b, scope, query)));');
      if (source.includes('  const rows = candidates.slice')) {
        replace('  const rows = candidates.slice', '  const rows = measure("page", () => candidates.slice');
        replace('row.booking_date, row.ends_at_minute) }));', 'row.booking_date, row.ends_at_minute) })));');
        replace('  return { rows, hasNext:', '  return measure("page", () => ({ rows, hasNext:');
      } else {
        replace('  return { rows: candidates.slice', '  return measure("page", () => ({ rows: candidates.slice');
      }
      replace('courts: [...courts.values()].sort(compareOption) };', 'courts: [...courts.values()].sort(compareOption) }));');
      return { code: source, map: null };
    },
  }],
});
