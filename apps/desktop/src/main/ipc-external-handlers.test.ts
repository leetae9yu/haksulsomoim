import { describe, expect, mock, test } from "bun:test";
import {
  createOpenOfficialSourceHandler,
  createOpenTrustedAuthenticationHandler,
} from "./ipc-handlers";

describe("validated desktop external controls", () => {
  test("opens only validated official sources through the main process", async () => {
    const openExternal = mock(async (_url: string) => undefined);
    const openOfficialSource = createOpenOfficialSourceHandler(openExternal);

    await openOfficialSource({ url: "https://law.go.kr/법령/민법" });
    await openOfficialSource({ url: "https://www.law.go.kr/법령/민법" });
    expect(openExternal).toHaveBeenNthCalledWith(1, "https://law.go.kr/법령/민법");
    expect(openExternal).toHaveBeenNthCalledWith(2, "https://www.law.go.kr/법령/민법");
    await expect(openOfficialSource({ url: "https://law.go.kr.evil.example/" })).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  test("opens authentication separately and only on the exact trusted origin", async () => {
    const openExternal = mock(async (_url: string) => undefined);
    const openAuthentication = createOpenTrustedAuthenticationHandler(openExternal);

    await openAuthentication({ url: "https://auth.openai.com/oauth/authorize?state=opaque" });
    expect(openExternal).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?state=opaque",
    );
    await expect(
      openAuthentication({ url: "https://auth.openai.com.evil.example/oauth/authorize" }),
    ).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
