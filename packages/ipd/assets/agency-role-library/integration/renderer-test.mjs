import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [modulePath, fixturesPath] = process.argv.slice(2);
if (!modulePath || !fixturesPath) throw new Error("Usage: node renderer-test.mjs <compiled-js> <fixtures-json>");
const { renderAgentProfile } = await import(pathToFileURL(modulePath).href);
const fixtures = JSON.parse(await readFile(fixturesPath, "utf8"));
let checkedLines = 0;
for (const card of fixtures) {
  const original = JSON.stringify(card);
  const output = renderAgentProfile(card);
  assert.equal(output, renderAgentProfile(card), `${card.id}: nondeterministic`);
  assert.equal(JSON.stringify(card), original, `${card.id}: mutated input`);
  const fields = [card.name, card.description, ...card.responsibilities, ...card.nonResponsibilities,
    ...(card.applicableScenarios ?? []), ...(card.principles ?? []), ...(card.deliverables ?? []),
    ...(card.promptProfile?.approach ?? []), ...(card.promptProfile?.communication ?? []),
    ...(card.promptProfile?.verification ?? [])];
  for (const field of fields) for (const line of field.split("\n").map(x => x.trim()).filter(Boolean)) {
    assert(output.includes(line), `${card.id}: omitted text ${line.slice(0, 60)}`);
    checkedLines++;
  }
}
assert(!renderAgentProfile({name:"minimal",description:"d",responsibilities:["r"],nonResponsibilities:[]}).includes("undefined"));
console.log(JSON.stringify({profiles:fixtures.length, checkedLines, deterministic:true, mutationFree:true, minimalProfile:true}, null, 2));
