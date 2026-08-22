import { access } from "node:fs/promises";
import { createSecureComputerRuntime } from "../servers/secure-computer/index";

const html = `<!doctype html>
<html lang="ko">
<body>
  <div style="position:absolute;left:20px;top:20px;width:320px;height:30px">
    연락처 010-1234-5678
  </div>
  <input aria-label="메모" style="position:absolute;left:20px;top:70px;width:300px;height:36px">
  <button style="position:absolute;left:20px;top:130px;width:180px;height:40px">다음 단계</button>
  <button style="position:absolute;left:20px;top:200px;width:180px;height:40px">최종 제출</button>
</body>
</html>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
await access(executablePath);
const computer = await createSecureComputerRuntime({
  allowedHosts: ["127.0.0.1"],
  caseId: "secure-computer-qa",
  redactionKey: new Uint8Array(32).fill(0x44),
  executablePath,
  headless: true,
  maxActions: 4,
  viewport: { width: 800, height: 600 },
});

try {
  await computer.start(`http://127.0.0.1:${server.port}`);
  const first = await computer.observe();
  if (first.maskedText.includes("010-1234-5678")) {
    throw new Error("Raw phone number escaped the local redaction boundary");
  }
  const rawText = await computer.act({
    kind: "type-text",
    x: 100,
    y: 88,
    text: "010-1234-5678",
    observationDigest: first.observationDigest,
  });
  if (rawText.outcome !== "rejected") throw new Error("Raw identifier input was not rejected");
  const reversible = await computer.act({
    kind: "click",
    x: 100,
    y: 150,
    observationDigest: first.observationDigest,
  });
  if (reversible.outcome !== "executed") throw new Error("Reversible action was not executed");
  const stale = await computer.act({
    kind: "click",
    x: 100,
    y: 150,
    observationDigest: first.observationDigest,
  });
  if (stale.outcome !== "rejected") throw new Error("Stale observation was not rejected");
  const second = await computer.observe();
  const finalSubmit = await computer.act({
    kind: "click",
    x: 100,
    y: 220,
    observationDigest: second.observationDigest,
  });
  if (finalSubmit.outcome !== "requires-user") {
    throw new Error("Final filing did not require user takeover");
  }
  process.stdout.write(
    `${JSON.stringify({
      scenario: "secure-computer-browser",
      status: "PASS",
      masked: true,
      rawIdentifierRejected: true,
      staleDigestRejected: true,
      finalSubmissionRequiresUser: true,
    })}\n`,
  );
} finally {
  await computer.close();
  server.stop(true);
}
