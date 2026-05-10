import { createHiveServer } from "./server.js";

const { host, port } = parseArgs(process.argv.slice(2));
const server = createHiveServer();

server.listen(port, host, () => {
  const address = server.address();
  const display =
    typeof address === "object" && address
      ? `${address.address}:${address.port}`
      : `${host}:${port}`;
  console.log(`HivePlane Hive listening on http://${display}`);
});

function parseArgs(args: string[]): { host: string; port: number } {
  let host = process.env.HIVEPLANE_HIVE_HOST ?? "127.0.0.1";
  let port = Number(process.env.HIVEPLANE_HIVE_PORT ?? 8787);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--host") host = requireValue(args, ++index, "--host");
    if (arg === "--port") port = Number(requireValue(args, ++index, "--port"));
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port: ${port}`);
  }

  return { host, port };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
