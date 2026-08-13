import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { agentArtifactViewSchema, agentRunProjectionSchema } from "../../contracts/desktop-api";
import { completedProjection } from "./agent-workspace-test-fixtures";
import { useAgentArtifact } from "./use-agent-artifact";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const artifact = agentArtifactViewSchema.parse({
  artifactId: "artifact-1",
  artifactKind: "civil-demand",
  title: "안전한 초안",
  sections: [{ heading: "확인 사실", text: "마스킹됨" }],
  citationIds: ["law-1"],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function projection(revision = 1) {
  return agentRunProjectionSchema.parse({ ...completedProjection(), revision });
}

afterEach(cleanup);

test("binds an artifact response to its captured digest and projection revision", async () => {
  const pendingDigest = deferred<typeof artifact>();
  const pendingRevision = deferred<typeof artifact>();
  const open = mock(async () => pendingDigest.promise);
  Object.defineProperty(window, "haksul", {
    configurable: true,
    value: { openAgentArtifact: open },
  });
  const { result, rerender } = renderHook(
    ({ digest, revision }) => useAgentArtifact("case-1", projection(revision), digest),
    { initialProps: { digest: digestA, revision: 1 } },
  );

  act(() => result.current.open("artifact-1"));
  rerender({ digest: digestB, revision: 1 });
  await act(async () => pendingDigest.resolve(artifact));
  expect(result.current.view).toBeUndefined();

  open.mockImplementation(async () => pendingRevision.promise);
  act(() => result.current.open("artifact-1"));
  rerender({ digest: digestB, revision: 2 });
  await act(async () => pendingRevision.resolve(artifact));
  expect(result.current.view).toBeUndefined();
});

test("clears sensitive content before open and announces a stale rejection", async () => {
  const open = mock(async () => artifact);
  Object.defineProperty(window, "haksul", {
    configurable: true,
    value: { openAgentArtifact: open },
  });
  const { result } = renderHook(() => useAgentArtifact("case-1", projection(), digestA));
  act(() => result.current.open("artifact-1"));
  await waitFor(() => expect(result.current.view).toEqual(artifact));

  const rejected = deferred<typeof artifact>();
  open.mockImplementation(async () => rejected.promise);
  act(() => result.current.open("artifact-1"));
  expect(result.current.view).toBeUndefined();
  await act(async () => rejected.reject(new Error("Agent context consent is stale")));
  expect(result.current.error).toBe("암호화 초안을 안전하게 열 수 없습니다.");
  expect(result.current.view).toBeUndefined();
});

test("accepts only the latest matching artifact request and identity", async () => {
  const first = deferred<typeof artifact>();
  const second = deferred<typeof artifact>();
  const open = mock(async () => (open.mock.calls.length === 1 ? first.promise : second.promise));
  Object.defineProperty(window, "haksul", {
    configurable: true,
    value: { openAgentArtifact: open },
  });
  const { result, rerender, unmount } = renderHook(
    ({ caseId }) => useAgentArtifact(caseId, projection(), digestA),
    { initialProps: { caseId: "case-1" } },
  );
  act(() => {
    result.current.open("artifact-1");
    result.current.open("artifact-1");
  });
  await act(async () => first.resolve(artifact));
  expect(result.current.view).toBeUndefined();
  await act(async () =>
    second.resolve(agentArtifactViewSchema.parse({ ...artifact, artifactId: "foreign-artifact" })),
  );
  expect(result.current.view).toBeUndefined();

  rerender({ caseId: "case-2" });
  expect(result.current.view).toBeUndefined();
  unmount();
});
