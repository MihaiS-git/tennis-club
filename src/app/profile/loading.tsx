export default function ProfileLoading() {
  return (
    <main className="flex-1 bg-background px-4 py-6 sm:px-6 sm:py-10 lg:px-8 lg:py-12" aria-busy="true">
      <div className="mx-auto max-w-7xl">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Profile</h1>
        <p role="status" className="mt-3 text-sm text-muted-foreground">Loading your profile…</p>
      </div>
    </main>
  );
}
