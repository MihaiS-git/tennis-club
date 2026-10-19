import Image from "next/image";

import styles from "./page.module.css";

type EditorialHeroProps = {
  titleId: string;
  eyebrow: string;
  title: React.ReactNode;
  // Width of the title measure, e.g. "max-w-[13ch]", so each title breaks well.
  titleClassName: string;
  intro: React.ReactNode;
  // Object position classes crop each photograph for its subject.
  image: { src: string; alt: string; className: string };
  // Optional calls to action below the introduction.
  children?: React.ReactNode;
};

// The full-width editorial hero shared by the public section pages (The Club,
// Courts, Coaching): one height, overlay, measure and type scale for all of them.
export function EditorialHero({ titleId, eyebrow, title, titleClassName, intro, image, children }: EditorialHeroProps) {
  return (
    <section aria-labelledby={titleId} className="relative isolate h-[clamp(540px,86svh,860px)] overflow-hidden bg-forest-900">
      <Image
        src={image.src}
        alt={image.alt}
        fill
        sizes="100vw"
        loading="eager"
        fetchPriority="high"
        className={`${styles.heroImage} -z-10 object-cover ${image.className}`}
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-linear-to-t from-forest-900 from-5% via-forest-900/60 via-45% to-forest-900/5 lg:bg-linear-to-tr lg:from-forest-900/95 lg:via-forest-900/45 lg:to-transparent" />
      <div className="mx-auto flex h-full max-w-7xl items-end px-6 pb-10 md:px-8 md:pb-16 lg:pb-20">
        <div className={`${styles.heroEntrance} max-w-2xl text-chalk`}>
          <p className="flex items-center gap-3 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-chalk [text-shadow:0_1px_8px_rgb(0_0_0/0.45)]">
            <span aria-hidden="true" className="h-0.5 w-8 bg-accent-on-dark" />{eyebrow}
          </p>
          <h1 id={titleId} className={`mt-4 ${titleClassName} font-heading text-[clamp(44px,6.4vw,88px)] font-semibold leading-[1] tracking-[-0.045em]`}>
            {title}
          </h1>
          <p className="mt-5 max-w-[46ch] text-pretty font-sans text-base leading-7 text-ivory md:mt-6 md:text-lg md:leading-8">
            {intro}
          </p>
          {children && <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">{children}</div>}
        </div>
      </div>
    </section>
  );
}
