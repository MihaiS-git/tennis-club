export type FlashMessage = {
  kind: "error" | "success";
  text: string;
};

type SearchParams = Pick<URLSearchParams, "get" | "toString">;

export function readFlashMessages(searchParams: SearchParams): FlashMessage[] {
  const messages: FlashMessage[] = [];
  const message = searchParams.get("message");
  const error = searchParams.get("error");

  if (message) messages.push({ kind: "success", text: message });
  if (error) messages.push({ kind: "error", text: error });

  return messages;
}

export function removeConsumedFlashMessages(searchParams: SearchParams): string {
  const remaining = new URLSearchParams(searchParams.toString());

  if (searchParams.get("message")) remaining.delete("message");
  if (searchParams.get("error")) remaining.delete("error");

  return remaining.toString();
}
