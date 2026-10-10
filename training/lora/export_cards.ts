// Reuse the app's prompt assembler. Never train on its few-shot examples:
// some of those may belong to held-out MomoTalk episodes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PERSONA_VERSION,
  personaById,
  systemPromptFor,
} from "../../src/lib/ai/persona.ts";

const ids = process.argv.slice(2);
if (!ids.length) throw new Error("Pass character IDs");
const cards = Object.fromEntries(
  ids.map((id) => {
    const p = personaById(id);
    if (!p) throw new Error(`Unknown character: ${id}`);
    return [
      id,
      {
        version: 1,
        id,
        name: p.name,
        register: p.register,
        factions: p.factions,
        system: systemPromptFor(id),
      },
    ];
  }),
);
const bytes = readFileSync(
  new URL("../../public/resource/persona/characters.json", import.meta.url),
);
console.log(
  JSON.stringify({
    persona_version: PERSONA_VERSION,
    persona_sha256: createHash("sha256").update(bytes).digest("hex"),
    cards,
  }),
);
