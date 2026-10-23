// Drives `tsc --lsp` the way VS Code's TypeScript 7 extension does, against examples/native-demo,
// and prints what the editor would get: diagnostics, hovers, definitions, references, rename edits.
// Usage: node scripts/lsp-probe.cjs. Needs no editor; shows what VS Code would receive.
const { spawn } = require("child_process");
const { readFileSync } = require("fs");
const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");

const root = path.resolve(__dirname, "..");
// The package's launcher finds this platform's compiler and passes stdio through to it.
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const demo = path.join(root, "examples/native-demo");
const uri = (file) => pathToFileURL(path.join(demo, file)).href;
const text = (file) => readFileSync(path.join(demo, file), "utf8");
const short = (u) => path.basename(fileURLToPath(u));

const server = spawn(process.execPath, [tsc, "--lsp", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
const registrations = [];
const logs = [];
const pushed = new Map();

server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
    buffer = buffer.subarray(headerEnd + 4 + length);
    onMessage(message);
  }
});

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  server.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
  server.stdin.write(payload);
}
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function onMessage(message) {
  if (message.method && message.id !== undefined) {
    // A request from the server: answer like a minimal client.
    let result = null;
    if (message.method === "workspace/configuration") result = message.params.items.map(() => null);
    if (message.method === "client/registerCapability") {
      for (const r of message.params.registrations) registrations.push({ method: r.method, selector: r.registerOptions?.documentSelector });
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } else if (message.id !== undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.method === "window/logMessage") {
    logs.push(message.params.message);
  } else if (message.method === "textDocument/publishDiagnostics") {
    pushed.set(short(message.params.uri), message.params.diagnostics);
  }
}

/** LSP position of `needle` (its `occurrence`-th match) in `source`, shifted by `shift` characters. */
function position(source, needle, shift = 0) {
  const at = source.indexOf(needle) + shift;
  if (at < shift) throw new Error(`not found: ${needle}`);
  const before = source.slice(0, at);
  return { line: before.split("\n").length - 1, character: at - before.lastIndexOf("\n") - 1 };
}
const where = (loc) => {
  const target = loc.targetUri ?? loc.uri;
  const range = loc.targetSelectionRange ?? loc.range;
  return `${short(target)}:${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
};
const hoverText = (r) => {
  const c = r.result?.contents;
  return c ? (typeof c === "string" ? c : c.value ?? JSON.stringify(c)).replace(/\n+/g, " | ") : `(no hover) ${JSON.stringify(r.error ?? null)}`;
};
const list = (r) => (r.error ? `ERROR ${r.error.message}` : [].concat(r.result ?? []).map(where).join(", ") || "(none)");

async function main() {
  const init = await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: "ts-polyglot" }],
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      textDocument: {
        synchronization: { dynamicRegistration: true },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        references: {},
        rename: { prepareSupport: true },
        publishDiagnostics: {},
        diagnostic: { dynamicRegistration: true },
      },
      workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } },
    },
    // What the extension sends: runExternalCode = js/ts.contentMappers.enabled; logVerbosity 1 = Trace.
    initializationOptions: { runExternalCode: true, logVerbosity: 1 },
  });
  console.log("server:", init.result?.serverInfo?.name, init.result?.serverInfo?.version ?? "");
  notify("initialized", {});

  const main = text("main.ts");
  notify("textDocument/didOpen", { textDocument: { uri: uri("main.ts"), languageId: "typescript", version: 1, text: main } });

  const mainDiags = await request("textDocument/diagnostic", { textDocument: { uri: uri("main.ts") } });
  console.log("\nmain.ts diagnostics:", mainDiags.error ? `ERROR ${mainDiags.error.message}` : (mainDiags.result?.items ?? []).map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`).join(" / ") || "none");

  const addCall = position(main, ", add(1, 2));", 2);
  const fibCall = position(main, ", fib(50));", 2);
  console.log("\nhover add(...)      :", hoverText(await request("textDocument/hover", { textDocument: { uri: uri("main.ts") }, position: addCall })));
  console.log("hover fib(...)      :", hoverText(await request("textDocument/hover", { textDocument: { uri: uri("main.ts") }, position: fibCall })));
  console.log("definition add      :", list(await request("textDocument/definition", { textDocument: { uri: uri("main.ts") }, position: addCall })));
  console.log("definition fib      :", list(await request("textDocument/definition", { textDocument: { uri: uri("main.ts") }, position: fibCall })));
  console.log("definition hypotenuse:", list(await request("textDocument/definition", { textDocument: { uri: uri("main.ts") }, position: position(main, ", hypotenuse(3, 4));", 2) })));
  console.log("definition './add.cpp':", list(await request("textDocument/definition", { textDocument: { uri: uri("main.ts") }, position: position(main, '"./add.cpp"', 3) })));
  console.log("references add      :", list(await request("textDocument/references", { textDocument: { uri: uri("main.ts") }, position: addCall, context: { includeDeclaration: true } })));

  const multiplyCall = position(main, ", multiply(6, 7));", 2);
  const rename = await request("textDocument/rename", { textDocument: { uri: uri("main.ts") }, position: multiplyCall, newName: "times" });
  const changes = rename.result?.changes ?? Object.fromEntries((rename.result?.documentChanges ?? []).map((c) => [c.textDocument.uri, c.edits]));
  console.log("rename multiply→times:", rename.error ? `ERROR ${rename.error.message}` : Object.entries(changes).map(([u, edits]) => `${short(u)}: ${edits.map((e) => `${e.range.start.line + 1}:${e.range.start.character + 1} ${JSON.stringify(e.newText)}`).join(" ")}`).join(" | ") || "(no edits)");

  const cpp = text("add.cpp");
  notify("textDocument/didOpen", { textDocument: { uri: uri("add.cpp"), languageId: "cpp", version: 1, text: cpp } });
  console.log("\nhover add in add.cpp:", hoverText(await request("textDocument/hover", { textDocument: { uri: uri("add.cpp") }, position: position(cpp, "add(int a", 0) })));
  const cppDiags = await request("textDocument/diagnostic", { textDocument: { uri: uri("add.cpp") } });
  console.log("add.cpp diagnostics :", cppDiags.error ? `ERROR ${cppDiags.error.message}` : (cppDiags.result?.items ?? []).map((d) => d.message).join(" / ") || "none");

  // Rename at the declaration, inside add.cpp.
  const renameInCpp = await request("textDocument/rename", { textDocument: { uri: uri("add.cpp") }, position: position(cpp, "multiply(int a", 0), newName: "times" });
  const cppChanges = renameInCpp.result?.changes ?? Object.fromEntries((renameInCpp.result?.documentChanges ?? []).map((c) => [c.textDocument.uri, c.edits]));
  console.log("rename in add.cpp   :", renameInCpp.error ? `ERROR ${renameInCpp.error.message}` : Object.entries(cppChanges).map(([u, edits]) => `${short(u)}: ${edits.map((e) => `${e.range.start.line + 1}:${e.range.start.character + 1} ${JSON.stringify(e.newText)}`).join(" ")}`).join(" | ") || "(no edits)");

  // Edit the C++ signature as if typing in the editor: add() now takes one parameter.
  const edited = cpp.replace("int add(int a, int b)", "int add(int a)").replace("return a + b;", "return a;");
  notify("textDocument/didChange", { textDocument: { uri: uri("add.cpp"), version: 2 }, contentChanges: [{ text: edited }] });
  const after = await request("textDocument/diagnostic", { textDocument: { uri: uri("main.ts") } });
  console.log("main.ts after edit  :", after.error ? `ERROR ${after.error.message}` : (after.result?.items ?? []).map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`).join(" / ") || "none");

  console.log("\nregistered for sync :", JSON.stringify(registrations.filter((r) => /didOpen|textDocumentSync|diagnostic/i.test(r.method))));
  const mapperLogs = logs.filter((l) => /content mapper/i.test(l));
  console.log(`mapper log lines    : ${mapperLogs.length}`);
  for (const l of mapperLogs.slice(0, 4)) console.log("   ", l.slice(0, 220).replace(/\s+/g, " "));

  await request("shutdown", null);
  notify("exit", null);
  setTimeout(() => process.exit(0), 500);
}

setTimeout(() => {
  console.log("TIMEOUT; mapper logs so far:", logs.filter((l) => /content mapper/i.test(l)).slice(0, 5));
  process.exit(1);
}, 90_000);
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
