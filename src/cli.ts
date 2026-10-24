#!/usr/bin/env node
import { App } from "@/app";

const argv = process.argv.slice(2);
// Everything after exec belongs to the child, including --help and unknown flags.
if (argv[0] === "exec" && argv[1] !== "--") {
  argv.splice(1, 0, "--");
}
await App.execute({ argv });
