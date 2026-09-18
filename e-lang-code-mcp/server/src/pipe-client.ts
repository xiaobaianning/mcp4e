import net from "node:net";

export const defaultPipePath = "\\\\.\\pipe\\e-lang-code-mcp";

interface BridgeResponse<T> {
  id: number;
  ok: boolean;
  result?: T;
  error?: string;
}

const RETRYABLE_CODES = new Set(["ENOENT", "EBUSY", "EAGAIN", "ECONNREFUSED"]);

function describe(error: NodeJS.ErrnoException): string {
  if (error.code && RETRYABLE_CODES.has(error.code)) {
    return "易语言 IDE 未运行，或未在“支持库配置”里启用「易语言 MCP 桥接支持库」。";
  }
  return error.message;
}

/**
 * 与易语言 IDE 内的 C++ 支持库通信：每次调用一条命名管道短连接，
 * 发送一行 JSON 请求，读回一行 JSON 响应。
 *
 * 命名管道服务在两次请求之间重建实例的瞬间可能暂时不可连（ENOENT/EBUSY），
 * 因此这里对“连接建立前”的错误做短重试。**只在尚未发出请求时重试**，
 * 避免重复提交写操作。
 */
export class BridgeClient {
  private nextId = 1;

  public constructor(
    private readonly pipePath = process.env.E_LANG_MCP_PIPE ?? defaultPipePath,
    private readonly timeoutMs = 30_000,
  ) {}

  public async call<T>(method: string, params: unknown = {}): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 25; ++attempt) {
      try {
        return await this.callOnce<T>(method, params);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = (error as { retryable?: boolean }).retryable === true;
        if (retryable && attempt < 24) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error(`桥接调用失败: ${method}`);
  }

  private callOnce<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const request = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      let buffer = "";
      let settled = false;
      let connected = false;

      const finish = (error?: Error, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };

      const timer = setTimeout(() => {
        finish(new Error(`易语言桥接调用超时: ${method}`));
      }, this.timeoutMs);

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        connected = true;
        socket.write(request);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as BridgeResponse<T>;
          if (response.id !== id) {
            finish(new Error(`易语言桥接响应编号不匹配: ${response.id}`));
          } else if (!response.ok) {
            finish(new Error(response.error ?? `IDE 调用失败: ${method}`));
          } else {
            finish(undefined, response.result as T);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        const wrapped = new Error(describe(error)) as Error & { retryable?: boolean };
        // 只有连接建立前的错误可以安全重试。
        wrapped.retryable = !connected;
        finish(wrapped);
      });
      socket.on("end", () => {
        if (!settled) finish(new Error(`易语言桥接提前关闭连接: ${method}`));
      });
    });
  }
}
