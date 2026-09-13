/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  classifyRoot,
  DEV_MARKER,
  isManagedInstall,
  refreshOwnedShim,
  shimScript,
} from "./version-layout.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function installation(t: { after(fn: () => void): void }): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-shim-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Built in release order, which is the reverse of the order their names sort in.
  for (const [name, age] of [
    ["0.3.9-bbbbbbbbbbbb", 2],
    ["0.3.14-aaaaaaaaaaaa", 1],
  ] as const) {
    mkdirSync(join(home, "versions", name, "bin"), { recursive: true });
    writeFileSync(
      join(home, "versions", name, "bin/iva.mjs"),
      `process.stdout.write(${JSON.stringify(name)});\n`,
    );
    const at = new Date(Date.now() - age * 60_000);
    utimesSync(join(home, "versions", name), at, at);
  }
  mkdirSync(join(home, "data"), { recursive: true });
  return home;
}

test("a shim without `current` runs the version the installation settled on", (t) => {
  const home = installation(t);
  const shim = join(home, "iva");
  writeFileSync(shim, shimScript(home, process.execPath, join(home, "data")));
  chmodSync(shim, 0o755);
  const run = (): string => execFileSync(shim, { encoding: "utf8" });

  // `current` is lost - the state the shim exists to survive.
  writeFileSync(
    join(home, "data/active.json"),
    `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.14-aaaaaaaaaaaa" })}\n`,
  );
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // No marker to go by: running something still beats running nothing, because
  // the command that repairs the installation is this one - and the newest build,
  // not the name that sorts last, or the repair starts an older release.
  rmSync(join(home, "data/active.json"));
  assert.equal(run(), "0.3.14-aaaaaaaaaaaa");

  // And an active version outranks both.
  symlinkSync(join(home, "versions/0.3.9-bbbbbbbbbbbb"), join(home, "current"));
  assert.equal(run(), "0.3.9-bbbbbbbbbbbb");
});

test("a shim reads active state from the canonical custom data directory", (t) => {
  const home = installation(t);
  const dataDir = join(home, 'state $ " ` \\');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "active.json"),
    `${JSON.stringify({ schema: "iva-active/v1", version: "0.3.9-bbbbbbbbbbbb" })}\n`,
  );
  const shim = join(home, "iva");
  writeFileSync(shim, shimScript(home, process.execPath, dataDir));
  chmodSync(shim, 0o755);

  assert.equal(execFileSync(shim, { encoding: "utf8" }), "0.3.9-bbbbbbbbbbbb");
  assert.throws(
    () => shimScript(home, process.execPath, `${dataDir}\nbroken`),
    /NUL or a newline/u,
  );
});

test("an owned shim refreshes its data snapshot without replacing a foreign command", (t) => {
  const home = installation(t);
  const shim = join(home, ".local/bin/iva");
  const firstData = join(home, "first data");
  const nextData = join(home, "next data");

  assert.equal(refreshOwnedShim(shim, home, process.execPath, firstData), true);
  assert.equal(refreshOwnedShim(shim, home, process.execPath, nextData), true);
  assert.equal(
    readFileSync(shim, "utf8"),
    shimScript(home, process.execPath, nextData),
  );

  const previousDirect = `#!/usr/bin/env bash\nexec "${process.execPath}" "${home}/bin/iva.mjs" "$@"\n`;
  writeFileSync(shim, previousDirect);
  assert.equal(refreshOwnedShim(shim, home, process.execPath, nextData), true);
  assert.equal(
    readFileSync(shim, "utf8"),
    shimScript(home, process.execPath, nextData),
  );

  const foreignExecutable = Buffer.from(
    `#!/usr/bin/env bash\nexec "/bin/echo" "${home}/bin/iva.mjs" "$@"\n`,
  );
  writeFileSync(shim, foreignExecutable);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), foreignExecutable);

  const foreignCurrent = Buffer.from(shimScript(home, "/bin/echo", firstData));
  writeFileSync(shim, foreignCurrent);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), foreignCurrent);

  const victim = join(home, "other-file");
  writeFileSync(victim, previousDirect);
  rmSync(shim);
  symlinkSync(victim, shim);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.equal(readFileSync(victim, "utf8"), previousDirect);
  rmSync(shim);

  linkSync(victim, shim);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.equal(readFileSync(victim, "utf8"), previousDirect);
  rmSync(shim);

  const previousOwned = shimScript(home, process.execPath, join(home, "data"))
    .replace(`IVA_DATA="${join(home, "data")}"\n`, "")
    .replace("$IVA_DATA/active.json", "$IVA_ROOT/data/active.json");
  writeFileSync(shim, previousOwned);
  assert.equal(refreshOwnedShim(shim, home, process.execPath, nextData), true);
  assert.equal(
    readFileSync(shim, "utf8"),
    shimScript(home, process.execPath, nextData),
  );

  writeFileSync(shim, "#!/bin/sh\necho foreign\n");
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.equal(readFileSync(shim, "utf8"), "#!/bin/sh\necho foreign\n");

  const substitution = Buffer.from(
    shimScript(home, process.execPath, join(home, "state/$(foreign)")).replace(
      "\\$(foreign)",
      "$(foreign)",
    ),
  );
  writeFileSync(shim, substitution);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), substitution);

  const hostile = Buffer.from(`#!/bin/sh\necho "${home}/reports"\n`);
  writeFileSync(shim, hostile);
  assert.equal(
    refreshOwnedShim(shim, home, process.execPath, firstData),
    false,
  );
  assert.deepEqual(readFileSync(shim), hostile);
});

test("a replacement arriving during refresh preserves both inodes", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs,{mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=mkdtempSync(join(tmpdir(),"iva-shim-swap-"));
try { const home=join(dir,"home"),shim=join(dir,"iva"),moved=join(dir,"moved");
mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`;
const foreign="#!/bin/sh\\necho foreign\\n"; writeFileSync(shim,old);
const lstat=fs.lstatSync; let swapped=false;
fs.lstatSync=((path,options)=>{const stat=lstat(path,options); if(path===shim&&!swapped){renameSync(shim,moved);writeFileSync(shim,foreign);swapped=true;}return stat;});
syncBuiltinESMExports();
const {refreshOwnedShim}=await import("./scripts/lib/version-layout.ts?swap-test");
const result=refreshOwnedShim(shim,home,process.execPath,join(home,"next"));
console.log(JSON.stringify({result,path:readFileSync(shim,"utf8"),moved:readFileSync(moved,"utf8")}));
} finally {rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const result = JSON.parse(output) as {
    result: boolean;
    path: string;
    moved: string;
  };
  assert.equal(result.result, false);
  assert.equal(result.path, "#!/bin/sh\necho foreign\n");
  assert.match(result.moved, /exec ".+" ".+\/bin\/iva\.mjs" "\$@"/u);
});

test("a replacement winning publication leaves an explicit recovery", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=fs.mkdtempSync(join(tmpdir(),"iva-shim-publish-"));
try {const home=join(dir,"home"),shim=join(dir,"iva"); fs.mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`;
const foreign="#!/bin/sh\\necho foreign\\n"; fs.writeFileSync(shim,old);
const open=fs.openSync; fs.openSync=(path,flags,...rest)=>{if(path===shim&&(flags&fs.constants.O_EXCL))fs.writeFileSync(shim,foreign);return open(path,flags,...rest);};
syncBuiltinESMExports();
const {refreshOwnedShim}=await import("./scripts/lib/version-layout.ts?publish-test");
const result=refreshOwnedShim(shim,home,process.execPath,join(home,"next"));
const recovery=fs.readdirSync(dir).find(name=>name.startsWith("iva.iva-recovery-"));
console.log(JSON.stringify({result,path:fs.readFileSync(shim,"utf8"),recovery:fs.readFileSync(join(dir,recovery,"previous"),"utf8")}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const result = JSON.parse(output) as {
    result: boolean;
    path: string;
    recovery: string;
  };
  assert.equal(result.result, false);
  assert.equal(result.path, "#!/bin/sh\necho foreign\n");
  assert.match(result.recovery, /exec ".+" ".+\/bin\/iva\.mjs" "\$@"/u);
});

test("a short shim write restores the complete previous command", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=fs.mkdtempSync(join(tmpdir(),"iva-shim-short-"));
try {const home=join(dir,"home"),shim=join(dir,"iva"); fs.mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`; fs.writeFileSync(shim,old);
const write=fs.writeSync; fs.writeSync=(fd,data,...rest)=>write(fd,data.subarray(0,1),...rest); syncBuiltinESMExports();
const {refreshOwnedShim}=await import("./scripts/lib/version-layout.ts?short-test");
let failed=false; try {refreshOwnedShim(shim,home,process.execPath,join(home,"next"));} catch {failed=true;}
console.log(JSON.stringify({failed,restored:fs.readFileSync(shim,"utf8")===old,entries:fs.readdirSync(dir)}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    failed: true,
    restored: true,
    entries: ["home", "iva"],
  });
});

test("a close error cannot hide a complete published shim", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os"; import {join} from "node:path";
const dir=fs.mkdtempSync(join(tmpdir(),"iva-shim-close-"));
try {const home=join(dir,"home"),shim=join(dir,"iva"),data=join(home,"next"); fs.mkdirSync(join(home,"bin"),{recursive:true});
const old=\`#!/usr/bin/env bash\\nexec "\${process.execPath}" "\${home}/bin/iva.mjs" "$@"\\n\`; fs.writeFileSync(shim,old);
const {refreshOwnedShim,shimScript}=await import("./scripts/lib/version-layout.ts?close-test");
const close=fs.closeSync; let injected=false; fs.closeSync=(fd)=>{if(!injected){injected=true;throw new Error("close boom");}return close(fd);}; syncBuiltinESMExports();
let error="",result=false; try {result=refreshOwnedShim(shim,home,process.execPath,data);} catch(cause){error=String(cause);}
fs.closeSync=close; syncBuiltinESMExports();
console.log(JSON.stringify({error,result,complete:fs.readFileSync(shim,"utf8")===shimScript(home,process.execPath,data),entries:fs.readdirSync(dir)}));
} finally {fs.rmSync(dir,{recursive:true,force:true});}`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(output), {
    error: "",
    result: true,
    complete: true,
    entries: ["home", "iva"],
  });
});

test("a checkout is an installation until `.iva-dev` says it is a working tree", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-managed-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "iva",
        GIT_AUTHOR_EMAIL: "iva@example.com",
        GIT_COMMITTER_NAME: "iva",
        GIT_COMMITTER_EMAIL: "iva@example.com",
      },
    }).trim();
  const home = join(dir, "iva");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "package.json"), "{}\n");
  git(home, "init", "--initial-branch=main");
  git(home, "add", "-A");
  git(home, "commit", "-m", "release");
  const managed = (root = home): boolean =>
    isManagedInstall(classifyRoot(root));

  // Exactly what install.sh leaves behind, and a shim nowhere near it: the route
  // never asks what is on PATH.
  assert.equal(managed(), true);

  // An installation is free to have edits, branches and commits of its own: a
  // rollback through `release/<v>` leaves a second branch behind, and none of it
  // makes the tree a working tree.
  writeFileSync(join(home, "package.json"), '{ "edited": true }\n');
  git(home, "checkout", "-q", "-b", "release/0.4.0");
  git(home, "commit", "-q", "--allow-empty", "-m", "mine");
  assert.equal(managed(), true);

  // The one thing that does: the file its owner writes.
  writeFileSync(join(home, DEV_MARKER), "");
  assert.equal(managed(), false);
  // A version under a marked home is still a version: the marker is about the checkout.
  const version = join(home, "versions", "0.4.2-abcdefabcdef");
  mkdirSync(version, { recursive: true });
  assert.equal(managed(version), true);
  rmSync(join(home, DEV_MARKER));
  assert.equal(managed(), true);
});

const ROUTE_SEED = 43_017;

/**
 * The invariant this route stands on: the answer is a function of the layout and one
 * marker file, and of nothing else. The predicates it replaced read git and the shim on
 * PATH - a branch of one's own, a commit ahead, which node the shim names - and every
 * user who had rolled back through `release/<v>` or moved node was declared a
 * developer's checkout and never updated again.
 */
test("property: the layout and `.iva-dev` decide the route, git and the shim never do", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-route-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "iva",
        GIT_AUTHOR_EMAIL: "iva@example.com",
        GIT_COMMITTER_NAME: "iva",
        GIT_COMMITTER_EMAIL: "iva@example.com",
      },
    }).trim();
  const home = join(dir, "iva");
  mkdirSync(home);
  writeFileSync(join(home, "package.json"), "{}\n");
  git(home, "init", "--initial-branch=main");
  git(home, "add", "-A");
  git(home, "commit", "-m", "release");
  const version = join(home, "versions", "0.4.2-abcdefabcdef");
  mkdirSync(version, { recursive: true });
  const ours = shimScript(home, process.execPath, join(home, "data"));
  const shim = join(dir, "iva-shim");
  const marker = join(home, DEV_MARKER);

  fc.assert(
    fc.property(
      fc.record({
        shim: fc.constantFrom(
          "ours" as const,
          "missing" as const,
          "foreign" as const,
          "junk" as const,
        ),
        marker: fc.constantFrom(
          "none" as const,
          "empty" as const,
          "junk" as const,
          "directory" as const,
        ),
        junk: fc.string(),
        branches: fc.integer({ min: 1, max: 3 }),
        commits: fc.integer({ min: 0, max: 2 }),
        dirty: fc.boolean(),
      }),
      (world) => {
        for (let ahead = 0; ahead < world.commits; ahead += 1)
          git(home, "commit", "-q", "--allow-empty", "-m", "mine");
        for (let extra = 1; extra < world.branches; extra += 1)
          git(home, "branch", "-f", `release/0.4.${extra}`, "HEAD");
        writeFileSync(
          join(home, "package.json"),
          world.dirty ? `{ "edited": ${world.junk.length} }\n` : "{}\n",
        );
        rmSync(shim, { force: true });
        if (world.shim === "ours") writeFileSync(shim, ours);
        else if (world.shim === "junk") writeFileSync(shim, world.junk);
        else if (world.shim === "foreign")
          writeFileSync(shim, `#!/bin/sh\nexec /bin/echo "$@"\n`);
        rmSync(marker, { recursive: true, force: true });
        if (world.marker === "empty") writeFileSync(marker, "");
        else if (world.marker === "junk") writeFileSync(marker, world.junk);
        else if (world.marker === "directory") mkdirSync(marker);

        const decision = isManagedInstall(classifyRoot(home));
        // Одно решение, и то же самое при повторе: маршрут читают и апдейтер, и мост.
        assert.equal(isManagedInstall(classifyRoot(home)), decision);
        // Метка есть - чекаут разработчика; чем бы она ни была заполнена.
        assert.equal(decision, world.marker === "none");
        // A version is an installation whatever the checkout above it is marked with.
        assert.equal(isManagedInstall(classifyRoot(version)), true);
      },
    ),
    { seed: ROUTE_SEED, numRuns: 40 },
  );
});

test("install.sh creates and refreshes only its own shim", (t) => {
  const home = installation(t);
  const dataDir = join(home, "state with spaces");
  const nextDataDir = join(home, "next state");
  writeFileSync(join(home, ".env"), "ASSISTANT_DATA_DIR=state with spaces\n");
  const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
  const block =
    /\nnode --input-type=module -e '\n([\s\S]*?)\n' "\$PROJECT_DIR" "\$HOME\/\.local\/bin\/iva"\n/u.exec(
      installer,
    );
  assert.ok(block, "the installer no longer calls the shared shim generator");

  // The installer's own lines, run as the installer runs them: an installation
  // that never had a `current` to lose gets the same resolution rules as one the
  // bridge converted, or a lost symlink means two different behaviours.
  const target = join(home, ".local/bin/iva");
  mkdirSync(dirname(target), { recursive: true });
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", block[1], home, target],
    { cwd: ROOT },
  );
  assert.equal(
    readFileSync(target, "utf8"),
    shimScript(home, process.execPath, dataDir),
  );

  writeFileSync(join(home, ".env"), "ASSISTANT_DATA_DIR=next state\n");
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", block[1], home, target],
    { cwd: ROOT },
  );
  assert.equal(
    readFileSync(target, "utf8"),
    shimScript(home, process.execPath, nextDataDir),
  );

  const foreign = Buffer.from("#!/bin/sh\necho foreign\n");
  writeFileSync(target, foreign);
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", block[1], home, target],
    { cwd: ROOT },
  );
  assert.deepEqual(readFileSync(target), foreign);
});
