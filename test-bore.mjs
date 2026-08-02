import { install, bin, spawn } from "bore-node";
import fs from "node:fs";

const binPath = bin;
console.log("Bin path:", binPath);

if (!fs.existsSync(binPath)) {
  console.log("Installing bore...");
  await install(binPath);
}

console.log("Bore exists:", fs.existsSync(binPath));
console.log("Bore path:", binPath);

if (fs.existsSync(binPath)) {
  const result = spawn(["--version"], { stdio: "inherit" });
  console.log("Spawn result:", result);
}
