# symlink-escape

The symlink itself is **not committed**. Git cannot portably record a link to an
absolute host path, and a relative link committed here would point somewhere different
on every machine — which would make the test assert nothing.

The test creates it, per `manifest.json`'s `createSymlinks` entry:

```ts
// inside the test's temp copy of this directory
await symlink(outsideAbsolutePath, join(workspace, "escape-link"));
```

## What must happen

`fs.read` on `escape-link/anything` resolves the link, sees a target outside the
canonical workspace root, and fails with `PATH_OUTSIDE_WORKSPACE` (§14.2 step 6,
AC-12).

The distinction that matters: the *link* is inside the workspace, so a check that only
validated the path as written would pass it. The guard has to resolve the link and
re-check the target, and on Windows it also has to handle junctions and reparse points,
which is why §14.2 lists them separately.

## In-workspace control

`inside.txt` is a real file in this directory. A test should confirm it reads
successfully, so a failure on `escape-link` is attributable to the link rather than to
the fixture directory being unreadable.
