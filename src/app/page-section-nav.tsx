export type PageSection = { id: string; label: string };

// In-page section menu placed directly below a public page's hero. Each id must
// name an element on the page that carries `scroll-mt-20`, clearing the sticky navbar.
export function PageSectionNav({ sections }: { sections: readonly PageSection[] }) {
  return (
    <nav aria-label="On this page" className="border-b border-border bg-background">
      <ul className="mx-auto flex max-w-7xl gap-x-6 overflow-x-auto px-6 md:flex-wrap md:px-8">
        {sections.map((section) => (
          <li key={section.id} className="shrink-0">
            <a href={`#${section.id}`} className="inline-flex min-h-12 items-center whitespace-nowrap font-sans text-sm font-medium text-primary transition-colors hover:text-accent focus-visible:rounded-control">
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
