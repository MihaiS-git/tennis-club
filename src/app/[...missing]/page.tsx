import { notFound } from "next/navigation";

// Keep unmatched client navigations within the shared root layout.
export default function MissingPage() {
  notFound();
}
