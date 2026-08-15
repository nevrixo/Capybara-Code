// A genuinely in-workspace file, so a test can tell "rejected the traversal" apart
// from "rejected the whole patch". §12.5 stages atomically: if any file in the patch is
// refused, none of it applies — including this one.
export const value = 1;
