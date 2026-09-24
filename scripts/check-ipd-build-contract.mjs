#!/usr/bin/env node
// Keep the IPD source declaration aligned before running compiler/install checks.
import { fileURLToPath } from "node:url";
import { assertIpdDependencyDeclarations } from "./ipd-install-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assertIpdDependencyDeclarations(root);
console.log("IPD internal dependency declarations match their current workspace versions.");
