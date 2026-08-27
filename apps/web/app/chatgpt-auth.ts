import { headers } from "next/headers";

export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  if (process.env.NODE_ENV === "development") {
    const localUserId = requestHeaders.get("x-local-test-user-id");
    const localEmail = requestHeaders.get("x-local-test-user-email");
    if (localUserId && localEmail) {
      return { userId: localUserId, displayName: localEmail, email: localEmail, fullName: null };
    }
  }
  const userId = requestHeaders.get(USER_ID_HEADER);
  const email = requestHeaders.get(USER_EMAIL_HEADER);

  if (!userId || !email) {
    if (process.env.NODE_ENV === "development") {
      return {
        userId: "local-development-user",
        displayName: "本地管理员",
        email: "local@sites.test",
        fullName: "本地管理员"
      };
    }
    return null;
  }

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName && requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    userId,
    displayName: fullName ?? email,
    email,
    fullName
  };
}

export function chatGPTSignInPath(returnTo = "/"): string {
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  return `/signout-with-chatgpt?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local" || isReservedAuthPath(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function isReservedAuthPath(pathname: string): boolean {
  return ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"].includes(pathname);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
