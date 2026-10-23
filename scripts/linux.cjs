// Runs the checks on Linux from any OS with Docker: npm ci, the type check, the tests, the example and
// the LSP probe, in a container built from linux.Dockerfile. Usage: npm run test:linux.
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const image = "ts-polyglot-linux";

function docker(args) {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

docker(["build", "--tag", image, "--file", path.join(__dirname, "linux.Dockerfile"), __dirname]);
// The repo is copied into the container rather than used in place: its node_modules holds this
// machine's junctions and binaries, and the container installs its own.
const copy = "mkdir /work && tar -C /src --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C /work -xf -";
const steps = [copy, "cd /work", "npm ci", "npm run typecheck", "npm test", "npm run example", "node scripts/lsp-probe.cjs"];
docker(["run", "--rm", "--volume", `${root}:/src:ro`, image, "bash", "-c", steps.join(" && ")]);
