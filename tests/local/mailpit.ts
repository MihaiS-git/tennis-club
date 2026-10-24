import { z } from "zod";
import { assertTestEnvironment } from "./environment.mjs";

// Isolated Mailpit API v1. Each test mails a unique recipient, so a recipient search selects
// only that test's messages; the shared inbox is never cleared.
const searchSchema = z.object({
  messages_count: z.number().int().nonnegative(),
  messages: z.array(z.object({ ID: z.string().min(1), To: z.array(z.object({ Address: z.string() })) })),
});
const messageSchema = z.object({ Text: z.string() });
const pageSize = 50;

async function mailpit(path: string, init?: RequestInit): Promise<Response> {
  assertTestEnvironment();
  const response = await fetch(`${process.env.MAILPIT_URL}/api/v1/${path}`, init);
  if (!response.ok) throw new Error(`Mailpit ${init?.method ?? "GET"} /api/v1/${path.split("?")[0]} returned HTTP ${response.status}.`);
  return response;
}

// IDs of all messages delivered to the recipient, newest first, across every result page.
export async function mailpitMessageIds(email: string): Promise<string[]> {
  const query = `to:"${email}"`, ids: string[] = [];
  for (let start = 0; ; start += pageSize) {
    const page = searchSchema.parse(await (await mailpit(`search?${new URLSearchParams({ query, start: `${start}`, limit: `${pageSize}` })}`)).json());
    // Search matches substrings; only exact recipients belong to the test.
    ids.push(...page.messages.filter((message) => message.To.some((to) => to.Address === email)).map((message) => message.ID));
    if (!page.messages.length || start + page.messages.length >= page.messages_count) return ids;
  }
}

export async function mailpitMessageText(id: string): Promise<string> {
  return messageSchema.parse(await (await mailpit(`message/${encodeURIComponent(id)}`)).json()).Text;
}

// Deletes the recipient's messages by ID. Without IDs, Mailpit's DELETE would clear the inbox.
export async function deleteMailpitMessagesTo(email: string): Promise<void> {
  const ids = await mailpitMessageIds(email);
  if (ids.length) await mailpit("messages", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ IDs: ids }) });
}
