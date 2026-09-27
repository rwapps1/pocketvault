// holidays.js — Holidays mini app (not built yet)
//
// mount(root, ctx) runs each time Holidays is opened:
//   root      — the element holding holidays.html's layout
//   ctx.open  — resolves once signed in and past the fingerprint lock
// Return a function to tidy up when leaving (e.g. stop Firestore live
// updates), so nothing keeps running in the background.

export function mount(root, { open }) {
  open.then(() => {
    // Holidays app code goes here.
  });
  return () => {};
}
