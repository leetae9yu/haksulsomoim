export type CodexAppServerMethod =
  | "initialize"
  | "account/read"
  | "account/login/start"
  | "thread/start"
  | "turn/start"
  | "turn/interrupt";

export type CodexAppServerRequest = Readonly<{
  method: CodexAppServerMethod;
  params: unknown;
}>;

export type CodexAppServerNotification = Readonly<{
  method: "account/login/completed" | "account/updated" | "item/completed" | "turn/completed";
  params: unknown;
}>;

export interface CodexAppServerConnection {
  request(request: CodexAppServerRequest): Promise<unknown>;
  notify(method: "initialized"): void;
  close(): Promise<void>;
  onNotification(
    listener: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void;
}

export type CodexAppServerStartResult =
  | Readonly<{ status: "ready"; connection: CodexAppServerConnection }>
  | Readonly<{ status: "binary-unavailable"; reason: string }>;

export type CodexAppServerLauncher = () => Promise<CodexAppServerStartResult>;

export interface CodexJsonLineProcess {
  send(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}
