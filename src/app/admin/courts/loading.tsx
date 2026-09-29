export default function AdminCourtsLoading() {
  return (
    <main className="flex-1 bg-background px-6 py-10 md:px-8 md:py-12 lg:py-16" aria-busy="true">
      <div className="mx-auto max-w-7xl">
        <p role="status" className="text-muted-foreground">Loading…</p>
      </div>
    </main>
  );
}
