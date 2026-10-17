import type { PublicCourt } from "@/lib/courts/public";
import type { PublicLocationToday } from "@/lib/courts/public-calendar";
import { countLabel } from "@/lib/courts/summary";
import styles from "../page.module.css";

type Condition = {
  key: string;
  title: string;
  text: string;
  matches: (court: PublicCourt) => boolean;
  // Only photography that genuinely shows the condition; others stay typographic.
  image?: { name: string; alt: string; width: number; height: number; position: string };
};

// General playing character of each configured attribute; which apply comes from the published courts.
const conditions: Condition[] = [
  { key: "clay", title: "Clay", matches: (court) => court.surface === "clay",
    text: "Slower, with a higher bounce. Rallies run longer, sliding into the ball is part of the game and the surface is kind to knees. Shoes with a clay or all-court sole keep you on your feet.",
    image: { name: "tennis-hero-desktop", alt: "A player sliding into a forehand on a clay court, kicking up a trail of clay dust", width: 1942, height: 809, position: "object-[78%_center]" } },
  { key: "hard", title: "Hard", matches: (court) => court.surface === "hard",
    text: "Quick and true. The ball comes onto the racket predictably, rewarding first-strike tennis and a solid serve." },
  { key: "grass", title: "Grass", matches: (court) => court.surface === "grass",
    text: "Fast and low. Short points, slices that stay down and a premium on getting to the net first." },
  { key: "carpet", title: "Carpet", matches: (court) => court.surface === "carpet",
    text: "Smooth and consistent, with a medium pace that suits players of every level." },
  { key: "indoor", title: "Indoor", matches: (court) => court.environment === "indoor",
    text: "Play whatever the weather, with steady light and no wind to judge." },
  { key: "floodlit", title: "Floodlit", matches: (court) => court.has_lighting,
    text: "Lit courts stay playable after dark, within each location’s opening hours." },
];

export async function CourtsConditions({ locations }: { locations: Promise<PublicLocationToday[]> }) {
  let courts: PublicCourt[];
  try {
    courts = (await locations).flatMap((location) => location.courts);
  } catch {
    // Court discovery reports the failure; this editorial section simply stays out of the way.
    return null;
  }
  const present = conditions.map((condition) => ({ ...condition, count: courts.filter(condition.matches).length }))
    .filter((condition) => condition.count > 0);
  if (!present.length) return null;

  const featured = present.find((condition) => condition.image);
  const others = present.filter((condition) => condition !== featured);

  return (
    <section aria-labelledby="courts-conditions-title" className="bg-background px-6 py-14 md:px-8 md:py-20 xl:py-28">
      <div className="mx-auto max-w-7xl">
        <div className={`${styles.reveal} max-w-2xl`}>
          <p className="font-sans text-xs font-semibold uppercase tracking-[0.16em] text-accent">Playing conditions</p>
          <h2 id="courts-conditions-title" className="mt-4 font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
            Know the court before you step on it.
          </h2>
        </div>

        {featured?.image && (
          <div className={`${styles.stagger} mt-10 grid gap-8 md:mt-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-16`}>
            <picture className={`${styles.photo} -mx-6 block aspect-[4/3] overflow-hidden md:mx-0 lg:aspect-[5/4]`}>
              <source type="image/avif" srcSet={`/images/${featured.image.name}.avif`} />
              <source type="image/webp" srcSet={`/images/${featured.image.name}.webp`} />
              <img
                src={`/images/${featured.image.name}.webp`}
                alt={featured.image.alt}
                loading="lazy"
                decoding="async"
                width={featured.image.width}
                height={featured.image.height}
                className={`block h-full w-full object-cover ${featured.image.position}`}
              />
            </picture>
            <div>
              <h3 className="font-heading text-[clamp(28px,3vw,40px)] font-semibold tracking-[-0.03em] text-primary">{featured.title}</h3>
              <p className="mt-2 font-sans text-sm font-semibold text-accent">{countLabel(featured.count, "court")}</p>
              <p className="mt-4 max-w-xl font-sans text-base leading-7 text-muted-foreground md:text-lg md:leading-8">{featured.text}</p>
            </div>
          </div>
        )}

        {others.length > 0 && (
          <ul aria-label="Playing conditions" className={`${styles.stagger} mt-10 grid gap-x-10 md:mt-14 md:grid-cols-2 ${others.length >= 3 ? "lg:grid-cols-3" : ""}`}>
            {others.map((condition) => (
              <li key={condition.key} className="border-t border-border py-5">
                <div className="flex items-baseline justify-between gap-4">
                  <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary">{condition.title}</h3>
                  <span className="font-sans text-sm font-semibold text-accent">{countLabel(condition.count, "court")}</span>
                </div>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">{condition.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
