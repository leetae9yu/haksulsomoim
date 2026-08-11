export type ChatGptAccount = Readonly<{
  type: "chatgpt";
  email: string | null;
  planType: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readChatGptAccount(response: unknown): ChatGptAccount | null {
  if (!isRecord(response) || !isRecord(response.account)) return null;
  const { account } = response;
  if (
    account.type !== "chatgpt" ||
    (account.email !== null && typeof account.email !== "string") ||
    typeof account.planType !== "string"
  ) {
    return null;
  }
  return Object.freeze({ type: "chatgpt", email: account.email, planType: account.planType });
}
