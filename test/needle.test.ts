import assert from "node:assert/strict";
import { test } from "node:test";

import { pinnedNeedleVersion } from "../src/needle.ts";

test("reads the cactus-needle pin from package.json", async () => {
  assert.equal(await pinnedNeedleVersion(), "3.2.0");
});
