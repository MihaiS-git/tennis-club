import { readFileSync } from "node:fs";

// Sample weights are elapsed microseconds, including GC/native work. Stage timers
// supplement these samples for operations shorter than the sampling interval.
export function summarizeProfile(path) {
  const profile = JSON.parse(readFileSync(path, "utf8"));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const leaves = new Map();
  const stages = { timezone: 0, retrieval: 0, comparator: 0, gc: 0, other: 0 };
  for (let i = 0; i < profile.samples.length; i++) {
    let node = nodes.get(profile.samples[i]);
    const weight = profile.timeDeltas[i] / 1000;
    const leaf = node.callFrame.functionName || "(anonymous/native)";
    leaves.set(leaf, (leaves.get(leaf) ?? 0) + weight);
    let stage = leaf === "(garbage collector)" ? "gc" : "other";
    while (node) {
      const name = node.callFrame.functionName;
      if (["localStartInstant", "resolveLocalStartInstant", "timezoneInstant"].includes(name)) { stage = "timezone"; break; }
      if (["listOwnerActivityBatch", "listSucceededPaymentBookingIds"].includes(name)) { stage = "retrieval"; break; }
      if (name === "compareActivity") { stage = "comparator"; break; }
      node = nodes.get(parents.get(node.id));
    }
    stages[stage] += weight;
  }
  return { path, sampledMs: stages,
    topLeavesMs: [...leaves].sort((a, b) => b[1] - a[1]).slice(0, 15) };
}

for (const path of process.argv.slice(2)) console.log(JSON.stringify(summarizeProfile(path), null, 2));
