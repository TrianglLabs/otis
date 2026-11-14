// happy-dom runs animation frames back to back as immediates, so a looping animation, such as the
// cube loader's, would starve every test while it shows. Browsers pace frames at the display's
// rate; tests get the same, about 60 a second. Fake timers replace these as usual.
if (typeof window !== "undefined") {
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  })
}
