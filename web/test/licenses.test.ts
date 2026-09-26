import { test } from "node:test";
import assert from "node:assert/strict";

import { authorOf, citation, creditsOf, documented, licenseOf, type Provenance } from "../src/data/licenses.ts";

// The recordings as they are in production (2026-09-26).
const salamander: Provenance = {
  id: "rec_salamander-drumkit",
  title: "Salamander Drumkit",
  collection: "salamander-drumkit",
  credit: "Alexander Holm, Salamander Drumkit (Internet Archive).",
  sourcePage: "https://archive.org/details/SalamanderDrumkit",
  rights: "CC BY-SA 3.0, Alexander Holm; share-alike applies if you modify the samples. https://creativecommons.org/licenses/by-sa/3.0/",
};
const thunderer: Provenance = {
  id: "rec_Thunderer",
  title: "The Thunderer",
  collection: "marine-band",
  composed: 1889,
  recorded: "2017",
  performer: "\"The President's Own\" United States Marine Band",
  credit: "\"The President's Own\" United States Marine Band, The Complete Marches of John Philip Sousa, Vol. 3.",
  sourcePage: "https://www.marineband.marines.mil/Audio-Resources/The-Complete-Marches-of-John-Philip-Sousa/The-Thunderer-March/",
  rights: "Public domain (composition pre-1923; recording is a work of the U.S. Government).",
};
const schwartz: Provenance = { id: "rec_ts", title: "St Patricks parade", credit: "Citizen DJ Project, Tony Schwartz Collection at the Library of Congress.", rights: "Free to use and reuse per the Library of Congress (Citizen DJ selection).", sourcePage: "https://citizen-dj.labs.loc.gov/loc-tony-schwartz/use/" };
const jukebox: Provenance = { id: "rec_j", title: "Minor march", rights: "Public domain (published before 1923; Music Modernization Act)." };
const edison: Provenance = { id: "rec_e", title: "True to the flag march", rights: "Public domain (Edison recordings 1890-1929; assets transferred to the National Park Service)." };
const upload: Provenance = { id: "rec_uploads_kick", title: "uploads_kick_OH_F_1", collection: "uploads" };

test("licenses are read from the rights text when not set", () => {
  assert.equal(licenseOf(salamander)?.code, "cc-by-sa-3.0");
  assert.equal(licenseOf(thunderer)?.code, "us-gov");
  assert.equal(licenseOf(schwartz)?.code, "loc-free");
  assert.equal(licenseOf(jukebox)?.code, "public-domain");
  assert.equal(licenseOf(edison)?.code, "public-domain");
  assert.equal(licenseOf(upload), null);
  assert.equal(licenseOf({ ...upload, license: "cc0-1.0" })?.code, "cc0-1.0", "its own field wins");
  assert.equal(licenseOf({ ...salamander, license: "nonsense" })?.code, "cc-by-sa-3.0");
});

test("documented: a license, and someone to credit when credit is required", () => {
  for (const r of [salamander, thunderer, schwartz, jukebox, edison]) assert.ok(documented(r), r.title!);
  assert.equal(documented(upload), false);
  assert.equal(documented({ title: "x", license: "cc-by-4.0" }), false, "CC BY with nobody to credit");
  assert.equal(documented({ title: "x", license: "cc-by-4.0", author: "Ann" }), true);
  assert.equal(authorOf(salamander), "Alexander Holm");
});

test("citations: required credit names the author, source, license and changes; courtesy credit the facts", () => {
  assert.equal(
    citation(salamander),
    "“Salamander Drumkit” by Alexander Holm (archive.org/details/SalamanderDrumkit), CC BY-SA 3.0 (creativecommons.org/licenses/by-sa/3.0). Sliced, time-stretched and re-pitched in Apricity.",
  );
  const t = citation(thunderer);
  assert.match(t, /^“The Thunderer”, composed 1889, recorded 2017 by "The President's Own" United States Marine Band\./);
  assert.match(t, /U\.S\. Government work \(public domain\)\./);
  assert.doesNotMatch(t, /Sliced/, "no changes note for public domain");
  assert.equal(citation({ ...salamander, attribution: "Drums: Alexander Holm, CC BY-SA 3.0." }), "Drums: Alexander Holm, CC BY-SA 3.0.");
});

test("credits: once per recording, with the share-alike notice when any asks", () => {
  const c = creditsOf([thunderer, salamander, thunderer, upload]);
  assert.deepEqual(c.lines.map((l) => [l.title, l.documented]), [["The Thunderer", true], ["Salamander Drumkit", true], ["uploads_kick_OH_F_1", false]]);
  assert.equal(c.shareAlike?.code, "cc-by-sa-3.0");
  assert.equal(creditsOf([thunderer, jukebox]).shareAlike, null);
});
