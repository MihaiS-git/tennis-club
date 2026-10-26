import type { PublicCoaching } from "@/lib/coaching/public";

const listClassName = "mt-10 grid gap-x-8 font-sans text-base font-medium text-ivory md:grid-cols-2";
const noteClassName = "mt-10 max-w-xl border-t border-ivory/30 pt-4 font-sans text-base leading-7 text-ivory";

export function HomeCoachingFallback() {
  return <p role="status" className={noteClassName}>Loading coaching programs…</p>;
}

// Only programs the club has published are named; nothing is advertised otherwise.
export async function HomeCoachingPrograms({ coaching }: { coaching: Promise<PublicCoaching> }) {
  let programs: PublicCoaching["programs"];
  try {
    ({ programs } = await coaching);
  } catch {
    return <p role="alert" className={noteClassName}>Coaching information is temporarily unavailable. Please try again later.</p>;
  }
  if (!programs.length) {
    return <p className={noteClassName}>Coaching programs will be listed here as soon as the club publishes them.</p>;
  }
  return (
    <ul aria-label="Coaching programs" className={listClassName}>
      {programs.map((program) => <li key={program.id} className="border-t border-ivory/30 py-4">{program.name}</li>)}
    </ul>
  );
}
