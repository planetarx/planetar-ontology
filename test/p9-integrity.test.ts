/*
 * p9-integrity.test.ts — the store refuses to open a corrupt database.
 *
 * Background: on 2026-07-30 the live planetar-ontology.db went "database
 * disk image is malformed" mid-run. Inserts kept succeeding while every
 * retention prune threw (and was swallowed by the ingest loop), so the file
 * grew from ~500 k observations to 20 M / 14 GB and the API hung. Two pm2
 * restarts carried the corrupt file forward because nothing checked it.
 * A startup quick_check turns that into a loud, immediate failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";

const PAGE = 4096;

/** Build a healthy multi-page database on disk and close it. */
function healthyDb(dir: string): string {
  const path = join(dir, "ontology.db");
  const store = new Store(path);
  store.db.exec("CREATE TABLE junk (x TEXT);");
  const ins = store.db.prepare("INSERT INTO junk (x) VALUES (?)");
  for (let i = 0; i < 3000; i++) ins.run(`row-${i}-`.padEnd(120, "x"));
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  store.db.close();
  return path;
}

/** Overwrite the header of page 3 with garbage — a b-tree page, never page 1. */
function corrupt(path: string): void {
  const fd = openSync(path, "r+");
  writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, PAGE * 2);
  closeSync(fd);
}

test("a healthy on-disk database reopens", () => {
  const dir = mkdtempSync(join(tmpdir(), "p9-"));
  try {
    const path = healthyDb(dir);
    const store = new Store(path);
    assert.equal(store.count("observation"), 0);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt on-disk database is refused at open with a quick_check message", () => {
  const dir = mkdtempSync(join(tmpdir(), "p9-"));
  try {
    const path = healthyDb(dir);
    corrupt(path);
    assert.throws(
      () => new Store(path),
      (e: unknown) =>
        e instanceof Error &&
        /quick_check/.test(e.message) &&
        e.message.includes(path),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
