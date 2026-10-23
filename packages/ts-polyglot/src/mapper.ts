// The content mapper process. tsc starts it with the command in package.json ("typescript.contentMapper.exec")
// and sends JSON-RPC 2.0 requests over stdin, framed by Content-Length headers; it answers on stdout.
import { toDeclarations } from "./declarations.ts";
import type { InitializeParams, InitializeResult, TransformParams, TransformResult } from "./protocol.ts";

const handlers: Record<string, (params: never) => unknown> = {
  initialize({ positionEncodings }: InitializeParams): InitializeResult {
    if (!positionEncodings.includes("utf-16")) throw new Error("ts-polyglot only supports UTF-16 positions");
    return { positionEncoding: "utf-16", diagnosticSource: "ts-polyglot" };
  },
  openProject: () => ({}),
  // Types only: nothing is compiled here. The addon is built when Node imports the file.
  transform: ({ fileName, content }: TransformParams): TransformResult => toDeclarations(fileName, content),
  closeProject: () => ({}),
};

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    respond(JSON.parse(body));
  }
});

function respond({ id, method, params }: { id: number | string; method: string; params?: unknown }): void {
  let response;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method ${method}`);
    response = { jsonrpc: "2.0", id, result: handler(params as never) };
  } catch (error) {
    response = { jsonrpc: "2.0", id, error: { code: -32603, message: String(error) } };
  }
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}
