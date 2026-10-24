// Prints what a JavaScript debugger sees: the URL of every script V8 has parsed. A native file must
// not be one of them, or the editor takes it for JavaScript, binds breakpoints set in it to the
// generated glue, and opens that glue under the native file's name.
import { Session } from "node:inspector";
import { add } from "./add.cpp";

const session = new Session();
session.connect();
const scripts: string[] = [];
session.on("Debugger.scriptParsed", ({ params }) => scripts.push(params.url));
session.post("Debugger.enable", () => {
  session.disconnect();
  console.log(JSON.stringify({ add: add(2, 3), scripts }));
});
