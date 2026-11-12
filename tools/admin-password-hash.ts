import { hashPassword, PBKDF2_ITERATIONS } from "../src/lib/admin/password.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const password = Buffer.concat(chunks)
  .toString("utf8")
  .replace(/\r?\n$/, "");
const iterations =
  process.env.ITERATIONS === undefined
    ? PBKDF2_ITERATIONS
    : Number(process.env.ITERATIONS);
console.log(await hashPassword(password, iterations));
